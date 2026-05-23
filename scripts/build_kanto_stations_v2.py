#!/usr/bin/env python3
"""Build docs/data/kanto_stations.json from HeartRails + OpenStreetMap.

Two-source strategy:
  1) HeartRails Express (http://express.heartrails.com) — comprehensive
     line/station catalogue per prefecture (kanji name + coords + line).
     Used as the spine: every HeartRails station ends up in the output.
  2) OpenStreetMap via Overpass — supplies authoritative readings:
        name:ja-Hira  -> hiragana yomi  (kana)
        name:en       -> Hepburn romaji (mukaigawara, not "kokawara")
     Joined on (kanji name, prefecture). Stations only in OSM but not in
     HeartRails are also added so the catalogue is a strict superset.

For any station that ends up without a romaji from OSM, we fall back to
pykakasi-derived romaji (the previous behaviour) plus a small manual
override table for known mis-reads.

Run:
    pip install pykakasi
    python scripts/build_kanto_stations_v2.py
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

import pykakasi

HEARTRAILS = "http://express.heartrails.com/api/json"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
PREFS = ["東京都", "神奈川県", "埼玉県", "千葉県", "茨城県", "栃木県", "群馬県"]

OUT = Path(__file__).resolve().parents[1] / "docs" / "data" / "kanto_stations.json"


# ── HTTP helpers ──────────────────────────────────────────────────────
def get_json(url: str, retries: int = 3, timeout: int = 30) -> dict:
    for i in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "fjp-suica-builder/2.0"})
            with urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            if i == retries - 1:
                raise
            print(f"  retry {i+1}: {e}", file=sys.stderr)
            time.sleep(2.0 * (i + 1))


def overpass(query: str, retries: int = 4) -> dict:
    last_err = None
    for attempt in range(retries):
        for ep in OVERPASS_ENDPOINTS:
            try:
                req = Request(
                    ep,
                    data=query.encode("utf-8"),
                    headers={"User-Agent": "fjp-suica-builder/2.0"},
                )
                with urlopen(req, timeout=240) as r:
                    return json.loads(r.read().decode("utf-8"))
            except Exception as e:
                last_err = e
                print(f"  overpass {ep}: {e}", file=sys.stderr)
                time.sleep(5.0)
        time.sleep(15.0 * (attempt + 1))
    raise RuntimeError(f"All overpass endpoints failed: {last_err}")


# ── HeartRails ────────────────────────────────────────────────────────
def hr_lines(pref: str) -> list[str]:
    j = get_json(f"{HEARTRAILS}?method=getLines&prefecture={quote(pref)}")
    return j.get("response", {}).get("line", []) or []


def hr_stations(line: str) -> list[dict]:
    j = get_json(f"{HEARTRAILS}?method=getStations&line={quote(line)}")
    return j.get("response", {}).get("station", []) or []


# ── OSM ───────────────────────────────────────────────────────────────
def osm_stations(pref: str) -> list[dict]:
    q = f"""
