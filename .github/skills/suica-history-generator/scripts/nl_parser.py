"""nl_parser.py — Natural language → GeneratorConfig + CLI args.

Provides two front-ends:

1. **Heuristic parser** (default, no API key): regex-based extractor that
   handles common Vietnamese + Japanese phrasings. Robust for the dozen
   most common patterns the user actually uses; fast and offline.

2. **Gemini parser** (--llm): forwards the request to Gemini 1.5 Flash
   for richer parsing. Requires GEMINI_API_KEY env var. The Gemini call
   uses a strict JSON-schema response so the output is always machine-
   parseable.

Both produce a `ParsedRequest` dict the same shape, which can be merged
onto a preset and fed to generate.py.

Schema of `ParsedRequest`:
    {
      "month":     "YYYY-MM",         // required
      "target":    25000,             // required, JPY
      "routes":    [                  // optional weekday/commute routes
        {"route": "東京↔新宿", "type": "commute"}
      ],
      "leisure":   [                  // optional weekend / occasional
        {"route": "東京↔横浜", "count": 2}
      ],
      "seed":      42,                // optional reproducibility
      "notes":     "..."              // free-text comment from user request
    }

CLI:
    python -m scripts.nl_parser "tháng 5 đi Tokyo↔Shinjuku mỗi ngày, 25k, weekend 2 lần Yokohama"
    python -m scripts.nl_parser --llm "..."     # use Gemini
    python -m scripts.nl_parser "..." --as-cmd  # print equivalent generate.py command
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import sys
from typing import Any

log = logging.getLogger("nl_parser")

GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-1.5-flash-latest:generateContent"
)
ENV_KEY = "GEMINI_API_KEY"

# Mapping for common romaji / Vietnamese names → kanji we can route on.
ROMAJI_TO_KANJI = {
    "tokyo": "東京", "shinjuku": "新宿", "shibuya": "渋谷", "yokohama": "横浜",
    "shinagawa": "品川", "ueno": "上野", "ikebukuro": "池袋", "akihabara": "秋葉原",
    "kawasaki": "川崎", "omiya": "大宮", "chiba": "千葉", "tachikawa": "立川",
    "machida": "町田", "kichijoji": "吉祥寺", "nakano": "中野", "ofuna": "大船",
    "yotsuya": "四ツ谷", "shimbashi": "新橋", "kanda": "神田", "ebisu": "恵比寿",
    "meguro": "目黒", "gotanda": "五反田", "tamachi": "田町", "hamamatsucho": "浜松町",
    "otemachi": "大手町", "roppongi": "六本木", "azabu": "麻布", "ginza": "銀座",
}

WEEKDAY_HINTS = ("hàng ngày", "mỗi ngày", "weekday", "mỗi buổi", "đi làm", "通勤", "毎日")
WEEKEND_HINTS = ("cuối tuần", "weekend", "thứ 7", "chủ nhật", "週末", "土日")


def _normalize_station(name: str) -> str:
    """Map romaji → kanji if possible; otherwise return cleaned input."""
    key = name.strip().lower()
    if key in ROMAJI_TO_KANJI:
        return ROMAJI_TO_KANJI[key]
    return name.strip()


# ----------------------------------------------------------------------
# Heuristic parser
# ----------------------------------------------------------------------

# Accept both ASCII <->/<>,  Japanese ↔, and "—/–/-/→/->" as direction separators.
# IMPORTANT: do NOT include letter-based separators ("to", "đi") here — they
# collide with case-insensitive matching of names like "Tokyo".
ROUTE_SEP = r"(?:↔|<->|<>|⇔|—|–|→|->|-)"
ROUTE_RE = re.compile(
    r"([A-Za-zぁ-んァ-ヶ一-龯]{2,})\s*" + ROUTE_SEP + r"\s*([A-Za-zぁ-んァ-ヶ一-龯]{2,})",
    re.IGNORECASE,
)
# Numbers: greedy plain digits OR comma-grouped. Plain alt is first because
# we want "25000" to match as a whole rather than backtracking to "250".
TARGET_RE = re.compile(
    r"(\d+(?:,\d{3})+|\d+)\s*(k|nghìn|ngàn|千|万|man|yên|yen|円|¥|jpy)?",
    re.IGNORECASE,
)
MONTH_RE = re.compile(
    r"(?:tháng\s*)?(\d{1,2})(?:\s*/\s*(\d{4}))?|"
    r"(\d{4})[-/](\d{1,2})"
)
SEED_RE = re.compile(r"seed[=: ]+(\d+)", re.IGNORECASE)
COUNT_RE = re.compile(r"(\d+)\s*(?:lần|chuyến|times|回|trip)", re.IGNORECASE)


def _parse_target(text: str) -> int | None:
    """Find an amount like '25k', '25,000', '2万円' in the text."""
    # Match every number+suffix, pick the largest after suffix expansion
    candidates: list[int] = []
    for m in TARGET_RE.finditer(text):
        raw = m.group(1).replace(",", "").replace(".", "")
        try:
            n = int(raw)
        except ValueError:
            continue
        suffix = (m.group(2) or "").lower()
        if suffix in ("k", "nghìn", "ngàn", "千"):
            n *= 1000
        elif suffix in ("万", "man"):
            n *= 10000
        # Filter out things that look like dates or seeds
        if 1_000 <= n <= 1_000_000:
            candidates.append(n)
    return max(candidates) if candidates else None


def _parse_month(text: str, today: dt.date | None = None) -> str | None:
    today = today or dt.date.today()
    for m in MONTH_RE.finditer(text):
        if m.group(3) and m.group(4):
            yyyy, mm = int(m.group(3)), int(m.group(4))
        elif m.group(1):
            mm = int(m.group(1))
            yyyy = int(m.group(2)) if m.group(2) else today.year
            # If 'tháng' month is in the past more than 6 months, assume next year
            if mm < 1 or mm > 12:
                continue
        else:
            continue
        return f"{yyyy:04d}-{mm:02d}"
    return None


def parse_heuristic(text: str, today: dt.date | None = None) -> dict[str, Any]:
    """Best-effort NL parse without external services."""
    target = _parse_target(text)
    month = _parse_month(text, today)
    seed_m = SEED_RE.search(text)
    seed = int(seed_m.group(1)) if seed_m else None

    routes: list[dict[str, str]] = []
    leisure: list[dict[str, Any]] = []

    # Look for "A↔B" patterns. Classify by the closest cue in either direction:
    # scan ±40 chars around the match and pick the cue (weekday vs weekend)
    # whose distance to the match is smallest. This handles both
    # trailing ("Tokyo↔Yokohama cuối tuần") and leading
    # ("cuối tuần Tokyo↔Yokohama") phrasing.
    for m in ROUTE_RE.finditer(text):
        a = _normalize_station(m.group(1))
        b = _normalize_station(m.group(2))
        if a == b:
            continue
        route = f"{a}↔{b}"
        win = 40
        before = text[max(0, m.start() - win):m.start()].lower()
        after = text[m.end():m.end() + win].lower()

        def _closest(hints: tuple[str, ...]) -> int:
            best = 10**9
            for h in hints:
                # Distance backward = chars between cue end and match start
                idx = before.rfind(h)
                if idx != -1:
                    d = len(before) - (idx + len(h))
                    best = min(best, d)
                # Distance forward = chars from match end to cue start
                idx = after.find(h)
                if idx != -1:
                    best = min(best, idx)
            return best

        d_wd = _closest(WEEKDAY_HINTS)
        d_we = _closest(WEEKEND_HINTS)
        is_leisure = d_we < d_wd
        if is_leisure:
            count = 1
            cm = COUNT_RE.search(after)
            if cm:
                count = max(1, int(cm.group(1)))
            leisure.append({"route": route, "count": count})
        else:
            routes.append({"route": route, "type": "commute"})

    return {
        "month": month,
        "target": target,
        "routes": routes,
        "leisure": leisure,
        "seed": seed,
        "notes": text.strip(),
    }


# ----------------------------------------------------------------------
# Gemini parser
# ----------------------------------------------------------------------

GEMINI_SYSTEM_INSTRUCTION = """You parse Vietnamese/Japanese/English requests for generating a Suica train history into a strict JSON config. Output ONLY a single JSON object that matches the schema. Do not include commentary.

