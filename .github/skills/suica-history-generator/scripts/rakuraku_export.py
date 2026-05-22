"""Phase 4.1 — Rakuraku export.

Converts a MonthlyHistory directly into the trips.json format consumed by
the rakuraku-suica-expense skill (Playwright-driven Rakuraku Seisan
auto-filing). This skips the PDF→parse round-trip entirely: we have all
the trip data already in MonthlyHistory.

Output format (per rakuraku-suica-expense/scripts/parse_suica.py):
    [
      {"date": "YYYY/MM/DD", "weekday": "月|火|水|木|金|土|日",
       "from": "<駅>", "to": "<駅>", "amount": <int>},
      ...
    ]

Only train trips (IN→OUT pairs with fare>0) are emitted.
オートチャージ, 物販, and ¥0 transfers are skipped (mirrors parse_suica behavior).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .models import MonthlyHistory, TapKind

log = logging.getLogger(__name__)

WEEKDAYS_JP = ["月", "火", "水", "木", "金", "土", "日"]


def history_to_trips(history: MonthlyHistory) -> list[dict]:
    """Convert MonthlyHistory.entries into rakuraku trips.json schema."""
    trips: list[dict] = []
    pending_in = None
    for e in history.entries:
        if e.kind == TapKind.IN:
            pending_in = e
            continue
        if e.kind == TapKind.OUT and pending_in is not None:
            if e.fare_yen > 0 and pending_in.station != e.station:
                d = e.at.date()
                trips.append({
                    "date":    d.strftime("%Y/%m/%d"),
                    "weekday": WEEKDAYS_JP[d.weekday()],
                    "from":    pending_in.station,
                    "to":      e.station,
                    "amount":  e.fare_yen,
                })
            pending_in = None
    return trips


def write_trips_json(history: MonthlyHistory, path: Path) -> dict:
    trips = history_to_trips(history)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(trips, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(t["amount"] for t in trips)
    log.info("Wrote %d Rakuraku trips (¥%s) → %s", len(trips), f"{total:,}", path)
    return {"count": len(trips), "total_yen": total, "path": str(path)}


if __name__ == "__main__":
    import argparse, datetime as dt

    p = argparse.ArgumentParser(description="Export MonthlyHistory JSON to rakuraku trips.json")
    p.add_argument("history_json", type=Path, help="MonthlyHistory JSON")
    p.add_argument("--out", type=Path, default=Path("trips.json"))
    args = p.parse_args()

    raw = json.load(open(args.history_json, encoding="utf-8"))
    for e in raw.get("entries", []):
        if isinstance(e.get("at"), str):
            e["at"] = dt.datetime.fromisoformat(e["at"])
    hist = MonthlyHistory(**raw)
    stats = write_trips_json(hist, args.out)
    print(f"trips={stats['count']}  total=¥{stats['total_yen']:,}  out={stats['path']}")
