#!/usr/bin/env python3
"""Pure anomaly detection rules for kintai/schedule/OT data.
Zero external dependencies. NO I/O, NO AI calls.

Each detect_* function takes structured data and returns a list of Anomaly dicts:
  {class: str, severity: str, date: str, summary: str, context: dict}

Run `python anomaly_rules.py` to execute inline asserts (unit tests).
"""
import sys
from datetime import datetime, timezone, timedelta, date, time as dtime

_PREFIX = "[rules]"
JST = timezone(timedelta(hours=9))


def _log(msg):
    print(f"{_PREFIX} {msg}", file=sys.stderr)


# ═══════════════════════════════════════════════════════════
#  A1: Cross-midnight OT without recurring CO skip_dates
# ═══════════════════════════════════════════════════════════

def _is_cross_midnight(ot):
    """Check if an OT request crosses midnight (end time <= start time or end_date != start_date)."""
    start = ot.get("start", "")
    end = ot.get("end", "")
    if not start or not end:
        return False
    try:
        sh, sm = int(start.split(":")[0]), int(start.split(":")[1])
        eh, em = int(end.split(":")[0]), int(end.split(":")[1])
    except (ValueError, IndexError):
        return False
    # Cross-midnight if end time < start time (e.g. 22:00 -> 03:30)
    if eh < sh or (eh == sh and em < sm):
        return True
    # Also check explicit end_date field if present
    if ot.get("end_date") and ot.get("date") and ot["end_date"] != ot["date"]:
        return True
    return False


def _find_recurring_co_entries(schedule_entries):
    """Find all recurring checkout entries."""
    results = []
    for entry in schedule_entries:
        if entry.get("type") in ("daily", "weekly", "recurring", "weekdays"):
            wf = entry.get("workflow", "")
            if "checkout" in wf.lower():
                results.append(entry)
    return results


def detect_a1_cross_midnight_ot_unprotected(ot_requests, schedule_entries):
    """Detect OT requests that cross midnight but recurring CO doesn't skip that date.

    Returns anomalies with severity=critical.
    """
    anomalies = []
    recurring_cos = _find_recurring_co_entries(schedule_entries)

    for ot in ot_requests:
        if not _is_cross_midnight(ot):
            continue
        ot_date = ot.get("date", "")
        if not ot_date:
            continue

        # Check if any recurring CO has this date in skip_dates
        protected = False
        for co_entry in recurring_cos:
            skip_dates = co_entry.get("skip_dates", [])
            if ot_date in skip_dates:
                protected = True
                break

        if not protected:
            anomalies.append({
                "class": "A1",
                "severity": "critical",
                "date": ot_date,
                "summary": (
                    f"OT {ot.get('start','?')}→{ot.get('end','?')} on {ot_date} crosses midnight "
                    f"but recurring CO 18:00 has NOT skipped this date. OT hours will be LOST."
                ),
                "context": {"ot_id": ot.get("id"), "ot_start": ot.get("start"),
                            "ot_end": ot.get("end"), "recurring_cos": len(recurring_cos)},
            })

    return anomalies


# ═══════════════════════════════════════════════════════════
#  A2: Missing checkout (past workday with CI but no CO)
# ═══════════════════════════════════════════════════════════

def detect_a2_missing_checkout(dakoku_records, today_jst=None):
    """Detect workdays with startWorkingTime but no endWorkingTime, before today.

    dakoku_records: list of {date: 'YYYY-MM-DD', startWorkingTime: str|None, endWorkingTime: str|None}
    """
    if today_jst is None:
        today_jst = datetime.now(JST).date()
    elif isinstance(today_jst, datetime):
        today_jst = today_jst.date()

    anomalies = []
    for rec in dakoku_records:
        rec_date_str = rec.get("date", "")
        if not rec_date_str:
            continue
        try:
            rec_date = date.fromisoformat(rec_date_str)
        except ValueError:
            continue

        # Skip today (still in progress)
        if rec_date >= today_jst:
            continue

        has_ci = bool(rec.get("startWorkingTime"))
        has_co = bool(rec.get("endWorkingTime"))

        if has_ci and not has_co:
            anomalies.append({
                "class": "A2",
                "severity": "high",
                "date": rec_date_str,
                "summary": f"Workday {rec_date_str} has checkin but NO checkout record.",
                "context": {"startWorkingTime": rec.get("startWorkingTime")},
            })

    return anomalies


