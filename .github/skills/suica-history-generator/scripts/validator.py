"""Phase 3.1 — Validator rules engine.

Runs a battery of sanity checks against a MonthlyHistory to catch issues
that would make the generated history look fake (negative balance,
overlapping IN/OUT, fare mismatch, too many trips per day, last-train issues,
unresolved stations).

Each issue has a severity (error / warning / info). The validator returns a
ValidationReport which the CLI / pipeline can print and gate on errors.
"""
from __future__ import annotations

import datetime as dt
from collections import defaultdict
from enum import Enum
from typing import Iterable

from pydantic import BaseModel

from .models import MonthlyHistory, TapEntry, TapKind


class Severity(str, Enum):
    ERROR   = "error"
    WARNING = "warning"
    INFO    = "info"


class Issue(BaseModel):
    severity: Severity
    rule:     str
    message:  str
    at:       dt.datetime | None = None


class ValidationReport(BaseModel):
    issues: list[Issue] = []

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == Severity.ERROR]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == Severity.WARNING]

    @property
    def ok(self) -> bool:
        return not self.errors

    def add(self, severity: Severity, rule: str, message: str,
            at: dt.datetime | None = None) -> None:
        self.issues.append(Issue(severity=severity, rule=rule, message=message, at=at))

    def summary(self) -> str:
        lines = [
            "=== Validation report ===",
            f"  Errors:   {len(self.errors)}",
            f"  Warnings: {len(self.warnings)}",
            f"  Info:     {len([i for i in self.issues if i.severity == Severity.INFO])}",
        ]
        for i in self.issues:
            tag = i.severity.value.upper()
            loc = f" @{i.at.isoformat(timespec='minutes')}" if i.at else ""
            lines.append(f"  [{tag}] {i.rule}{loc}: {i.message}")
        return "\n".join(lines)


# ----------------------------------------------------------------------
# Individual rule functions
# ----------------------------------------------------------------------


def _rule_balance_nonneg(history: MonthlyHistory, r: ValidationReport) -> None:
    """Balance must never go negative."""
    for e in history.entries:
        if e.balance_yen < 0:
            r.add(Severity.ERROR, "balance_nonneg",
                  f"Balance went negative: ¥{e.balance_yen} at {e.station}", at=e.at)


def _rule_balance_arithmetic(history: MonthlyHistory, r: ValidationReport) -> None:
    """Each row's balance must equal prev_balance ± delta."""
    prev = history.initial_balance
    for e in history.entries:
        if e.kind == TapKind.IN:
            expected = prev   # IN does not deduct
        elif e.kind == TapKind.OUT:
            expected = prev - e.fare_yen
        elif e.kind == TapKind.AUTO:
            expected = prev + e.fare_yen
        elif e.kind == TapKind.SHOPPING:
            expected = prev - e.fare_yen
        elif e.kind == TapKind.BUS:
            expected = prev - e.fare_yen
        else:
            continue
        if expected != e.balance_yen:
            r.add(Severity.ERROR, "balance_arithmetic",
                  f"{e.kind.value} {e.station}: expected balance ¥{expected}, got ¥{e.balance_yen}",
                  at=e.at)
        prev = e.balance_yen

    if prev != history.final_balance:
        r.add(Severity.ERROR, "final_balance_mismatch",
              f"Final balance ¥{history.final_balance} ≠ last running balance ¥{prev}")


def _rule_in_out_pairing(history: MonthlyHistory, r: ValidationReport) -> None:
    """Every IN must be immediately followed by an OUT (per card session)."""
    state = "idle"
    last_in: TapEntry | None = None
    for e in history.entries:
        if e.kind == TapKind.IN:
            if state == "tapped_in":
                r.add(Severity.ERROR, "in_out_pairing",
                      f"Double IN: previous IN at {last_in.station} {last_in.at.isoformat(timespec='minutes')} not closed by OUT",
                      at=e.at)
            state = "tapped_in"
            last_in = e
        elif e.kind == TapKind.OUT:
            if state != "tapped_in":
                r.add(Severity.ERROR, "in_out_pairing",
                      f"OUT at {e.station} without preceding IN", at=e.at)
            state = "idle"
            last_in = None
        # AUTO / SHOPPING / BUS don't affect state
    if state == "tapped_in" and last_in:
        r.add(Severity.WARNING, "in_out_pairing",
              f"Unclosed IN at {last_in.station} at end of month", at=last_in.at)


def _rule_no_overlap(history: MonthlyHistory, r: ValidationReport) -> None:
    """An IN cannot occur before the previous OUT (single card)."""
    last_out: dt.datetime | None = None
    for e in history.entries:
        if e.kind == TapKind.IN and last_out is not None:
            if e.at < last_out:
                r.add(Severity.ERROR, "no_overlap",
                      f"IN at {e.station} {e.at.isoformat(timespec='minutes')} is before previous OUT at {last_out.isoformat(timespec='minutes')}",
                      at=e.at)
        if e.kind == TapKind.OUT:
            last_out = e.at


