#!/usr/bin/env python3
"""Build docs/data/kanto_stations.json from HeartRails Express API.

Fetches every station in the 7 Kanto prefectures (Tokyo/Kanagawa/Saitama/
Chiba/Ibaraki/Tochigi/Gunma), dedupes across lines, converts kana to
Hepburn romaji via pykakasi, and writes the result for the Suica trip
planner to consume in-browser.

Run locally (or in CI) to refresh; HeartRails has no auth and no key.

Usage:
    pip install pykakasi
    python scripts/build_kanto_stations.py
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

API = "http://express.heartrails.com/api/json"
PREFS = ["東京都", "神奈川県", "埼玉県", "千葉県", "茨城県", "栃木県", "群馬県"]

OUT = Path(__file__).resolve().parents[1] / "docs" / "data" / "kanto_stations.json"

# (No longer needed: switched to post-processing instead of pre-processing.)
_KANJI = r"\u4e00-\u9fff"
_GA_RX = re.compile(f"([{_KANJI}])[ヶケ]([{_KANJI}])")  # kept for possible future use


def get_json(url: str, retries: int = 3) -> dict:
    for i in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "fjp-suica-builder/1.0"})
            with urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            if i == retries - 1:
                raise
            print(f"  retry {i+1}: {e}", file=sys.stderr)
            time.sleep(1.5 * (i + 1))


def get_lines(pref: str) -> list[str]:
    j = get_json(f"{API}?method=getLines&prefecture={quote(pref)}")
    return j.get("response", {}).get("line", []) or []


def get_stations(line: str) -> list[dict]:
    j = get_json(f"{API}?method=getStations&line={quote(line)}")
    return j.get("response", {}).get("station", []) or []


# pykakasi mis-reads bare "ヶ"/"ケ" between kanji as "ke" instead of the
# place-name reading "ga" (e.g. 阿佐ケ谷 = asagaya, 千駄ヶ谷 = sendagaya,
# 霞ヶ関 = kasumigaseki). We post-process the romaji output: the substrings
# below never occur in legitimate Japanese station romaji, so blanket-
# replacing them only fixes the ヶ/ケ mis-reads (and the trailing 谷 in
# this compound is always read "ya" not "tani"). Common matches in Kanto:
#   阿佐ヶ谷, 千駄ヶ谷, 鎌ヶ谷, 市ヶ谷, 雑司ヶ谷, 鳩ヶ谷, 幡ヶ谷, 祖師ヶ谷 (→ gaya)
#   梅ヶ丘, ひばりヶ丘, 百合ヶ丘, 桜ヶ丘, 富士見ヶ丘, 鶴ヶ島 (→ gaoka / gashima)
#   稲村ヶ崎, 鰭ヶ崎, 姉ケ崎, 龍ケ崎 (→ gasaki)
#   西ヶ原, 霞ヶ関, 由比ヶ浜, 鐘ヶ淵, 恋ヶ窪, 袖ケ浦 (→ gahara / gaseki / etc.)
_ROMAJI_GA_FIXES = [
    ("ketani",   "gaya"),
    ("keoka",    "gaoka"),
    ("kesaki",   "gasaki"),
    ("kehama",   "gahama"),
    ("kehara",   "gahara"),
    ("keseki",   "gaseki"),
    ("kefuchi",  "gafuchi"),
    ("kekubo",   "gakubo"),
    ("keura",    "gaura"),
    ("keshima",  "gashima"),
    ("ketake",   "gatake"),
    ("kemine",   "gamine"),
    ("kenuma",   "ganuma"),
    ("keike",    "gaike"),
]


def _fix_ga(rom: str) -> str:
    for a, b in _ROMAJI_GA_FIXES:
        rom = rom.replace(a, b)
    return rom


def romaji(kks, text: str) -> str:
    parts = kks.convert(text)
    out = "".join(p["hepburn"] for p in parts).lower().replace(" ", "")
    return _fix_ga(out)


def romaji_simple(rom: str) -> str:
    """Collapse Hepburn long-vowel digraphs to the common ASCII spelling.

    'toukyou' -> 'tokyo', 'shimbashi' stays, 'chuuou' -> 'chuo', 'koushien' ->
    'koshien', etc. Matches how most English speakers actually type a station
    name (Wikipedia titles, JR signage in Latin alphabet).
    """
    # ou/oo/oh -> o, uu -> u  (applied repeatedly so 'kouchou' -> 'kocho')
    out = rom
    for a, b in (("ou", "o"), ("oo", "o"), ("uu", "u")):
        while a in out:
            out = out.replace(a, b)
    return out


def main() -> int:
    kks = pykakasi.kakasi()
    by_key: dict[tuple[str, str], dict] = {}  # (name, prefecture) → entry

    for pref in PREFS:
        print(f"[{pref}] fetching lines…", file=sys.stderr)
        lines = get_lines(pref)
        print(f"  {len(lines)} lines", file=sys.stderr)
        for line in lines:
            try:
                stations = get_stations(line)
            except Exception as e:
                print(f"  ! skip {line}: {e}", file=sys.stderr)
                continue
            for s in stations:
                name = (s.get("name") or "").strip()
                if not name:
                    continue
                if s.get("prefecture") != pref:
                    continue
                key = (name, pref)
                lat = float(s["y"]) if s.get("y") else None
                lon = float(s["x"]) if s.get("x") else None
                rom = romaji(kks, name)
                rom_simple = romaji_simple(rom)
                # Primary romaji uses the common ASCII spelling (no long vowels);
                # full Hepburn lives in alt[] so users typing "toukyou" still match.
                alt = [rom] if rom != rom_simple else []
                entry = by_key.setdefault(key, {
                    "name": name,
                    "kana": "",
                    "romaji": rom_simple,
                    "alt": alt,
                    "lat": lat,
                    "lon": lon,
                    "pref": pref,
                    "lines": [],
                })
                if line not in entry["lines"]:
                    entry["lines"].append(line)
                if entry["lat"] is None and lat is not None:
                    entry["lat"], entry["lon"] = lat, lon

    stations = sorted(by_key.values(), key=lambda x: x["name"])

    name_counts: dict[str, int] = {}
    for s in stations:
        name_counts[s["name"]] = name_counts.get(s["name"], 0) + 1

    out = {
        "_meta": {
            "description": (
                "Auto-built Kanto station catalogue. Source: HeartRails Express "
                "(http://express.heartrails.com/) — public, no auth. "
                "Romaji generated via pykakasi (Hepburn). Rebuild with: "
                "python scripts/build_kanto_stations.py."
            ),
            "source": "HeartRails Express getLines+getStations",
            "prefectures": PREFS,
            "romaji_scheme": "Hepburn (pykakasi)",
            "convention": "{name, kana, romaji, lat, lon, pref, lines:[]}",
        },
        "stations": stations,
        "ambiguous": {n: c for n, c in name_counts.items() if c > 1},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {OUT} — {len(stations)} stations, "
          f"{len(out['ambiguous'])} ambiguous names", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