# ═══════════════════════════════════════════════════════════
#  A3: CO before OT end (OT hours lost)
# ═══════════════════════════════════════════════════════════

def _time_to_minutes(t_str):
    """Parse 'HH:MM' to minutes since midnight. Returns None on failure."""
    if not t_str:
        return None
    try:
        parts = t_str.strip().split(":")
        return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, IndexError):
        return None


def _extract_time_from_datetime(dt_str):
    """Extract HH:MM from various datetime formats. Returns minutes since midnight."""
    if not dt_str:
        return None
    # Try ISO format like '2026-05-20T18:00:00+09:00' or '2026-05-20 18:00'
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M", "%H:%M:%S", "%H:%M"):
        try:
            dt = datetime.strptime(dt_str.strip(), fmt)
            return dt.hour * 60 + dt.minute
        except ValueError:
            continue
    # Fallback: try direct HH:MM extraction
    return _time_to_minutes(dt_str)


def detect_a3_co_before_ot_end(dakoku_records, ot_requests):
    """Detect days where endWorkingTime < OT end time (Rule 2 violation already happened).

    For cross-midnight OT: CO should be >= OT end time (next day).
    For same-day OT: CO should be >= OT end time.
    """
    anomalies = []

    # Index OT requests by date
    ot_by_date = {}
    for ot in ot_requests:
        d = ot.get("date", "")
        if d:
            ot_by_date.setdefault(d, []).append(ot)

    for rec in dakoku_records:
        rec_date = rec.get("date", "")
        if rec_date not in ot_by_date:
            continue

        co_time_str = rec.get("endWorkingTime") or rec.get("displayEndWorkingTime")
        if not co_time_str:
            continue  # No CO yet — A2 handles this

        co_minutes = _extract_time_from_datetime(co_time_str)
        if co_minutes is None:
            continue

        for ot in ot_by_date[rec_date]:
            ot_end = ot.get("end", "")
            ot_end_minutes = _time_to_minutes(ot_end)
            if ot_end_minutes is None:
                continue

            is_cross_midnight = _is_cross_midnight(ot)

            if is_cross_midnight:
                # For cross-midnight OT (e.g. 22:00→03:30), CO on the workday
                # should NOT happen before OT start (killing the session).
                # If CO is before OT start time, OT is lost.
                ot_start_minutes = _time_to_minutes(ot.get("start", ""))
                if ot_start_minutes is not None and co_minutes < ot_start_minutes:
                    anomalies.append({
                        "class": "A3",
                        "severity": "critical",
                        "date": rec_date,
                        "summary": (
                            f"CO at {co_time_str} but OT {ot.get('start')}→{ot_end} "
                            f"(cross-midnight) on {rec_date}. Session closed BEFORE OT started → hours LOST."
                        ),
                        "context": {"co_time": co_time_str, "ot_start": ot.get("start"),
                                    "ot_end": ot_end, "cross_midnight": True},
                    })
            else:
                # Same-day OT: CO should be >= OT end
                if co_minutes < ot_end_minutes:
                    anomalies.append({
                        "class": "A3",
                        "severity": "critical",
                        "date": rec_date,
                        "summary": (
                            f"CO at {co_time_str} but OT ends at {ot_end} on {rec_date}. "
                            f"Session closed BEFORE OT ended → partial/full hours LOST."
                        ),
                        "context": {"co_time": co_time_str, "ot_end": ot_end,
                                    "cross_midnight": False},
                    })

    return anomalies


# ═══════════════════════════════════════════════════════════
#  A5: Undispatched once entries (dispatcher missed)
# ═══════════════════════════════════════════════════════════