Schema:
{
  "month":   "YYYY-MM",                            // required
  "target":  <int yen>,                            // required, expand 25k -> 25000, 2万 -> 20000
  "routes":  [{"route":"A↔B","type":"commute"}],  // weekday/commute routes, use ↔ separator and kanji station names if possible
  "leisure": [{"route":"A↔B","count":<int>}],     // weekend/occasional trips
  "seed":    <int|null>,                           // null if not specified
  "notes":   "<verbatim user request>"
}

Common station romaji→kanji: Tokyo→東京, Shinjuku→新宿, Shibuya→渋谷, Yokohama→横浜, Shinagawa→品川, Ueno→上野, Ikebukuro→池袋, Akihabara→秋葉原, Ginza→銀座, Roppongi→六本木. If unknown, keep as-is.
"""


def parse_llm(text: str, api_key: str | None = None) -> dict[str, Any]:
    import requests

    api_key = api_key or os.environ.get(ENV_KEY)
    if not api_key:
        raise RuntimeError(f"{ENV_KEY} not set")

    body = {
        "system_instruction": {"parts": [{"text": GEMINI_SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.0,
        },
    }
    resp = requests.post(GEMINI_ENDPOINT, params={"key": api_key}, json=body, timeout=20)
    resp.raise_for_status()
    data = resp.json()
    try:
        text_out = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini response shape: {e}: {data}") from e
    return json.loads(text_out)


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def to_cli_command(parsed: dict[str, Any], config_path: str = "data/presets/tokyo-commuter.json",
                   out_path: str = "out/history.json") -> str:
    parts = [
        "python -m scripts.generate",
        f"--config {config_path}",
        f"--month {parsed['month']}",
        f"--target {parsed['target']}",
    ]
    if parsed.get("seed") is not None:
        parts.append(f"--seed {parsed['seed']}")
    parts.append(f"--out {out_path}")
    return " \\\n    ".join(parts)


def merge_into_preset(parsed: dict[str, Any], preset: dict[str, Any]) -> dict[str, Any]:
    """Return a new preset with routes/leisure overridden by NL parse."""
    out = dict(preset)
    if parsed.get("routes"):
        # WeeklySlot schema: {route, type}
        out["weekly"] = [
            {"route": r["route"], "type": r.get("type", "commute")}
            for r in parsed["routes"]
        ]
    if parsed.get("leisure"):
        out["leisure_pool"] = [
            {"route": r["route"], "weight": max(1, int(r.get("count", 1)))}
            for r in parsed["leisure"]
        ]
    return out


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Parse a NL request into a generator config.")
    p.add_argument("request", nargs="+", help="The natural-language request")
    p.add_argument("--llm", action="store_true",
                   help=f"Use Gemini (requires {ENV_KEY})")
    p.add_argument("--as-cmd", action="store_true", help="Also print the equivalent CLI command")
    p.add_argument("--out", type=str, default=None,
                   help="Write parsed JSON to this path (default: stdout)")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")
    text = " ".join(args.request).strip()
    if not text:
        log.error("Empty request")
        return 2

    try:
        parsed = parse_llm(text) if args.llm else parse_heuristic(text)
    except Exception as e:
        log.error("Parse failed: %s", e)
        return 2

    payload = json.dumps(parsed, ensure_ascii=False, indent=2)
    if args.out:
        from pathlib import Path
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(payload, encoding="utf-8")
        log.info("Wrote %s", args.out)
    else:
        print(payload)

    if args.as_cmd:
        if not (parsed.get("month") and parsed.get("target")):
            log.warning("Cannot build CLI command: missing month or target")
            return 1
        print("\n# Equivalent CLI:")
        print(to_cli_command(parsed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