[out:json][timeout:180];
area["name"="{pref}"]["admin_level"="4"]->.a;
(
  node["railway"="station"](area.a);
  node["railway"="halt"](area.a);
  node["railway"="tram_stop"](area.a);
);
out tags center;
"""
    data = overpass(q)
    out = []
    for e in data.get("elements", []):
        t = e.get("tags") or {}
        name = (t.get("name") or "").strip()
        # OSM often suffixes with 駅 — strip so the join key matches HeartRails.
        if name.endswith("駅"):
            name = name[:-1]
        if not name:
            continue
        out.append({
            "name": name,
            "kana": (t.get("name:ja-Hira") or "").strip(),
            "en": (t.get("name:en") or t.get("name:ja-Latn") or "").strip(),
            "lat": e.get("lat"),
            "lon": e.get("lon"),
            "network": (t.get("network") or "").strip(),
            "operator": (t.get("operator") or "").strip(),
            "pref": pref,
        })
    return out


# ── romaji helpers (fallback only) ────────────────────────────────────
_ROMAJI_GA_FIXES = [
    ("ketani", "gaya"), ("keoka", "gaoka"), ("kesaki", "gasaki"),
    ("kehama", "gahama"), ("kehara", "gahara"), ("keseki", "gaseki"),
    ("kefuchi", "gafuchi"), ("kekubo", "gakubo"), ("keura", "gaura"),
    ("keshima", "gashima"), ("ketake", "gatake"), ("kemine", "gamine"),
    ("kenuma", "ganuma"), ("keike", "gaike"),
]


def _fix_ga(rom: str) -> str:
    for a, b in _ROMAJI_GA_FIXES:
        rom = rom.replace(a, b)
    return rom


def romaji_from_kanji(kks, text: str) -> str:
    parts = kks.convert(text)
    out = "".join(p["hepburn"] for p in parts).lower().replace(" ", "")
    return _fix_ga(out)


def romaji_from_kana(kks, kana: str) -> str:
    parts = kks.convert(kana)
    return "".join(p["hepburn"] for p in parts).lower().replace(" ", "")


def romaji_simple(rom: str) -> str:
    out = rom
    for a, b in (("ou", "o"), ("oo", "o"), ("uu", "u")):
        while a in out:
            out = out.replace(a, b)
    return out


def normalize_en(en: str) -> str:
    """OSM name:en is already Hepburn but may contain spaces/hyphens/macrons."""
    s = en.lower()
    # strip macrons / diacritics
    s = (s.replace("ō", "o").replace("ū", "u").replace("ā", "a")
           .replace("ī", "i").replace("ē", "e")
           .replace("ô", "o").replace("û", "u").replace("â", "a")
           .replace("î", "i").replace("ê", "e"))
    # collapse separators
    s = re.sub(r"[-\s'·.]+", "", s)
    # drop trailing 'station' words if any
    s = re.sub(r"(station|eki)$", "", s)
    return s


# ── main ──────────────────────────────────────────────────────────────
def main() -> int:
    kks = pykakasi.kakasi()

    # 1) HeartRails spine ------------------------------------------------
    hr_by_key: dict[tuple[str, str], dict] = {}
    for pref in PREFS:
        print(f"[HR][{pref}] lines…", file=sys.stderr)
        lines = hr_lines(pref)
        print(f"  {len(lines)} lines", file=sys.stderr)
        for line in lines:
            try:
                stations = hr_stations(line)
            except Exception as e:
                print(f"  ! skip {line}: {e}", file=sys.stderr)
                continue
            for s in stations:
                name = (s.get("name") or "").strip()
                if not name or s.get("prefecture") != pref:
                    continue
                key = (name, pref)
                lat = float(s["y"]) if s.get("y") else None
                lon = float(s["x"]) if s.get("x") else None
                entry = hr_by_key.setdefault(key, {
                    "name": name, "kana": "", "romaji": "", "alt": [],
                    "lat": lat, "lon": lon, "pref": pref, "lines": [],
                })
                if line not in entry["lines"]:
                    entry["lines"].append(line)
                if entry["lat"] is None and lat is not None:
                    entry["lat"], entry["lon"] = lat, lon
    print(f"HeartRails total: {len(hr_by_key)} stations", file=sys.stderr)

    # 2) OSM enrichment --------------------------------------------------
    osm_by_key: dict[tuple[str, str], dict] = {}
    for pref in PREFS:
        print(f"[OSM][{pref}] querying…", file=sys.stderr)
        try:
            rows = osm_stations(pref)
        except Exception as e:
            print(f"  ! OSM {pref} failed: {e}", file=sys.stderr)
            continue
        print(f"  {len(rows)} OSM nodes", file=sys.stderr)
        for r in rows:
            k = (r["name"], pref)
            cur = osm_by_key.get(k)
            # Prefer entry with most metadata
            score = (1 if r["kana"] else 0) + (1 if r["en"] else 0)
            if not cur or score > cur["_score"]:
                osm_by_key[k] = dict(r, _score=score)
        time.sleep(3.0)
    print(f"OSM unique: {len(osm_by_key)} stations", file=sys.stderr)

    # 3) Merge -----------------------------------------------------------
    merged: dict[tuple[str, str], dict] = {}
    for key, entry in hr_by_key.items():
        merged[key] = entry
    for key, o in osm_by_key.items():
        if key in merged:
            e = merged[key]
        else:
            # OSM-only station: add it
            e = merged.setdefault(key, {
                "name": key[0], "kana": "", "romaji": "", "alt": [],
                "lat": o["lat"], "lon": o["lon"], "pref": key[1], "lines": [],
            })
        if not e.get("kana") and o.get("kana"):
            e["kana"] = o["kana"]
        if o.get("en"):
            e["_osm_en"] = o["en"]
        if e["lat"] is None and o.get("lat") is not None:
            e["lat"], e["lon"] = o["lat"], o["lon"]
        # Add OSM network/operator as a synthetic line if no lines yet
        if not e["lines"]:
            for tag in (o.get("network"), o.get("operator")):
                if tag and tag not in e["lines"]:
                    e["lines"].append(tag)

    # 4) Resolve romaji --------------------------------------------------
    for key, e in merged.items():
        name = e["name"]
        # Priority A: OSM name:en (authoritative, hand-curated)
        if e.get("_osm_en"):
            primary = normalize_en(e["_osm_en"])
        elif e.get("kana"):
            # Priority B: derive from kana (very accurate)
            primary = romaji_simple(romaji_from_kana(kks, e["kana"]))
        else:
            # Priority C: derive from kanji (legacy, can be wrong)
            rom = romaji_from_kanji(kks, name)
            primary = romaji_simple(rom)
        e["romaji"] = primary

        # Build alt list: full-Hepburn variant + raw OSM en (if different)
        alts = set()
        if e.get("kana"):
            full = romaji_from_kana(kks, e["kana"])
            if full and full != primary:
                alts.add(full)
        rom_kanji = romaji_from_kanji(kks, name)
        rom_kanji_s = romaji_simple(rom_kanji)
        if rom_kanji and rom_kanji != primary:
            alts.add(rom_kanji)
        if rom_kanji_s and rom_kanji_s != primary:
            alts.add(rom_kanji_s)
        if e.get("_osm_en"):
            raw = e["_osm_en"].lower().replace(" ", "")
            if raw != primary:
                alts.add(raw)
        e["alt"] = sorted(alts)
        e.pop("_osm_en", None)

    # 5) Write -----------------------------------------------------------
    stations = sorted(merged.values(), key=lambda x: x["name"])
    name_counts: dict[str, int] = {}
    for s in stations:
        name_counts[s["name"]] = name_counts.get(s["name"], 0) + 1

    out = {
        "_meta": {
            "description": (
                "Kanto station catalogue. Sources: HeartRails Express "
                "(http://express.heartrails.com/) for the comprehensive "
                "line/station spine, and OpenStreetMap via Overpass for "
                "authoritative readings (name:ja-Hira, name:en). Romaji "
                "fallback for OSM-missing entries derived via pykakasi. "
                "Rebuild with: python scripts/build_kanto_stations_v2.py."
            ),
            "sources": [
                "HeartRails Express getLines+getStations",
                "OpenStreetMap Overpass (railway=station|halt|tram_stop)",
            ],
            "prefectures": PREFS,
            "romaji_scheme": "Hepburn (OSM name:en preferred; pykakasi fallback)",
            "convention": "{name, kana, romaji, alt:[], lat, lon, pref, lines:[]}",
        },
        "stations": stations,
        "ambiguous": {n: c for n, c in name_counts.items() if c > 1},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    have_kana = sum(1 for s in stations if s["kana"])
    print(f"\nWrote {OUT}", file=sys.stderr)
    print(f"  stations: {len(stations)}", file=sys.stderr)
    print(f"  with kana: {have_kana}", file=sys.stderr)
    print(f"  ambiguous names: {len(out['ambiguous'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