def detect_a5_undispatched_once(schedule_entries, now_jst=None):
    """Detect once-type entries that are past due > 1 hour but not dispatched."""
    if now_jst is None:
        now_jst = datetime.now(JST)
    elif not isinstance(now_jst, datetime):
        now_jst = datetime.combine(now_jst, dtime(12, 0), tzinfo=JST)

    anomalies = []
    threshold = now_jst - timedelta(hours=1)

    for entry in schedule_entries:
        if entry.get("type") != "once":
            continue
        if entry.get("dispatched"):
            continue

        run_at_str = entry.get("run_at") or entry.get("datetime", "")
        if not run_at_str:
            continue

        try:
            # Parse ISO datetime
            if "+" in run_at_str or run_at_str.endswith("Z"):
                run_at = datetime.fromisoformat(run_at_str.replace("Z", "+00:00"))
            else:
                run_at = datetime.fromisoformat(run_at_str).replace(tzinfo=JST)
            run_at = run_at.astimezone(JST)
        except ValueError:
            continue

        if run_at < threshold:
            anomalies.append({
                "class": "A5",
                "severity": "medium",
                "date": run_at.strftime("%Y-%m-%d"),
                "summary": (
                    f"Schedule entry '{entry.get('workflow', '?')}' was due at "
                    f"{run_at.strftime('%Y-%m-%d %H:%M')} but never dispatched. "
                    f"Dispatcher may have missed it."
                ),
                "context": {"entry_id": entry.get("id"), "workflow": entry.get("workflow"),
                            "run_at": run_at_str},
            })

    return anomalies


# ═══════════════════════════════════════════════════════════
#  A7: Azure token expiring soon
# ═══════════════════════════════════════════════════════════

def detect_a7_azure_token_expiring(token_expires_at, now_jst=None):
    """Detect if Azure refresh token expires within 14 days.

    token_expires_at: datetime (tz-aware) or None.
    """
    if token_expires_at is None:
        return []

    if now_jst is None:
        now_jst = datetime.now(JST)
    elif not isinstance(now_jst, datetime):
        now_jst = datetime.combine(now_jst, dtime(7, 0), tzinfo=JST)

    remaining = token_expires_at - now_jst
    if remaining < timedelta(days=14):
        days_left = max(0, remaining.days)
        anomalies = [{
            "class": "A7",
            "severity": "medium",
            "date": now_jst.strftime("%Y-%m-%d"),
            "summary": (
                f"Azure refresh token expires in ~{days_left} days. "
                f"Re-authenticate soon to avoid checkin/checkout failures."
            ),
            "context": {"expires_at": token_expires_at.isoformat(), "days_left": days_left},
        }]
        return anomalies
    return []


# ═══════════════════════════════════════════════════════════
#  ORCHESTRATOR
# ═══════════════════════════════════════════════════════════

def run_all(context):
    """Run all detection rules against a context dict.

    Expected context keys:
      - dakoku_records: list of {date, startWorkingTime, endWorkingTime, ...}
      - ot_requests: list of {id, date, start, end, ...}
      - schedule_entries: list of Gist entries
      - token_expires_at: datetime or None
      - now_jst: datetime (optional, for testing)
    """
    now_jst = context.get("now_jst")
    results = []

    ot_requests = context.get("ot_requests", [])
    schedule_entries = context.get("schedule_entries", [])
    dakoku_records = context.get("dakoku_records", [])
    token_expires_at = context.get("token_expires_at")

    results.extend(detect_a1_cross_midnight_ot_unprotected(ot_requests, schedule_entries))
    results.extend(detect_a2_missing_checkout(dakoku_records, now_jst))
    results.extend(detect_a3_co_before_ot_end(dakoku_records, ot_requests))
    results.extend(detect_a5_undispatched_once(schedule_entries, now_jst))
    results.extend(detect_a7_azure_token_expiring(token_expires_at, now_jst))

    _log(f"run_all complete: {len(results)} anomalies found")
    return results


