"""Parse a Mobile Suica / PASMO PDF statement into trips.json + trips_preview.md.

Usage:
    python parse_suica.py <PDF_PATH> [--year YYYY] [--out trips.json] [--preview trips_preview.md]

If --year is omitted, the year is auto-detected from the PDF filename
(pattern `_YYYY....._YYYY......._` — the second YYYY is the statement end date)
or falls back to the current year.

Only train trips (入 <station> 出 <station>) are emitted as trips.
Charges (ｶｰﾄﾞ / モバイル), purchases (物販), and zero-amount same-station rows
are skipped but counted in a summary.

Output trip schema:
    {"date": "YYYY/MM/DD", "weekday": "<日本語>", "from": "<駅>", "to": "<駅>", "amount": <int>}

Tested against the format produced by `pdfplumber`/`pypdf` on standard Mobile Suica
PDFs (one transaction per line, signed amount glued to MM, balance glued to DD).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    print("ERROR: pypdf not installed. Run: pip install pypdf", file=sys.stderr)
    sys.exit(2)


# Each row: <signed amount with optional thousands ,><MM> <middle> \<balance><DD>
ROW_RE = re.compile(r"^([+\-]?[\d,]+)(\d{2})\s+(.+?)\s+\\([\d,]+)(\d{2})$")

# Middle for train trips: 入 <from> 出 <to>   — stations may contain 地, ＊, full-width space, ケ etc.
TRIP_RE = re.compile(r"^(?:＊)?入\s+(\S+)\s+出\s+(\S+)$")

# Filename pattern: `..._YYYYMMDD_YYYYMMDDhhmmss.pdf` — second date is end-of-period.
FILENAME_YEAR_RE = re.compile(r"_(\d{4})\d{4}_(\d{4})\d{10}")

WEEKDAYS_JP = ["月", "火", "水", "木", "金", "土", "日"]


def detect_year(pdf_path: Path, override: int | None) -> int:
    if override:
        return override
    m = FILENAME_YEAR_RE.search(pdf_path.name)
    if m:
        return int(m.group(2))
    return _dt.date.today().year


def extract_lines(pdf_path: Path) -> list[str]:
    reader = PdfReader(str(pdf_path))
    lines: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        for raw in text.splitlines():
            line = raw.strip()
            if line:
                lines.append(line)
    return lines


def parse(lines: list[str], year: int) -> tuple[list[dict], dict]:
    trips: list[dict] = []
    stats = {"trips": 0, "charges": 0, "purchases": 0, "zero_or_other": 0, "unmatched": 0}

    for line in lines:
        m = ROW_RE.match(line)
        if not m:
            continue
        amount_s, mm_s, middle, _balance, dd_s = m.groups()
        try:
            amount = int(amount_s.replace(",", ""))
            month = int(mm_s)
            day = int(dd_s)
        except ValueError:
            stats["unmatched"] += 1
            continue

        # Classify middle
        trip = TRIP_RE.match(middle)
        if trip:
            frm, to = trip.group(1), trip.group(2)
            # Skip same-station 0-yen taps
            if amount == 0 or frm == to:
                stats["zero_or_other"] += 1
                continue
            try:
                d = _dt.date(year, month, day)
            except ValueError:
                stats["unmatched"] += 1
                continue
            trips.append({
                "date": d.strftime("%Y/%m/%d"),
                "weekday": WEEKDAYS_JP[d.weekday()],
                "from": frm,
                "to": to,
                "amount": abs(amount),
            })
            stats["trips"] += 1
        elif "物販" in middle:
            stats["purchases"] += 1
        elif "ｶｰﾄﾞ" in middle or "モバイル" in middle or "ﾁｬｰｼﾞ" in middle:
            stats["charges"] += 1
        else:
            stats["zero_or_other"] += 1

    # PDF lists newest-first → reverse to chronological
    trips.reverse()
    return trips, stats


def render_preview(trips: list[dict]) -> str:
    total = sum(t["amount"] for t in trips)
    lines = [
        f"# Suica trips — {len(trips)} records, total ¥{total:,}",
        "",
        "| # | Date | Weekday | From | To | Amount |",
        "|---|---|---|---|---|---|",
    ]
    for i, t in enumerate(trips, 1):
        lines.append(f"| {i} | {t['date']} | {t['weekday']} | {t['from']} | {t['to']} | {t['amount']:,} |")
    lines += ["", f"**Total: ¥{total:,}**", ""]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf", type=Path, help="Path to Suica PDF")
    ap.add_argument("--year", type=int, default=None, help="Override year (auto-detected otherwise)")
    ap.add_argument("--out", type=Path, default=Path("trips.json"))
    ap.add_argument("--preview", type=Path, default=Path("trips_preview.md"))
    args = ap.parse_args()

    if not args.pdf.exists():
        print(f"ERROR: PDF not found: {args.pdf}", file=sys.stderr)
        return 1

    year = detect_year(args.pdf, args.year)
    lines = extract_lines(args.pdf)
    trips, stats = parse(lines, year)

    args.out.write_text(json.dumps(trips, ensure_ascii=False, indent=2), encoding="utf-8")
    args.preview.write_text(render_preview(trips), encoding="utf-8")

    total = sum(t["amount"] for t in trips)
    print(f"Year: {year}")
    print(f"Trips:      {stats['trips']}")
    print(f"Charges:    {stats['charges']}  (skipped)")
    print(f"Purchases:  {stats['purchases']}  (skipped)")
    print(f"Zero/other: {stats['zero_or_other']}  (skipped)")
    print(f"Unmatched:  {stats['unmatched']}")
    print(f"Total: ¥{total:,}")
    print(f"Wrote {args.out} and {args.preview}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