def _rule_trip_duration(history: MonthlyHistory, r: ValidationReport) -> None:
    """Trip (IN→OUT) duration should be 5-180 minutes typically."""
    last_in: TapEntry | None = None
    for e in history.entries:
        if e.kind == TapKind.IN:
            last_in = e
        elif e.kind == TapKind.OUT and last_in is not None:
            dur = (e.at - last_in.at).total_seconds() / 60
            if dur < 3:
                r.add(Severity.WARNING, "trip_duration",
                      f"Trip {last_in.station}→{e.station} only {dur:.0f}min (too short)", at=e.at)
            elif dur > 240:
                r.add(Severity.WARNING, "trip_duration",
                      f"Trip {last_in.station}→{e.station} took {dur:.0f}min (>4h)", at=e.at)
            last_in = None


def _rule_trips_per_day(history: MonthlyHistory, r: ValidationReport, max_per_day: int = 6) -> None:
    """A real commuter rarely makes >6 IN/OUT round-trips per day."""
    by_day: dict[dt.date, int] = defaultdict(int)
    for e in history.entries:
        if e.kind == TapKind.IN:
            by_day[e.at.date()] += 1
    for d, n in by_day.items():
        if n > max_per_day:
            r.add(Severity.WARNING, "trips_per_day",
                  f"{d}: {n} trips (>{max_per_day} suspicious)")


def _rule_last_train(history: MonthlyHistory, r: ValidationReport) -> None:
    """No IN after 23:30 (last-train cutoff)."""
    for e in history.entries:
        if e.kind == TapKind.IN and (e.at.hour > 23 or (e.at.hour == 23 and e.at.minute >= 30)):
            r.add(Severity.WARNING, "last_train",
                  f"IN at {e.station} {e.at.strftime('%H:%M')} after last-train cutoff", at=e.at)


def _rule_topup_realism(history: MonthlyHistory, r: ValidationReport) -> None:
    """Auto-topup should be followed by either an IN tap (commute case) or a
    SHOPPING event (purchase that triggers the top-up). Anything else is a
    realism red-flag."""
    entries = history.entries
    for i, e in enumerate(entries):
        if e.kind != TapKind.AUTO:
            continue
        # The next entry should be an IN or SHOPPING within a few seconds
        nxt = entries[i + 1] if i + 1 < len(entries) else None
        if nxt is None or nxt.kind not in (TapKind.IN, TapKind.SHOPPING):
            r.add(Severity.WARNING, "topup_realism",
                  f"オートチャージ at {e.station} not followed by IN/物販", at=e.at)
            continue
        gap = (nxt.at - e.at).total_seconds()
        if abs(gap) > 60:
            r.add(Severity.WARNING, "topup_realism",
                  f"オートチャージ at {e.station} not synced with next IN (gap={gap:.0f}s)", at=e.at)
        # Station match only required for the IN case; SHOPPING uses a merchant
        # label (e.g. "モバイル") which legitimately differs from the topup label.
        if nxt.kind == TapKind.IN and nxt.station != e.station:
            r.add(Severity.WARNING, "topup_realism",
                  f"オートチャージ at {e.station} but next IN at {nxt.station}", at=e.at)


def _rule_unique_stations(history: MonthlyHistory, r: ValidationReport) -> None:
    """All stations must be non-empty strings."""
    for e in history.entries:
        if not e.station or not e.station.strip():
            r.add(Severity.ERROR, "unique_stations",
                  f"Empty station for {e.kind.value} entry at {e.at.isoformat(timespec='minutes')}",
                  at=e.at)


def _rule_chronological(history: MonthlyHistory, r: ValidationReport) -> None:
    """Entries must be sorted by datetime."""
    prev = None
    for e in history.entries:
        if prev is not None and e.at < prev:
            r.add(Severity.ERROR, "chronological",
                  f"Entry at {e.at.isoformat()} comes before {prev.isoformat()}", at=e.at)
        prev = e.at


# ----------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------

ALL_RULES = [
    _rule_chronological,
    _rule_balance_nonneg,
    _rule_balance_arithmetic,
    _rule_in_out_pairing,
    _rule_no_overlap,
    _rule_trip_duration,
    _rule_trips_per_day,
    _rule_last_train,
    _rule_topup_realism,
    _rule_unique_stations,
]


def validate(history: MonthlyHistory,
             rules: Iterable = ALL_RULES) -> ValidationReport:
    """Run all rules and return a ValidationReport."""
    r = ValidationReport()
    for rule in rules:
        rule(history, r)
    return r


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print("Usage: python -m scripts.validator <history.json>")
        sys.exit(1)

    raw = json.load(open(sys.argv[1], encoding="utf-8"))
    # MonthlyHistory expects datetime objects on entries; reconstruct lightly.
    for e in raw.get("entries", []):
        if isinstance(e.get("at"), str):
            e["at"] = dt.datetime.fromisoformat(e["at"])
    hist = MonthlyHistory(**raw)
    report = validate(hist)
    print(report.summary())
    sys.exit(0 if report.ok else 1)