# ═══════════════════════════════════════════════════════════
#  INLINE TESTS (run with `python anomaly_rules.py`)
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("Running inline tests...")

    # ── A1 tests ──
    # OT 22:00→03:30 with no skip → should detect
    ot1 = [{"id": "ot1", "date": "2026-05-20", "start": "22:00", "end": "03:30"}]
    sched1 = [{"type": "weekly", "workflow": "auto-checkout.yml", "time": "18:00",
               "days": [1, 2, 3, 4, 5], "skip_dates": []}]
    r = detect_a1_cross_midnight_ot_unprotected(ot1, sched1)
    assert len(r) == 1 and r[0]["class"] == "A1", f"A1 test 1 failed: {r}"

    # OT 22:00→03:30 WITH skip → should NOT detect
    sched2 = [{"type": "weekly", "workflow": "auto-checkout.yml", "time": "18:00",
               "days": [1, 2, 3, 4, 5], "skip_dates": ["2026-05-20"]}]
    r = detect_a1_cross_midnight_ot_unprotected(ot1, sched2)
    assert len(r) == 0, f"A1 test 2 failed: {r}"

    # Same-day OT (not cross-midnight) → should NOT detect
    ot_same = [{"id": "ot2", "date": "2026-05-20", "start": "18:00", "end": "21:00"}]
    r = detect_a1_cross_midnight_ot_unprotected(ot_same, sched1)
    assert len(r) == 0, f"A1 test 3 failed: {r}"

    # ── A2 tests ──
    today = date(2026, 5, 21)
    dk1 = [
        {"date": "2026-05-20", "startWorkingTime": "09:00", "endWorkingTime": None},
        {"date": "2026-05-19", "startWorkingTime": "09:00", "endWorkingTime": "18:00"},
        {"date": "2026-05-21", "startWorkingTime": "09:00", "endWorkingTime": None},  # today, skip
    ]
    r = detect_a2_missing_checkout(dk1, today)
    assert len(r) == 1 and r[0]["date"] == "2026-05-20", f"A2 test failed: {r}"

    # ── A3 tests ──
    # CO at 18:00 but OT starts at 22:00 cross-midnight → lost
    dk3 = [{"date": "2026-05-20", "startWorkingTime": "09:00", "endWorkingTime": "18:00"}]
    ot3 = [{"id": "ot3", "date": "2026-05-20", "start": "22:00", "end": "03:30"}]
    r = detect_a3_co_before_ot_end(dk3, ot3)
    assert len(r) == 1 and r[0]["class"] == "A3", f"A3 test 1 failed: {r}"

    # CO at 21:00, same-day OT ends 22:00 → lost
    dk4 = [{"date": "2026-05-20", "startWorkingTime": "09:00", "endWorkingTime": "21:00"}]
    ot4 = [{"id": "ot4", "date": "2026-05-20", "start": "18:00", "end": "22:00"}]
    r = detect_a3_co_before_ot_end(dk4, ot4)
    assert len(r) == 1 and r[0]["class"] == "A3", f"A3 test 2 failed: {r}"

    # CO at 23:00, same-day OT ends 22:00 → OK
    dk5 = [{"date": "2026-05-20", "startWorkingTime": "09:00", "endWorkingTime": "23:00"}]
    r = detect_a3_co_before_ot_end(dk5, ot4)
    assert len(r) == 0, f"A3 test 3 failed: {r}"

    # ── A5 tests ──
    now_a5 = datetime(2026, 5, 21, 10, 0, tzinfo=JST)
    sched5 = [
        {"type": "once", "dispatched": False, "run_at": "2026-05-21T08:00:00+09:00",
         "workflow": "auto-checkin.yml", "id": "s1"},
        {"type": "once", "dispatched": True, "run_at": "2026-05-20T09:00:00+09:00",
         "workflow": "auto-checkin.yml", "id": "s2"},
        {"type": "once", "dispatched": False, "run_at": "2026-05-21T09:30:00+09:00",
         "workflow": "auto-checkout.yml", "id": "s3"},  # only 30min ago, not >1h
    ]
    r = detect_a5_undispatched_once(sched5, now_a5)
    assert len(r) == 1 and r[0]["context"]["entry_id"] == "s1", f"A5 test failed: {r}"

    # ── A7 tests ──
    now_a7 = datetime(2026, 5, 21, 7, 0, tzinfo=JST)
    exp_soon = datetime(2026, 5, 30, 7, 0, tzinfo=JST)  # 9 days → alert
    r = detect_a7_azure_token_expiring(exp_soon, now_a7)
    assert len(r) == 1 and r[0]["class"] == "A7", f"A7 test 1 failed: {r}"

    exp_far = datetime(2026, 7, 1, 7, 0, tzinfo=JST)  # 41 days → no alert
    r = detect_a7_azure_token_expiring(exp_far, now_a7)
    assert len(r) == 0, f"A7 test 2 failed: {r}"

    # ── run_all test ──
    ctx = {
        "dakoku_records": dk1,
        "ot_requests": ot1,
        "schedule_entries": sched1,
        "token_expires_at": exp_soon,
        "now_jst": datetime(2026, 5, 21, 10, 0, tzinfo=JST),
    }
    r = run_all(ctx)
    assert len(r) >= 2, f"run_all test failed (expected >=2 anomalies): {r}"

    print(f"✅ All {10} inline tests passed!")
