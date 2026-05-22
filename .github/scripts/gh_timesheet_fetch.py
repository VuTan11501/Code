#!/usr/bin/env python3
"""GitHub Actions — Timesheet Fetch.

Pulls the monthly timesheet detail from DokoKin for the current month +
N-1 trailing months, normalizes per-day rows, and stores them in the Gist
file `timesheet-history.json` for the PWA "Timesheet" tab to consume.

Why this exists:
  After every checkin/checkout, the user wants to verify that the
  ACTUAL recognized working time matches the OT REQUEST hours. Any gap
  ⇒ "lost OT yen" because the payslip pays the lesser of the two.
  This script feeds the dashboard with the data needed to flag those gaps.

Inputs (env):
  AZURE_REFRESH_TOKEN   required
  GH_PAT                required
  MONTHS_KEEP           optional, default 6 (rolling window)
  ACCOUNT               optional, default "tanvc"

Stdlib only.
"""
import os, sys, json, urllib.request, traceback
from datetime import datetime

# Reuse helpers from gh_ot_creator
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh_ot_creator import (  # type: ignore
    JST, API_BASE, GIST_ID, ACCOUNT as DEFAULT_ACCOUNT,
    log, refresh_azure_token, get_kintai_token, api_headers,
)
from gist_safety import (  # type: ignore
    read_gist_file, safe_patch_gist_file,
    GistSafetyError, RaceDetected,
)

TIMESHEET_GIST_FILE = "timesheet-history.json"


def fetch_timesheet_month(token: str, account: str, year: int, month: int) -> dict | None:
    """GET /api/timesheet/{account}/{year}/{month}."""
    url = f"{API_BASE}timesheet/{account}/{year}/{month}"
    req = urllib.request.Request(url, headers=api_headers(token), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read() or b"{}")
        if not isinstance(data, dict):
            return None
        return data
    except Exception as e:
        log(f"  ⚠ {year}-{month:02d} timesheet fetch failed: {e}")
        return None


def _date_str(iso_dt) -> str:
    if not iso_dt:
        return ""
    if isinstance(iso_dt, str):
        try:
            return datetime.fromisoformat(iso_dt.replace("Z", "+00:00")).strftime("%Y-%m-%d")
        except Exception:
            return iso_dt[:10] if len(iso_dt) >= 10 else ""
    return ""


def _hours_to_hhmm(h) -> str:
    """Format float hours like 1.5 → '01:30'. Returns '' for None/0."""
    if h is None:
        return ""
    try:
        f = float(h)
    except Exception:
        return ""
    if f == 0:
        return ""
    sign = "-" if f < 0 else ""
    a = abs(f)
    hh = int(a)
    mm = int(round((a - hh) * 60))
    if mm == 60:
        hh += 1
        mm = 0
    return f"{sign}{hh:02d}:{mm:02d}"


def _slim_detail(d: dict) -> dict:
    """Keep only fields the dashboard renders. Cuts payload ~90%."""
    # OT request: API only returns numeric `otRequestTime` at detail level.
    ot_req_num = d.get("otRequestTime") or 0
    ot_req_mid_num = d.get("otRequestTimeMidNight") or 0
    # Actual midnight OT recognized (numeric — needed to compute night-premium loss)
    actual_mid_num = d.get("weekdayLateNightOvertime") or 0
    return {
        "date":           _date_str(d.get("workingDate") or d.get("partTimeWorkingDate")),
        "dow":            d.get("dayOfWeek") or "",
        "in":             d.get("displayStartWorkingTime") or "",
        "out":            d.get("displayEndWorkingTime") or "",
        "break":          d.get("displayTotalOfBreakTime") or "",
        "workingHours":   d.get("displayTotalWorkingTime") or "",
        "actualWorking":  d.get("displayActualWorkingTime") or "",
        "gap":            d.get("displayWorkingTimeGap") or "",
        "lackWorking":    d.get("displayWeekdayNoWorkingTime") or "",
        "otNormal":       d.get("displayWeekdayNormalOvertime") or "",
        "otMidnight":     d.get("displayWeekdayLateNightOvertime") or "",
        "otSat":          d.get("displayHolidaysWorkingTime") or "",
        "otSun":          d.get("displaySundayWorkingTime") or "",
        "otRequest":      _hours_to_hhmm(ot_req_num),
        "otRequestNum":   ot_req_num,
        "otRequestMidNum": ot_req_mid_num,
        "actualMidNum":   actual_mid_num,
        "specialLeave":   d.get("displaySpecialLeavesTime") or "",
        "leave":          d.get("displayTotalLeaveTime") or "",
        "isHoliday":      bool(d.get("isFjpHoliday")),
        "isSaturday":     bool(d.get("isSaturday")),
        "isSunday":       bool(d.get("isSunday")),
        "isWorking":      bool(d.get("isCalculated")),
        "hasUnapprovedOT": bool(d.get("hasUnapprovedOTRequest")),
        "description":    d.get("description") or "",
    }


def normalize_month(raw: dict) -> dict:
    """Build month snapshot {summary, details}."""
    details_raw = raw.get("details") or []
    details = [_slim_detail(x) for x in details_raw if isinstance(x, dict)]
    summary = {
        "displayStandardWorkingHour":    raw.get("displayStandardWorkingHour") or "",
        "displayTotalWorkingHours":      raw.get("displayTotalWorkingHours") or "",
        "displayTotalActualWorkingTime": raw.get("displayTotalActualWorkingTime") or "",
        "displayTotalWorkingTimeGap":    raw.get("displayTotalWorkingTimeGap") or "",
        "displayWeekdayNoWorkingTime":   raw.get("displayWeekdayNoWorkingTime") or "",
        "displayOTRequestHours":         raw.get("displayOTRequestHours") or "",
        "displayWeekdayNormalOvertime":  raw.get("displayWeekdayNormalOvertime") or "",
        "displayWeekdayLateNightOvertime": raw.get("displayWeekdayLateNightOvertime") or "",
        "displayHolidaysWorkingTime":    raw.get("displayHolidaysWorkingTime") or "",
        "displaySundayWorkingTime":      raw.get("displaySundayWorkingTime") or "",
        "displayOvertimeHours":          raw.get("displayOvertimeHours") or "",
        "displayNightWorkingHours":      raw.get("displayNightWorkingHours") or "",
        "displaySpecialLeavesHours":     raw.get("displaySpecialLeavesHours") or "",
        "displayAnnualLeaveHours":       raw.get("displayAnnualLeaveHours") or "",
        "displaySubstituteHolidayHours": raw.get("displaySubstituteHolidayHours") or "",
        "displayHolidayOvertimeHours":   raw.get("displayHolidayOvertimeHours") or "",
        "displaySundayOvertimeHours":    raw.get("displaySundayOvertimeHours") or "",
        "overtimeHours":                 raw.get("overtimeHours"),
        "nightWorkingHours":             raw.get("nightWorkingHours"),
        "holidayOvertimeHours":          raw.get("holidayOvertimeHours"),
        "sundayOvertimeHours":           raw.get("sundayOvertimeHours"),
        "oTRequestHours":                raw.get("oTRequestHours"),
        "noWorkingTimeHours":            raw.get("noWorkingTimeHours"),
        "totalWorkingHours":             raw.get("totalWorkingHours"),
        "standardWorkingHours":          raw.get("standardWorkingHours"),
        "status":                        raw.get("status"),
        "statusDisplay":                 raw.get("statusDisplay"),
    }
    return {
        "fetched_at": datetime.now(JST).isoformat(timespec="seconds"),
        "summary": summary,
        "details": details,
    }


def _months_back(now: datetime, count: int):
    """Return list of (year, month) from oldest → newest, length=count (inclusive of current)."""
    y, m = now.year, now.month
    out = []
    for _ in range(count):
        out.append((y, m))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    out.reverse()
    return out


def _emit_token_rotation(new_refresh: str):
    print(f"::add-mask::{new_refresh}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("token_rotated=true\n")
            f.write(f"new_refresh_token={new_refresh}\n")
    log("⚠️ Azure refresh token rotated — written to GITHUB_OUTPUT")


def main():
    now = datetime.now(JST)
    # Default 24 months (2 years) — matches the PWA's Sync DokoKin button.
    # The workflow itself defaults to 120 (10 years) for cron runs, so the
    # only path that hits this fallback is an env-less local run.
    months_keep = max(1, int(os.environ.get("MONTHS_KEEP", "24")))
    account = (os.environ.get("ACCOUNT") or DEFAULT_ACCOUNT).strip()
    log(f"Timesheet Fetch — account={account}, keeping {months_keep} months "
        f"ending {now:%Y-%m}")

    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        raise RuntimeError("AZURE_REFRESH_TOKEN not set")
    pat = os.environ.get("GH_PAT")
    if not pat:
        raise RuntimeError("GH_PAT not set (needed to PATCH Gist)")

    log("Refreshing Azure → KINTAI token…")
    az_tok, new_refresh = refresh_azure_token(refresh_token)
    kt = get_kintai_token(az_tok)
    log("Token OK ✓")

    # ─── DEBUG MODE: dump raw current-month payload and exit ───
    if os.environ.get("DEBUG_DUMP", "").lower() in ("1", "true", "yes"):
        log("⚠ DEBUG_DUMP=1 — fetching current month raw and printing, then exit (no Gist write)")
        raw = fetch_timesheet_month(kt, account, now.year, now.month)
        if not raw:
            log("  · no data")
            return
        log("── MONTH ROOT KEYS ──")
        log(repr(sorted(raw.keys())))
        log("── MONTH timesheetAdjust ──")
        log(json.dumps(raw.get("timesheetAdjust"), indent=2, ensure_ascii=False)[:2000])
        details = raw.get("details") or []
        log(f"── DETAILS COUNT: {len(details)} ──")
        # Find a day with checkin AND known OT to maximize useful keys
        sample = None
        for d in details:
            if isinstance(d, dict) and (d.get("displayStartWorkingTime") or d.get("startWorkingTime")):
                sample = d
                break
        if not sample and details:
            sample = details[0]
        if sample:
            log("── FULL RAW DETAIL (first day with checkin) ──")
            log(json.dumps(sample, indent=2, ensure_ascii=False, default=str))
        if new_refresh != refresh_token:
            _emit_token_rotation(new_refresh)
        return

    targets = _months_back(now, months_keep)
    fetched: dict[str, dict] = {}
    for (y, m) in targets:
        raw = fetch_timesheet_month(kt, account, y, m)
        if not raw:
            log(f"  · {y}-{m:02d}: skipped (no data / fetch error)")
            continue
        snap = normalize_month(raw)
        # Skip empty calendar shells (months before user joined FJP).
        # Heuristic: no actual working time AND no OT request AND no checkins.
        s = snap["summary"]
        actual = (s.get("displayTotalActualWorkingTime") or "00:00").strip()
        otreq  = (s.get("displayOTRequestHours") or "00:00").strip()
        has_checkin = any(d.get("in") for d in snap["details"])
        if actual in ("", "00:00") and otreq in ("", "00:00") and not has_checkin:
            log(f"  · {y}-{m:02d}: empty (pre-FJP or no activity) — skipped")
            continue
        key = f"{y}-{m:02d}"
        fetched[key] = snap
        log(f"  ✓ {key}: {len(snap['details'])} days, "
            f"actual={s.get('displayTotalActualWorkingTime')}, "
            f"OT={s.get('displayOvertimeHours')}, "
            f"OTreq={s.get('displayOTRequestHours')}")

    if not fetched:
        log("Nothing fetched — aborting (no write).")
        if new_refresh != refresh_token:
            _emit_token_rotation(new_refresh)
        return

    log("Reading existing Gist file…")
    snapshot = read_gist_file(pat, GIST_ID, TIMESHEET_GIST_FILE, log=log)
    existing = snapshot.get("parsed")
    if not isinstance(existing, dict) or "months" not in existing:
        existing = {"months": {}, "account": account}

    months_obj = existing.get("months") or {}
    if not isinstance(months_obj, dict):
        months_obj = {}

    # Overwrite fetched keys (newer data wins), keep other keys untouched
    for k, v in fetched.items():
        months_obj[k] = v

    # Prune to last `months_keep` keys (rolling window)
    sorted_keys = sorted(months_obj.keys())
    pruned = sorted_keys[-months_keep:]
    if len(sorted_keys) > months_keep:
        log(f"Pruning {len(sorted_keys) - months_keep} old months: "
            f"{sorted_keys[:-months_keep]}")
    new_months = {k: months_obj[k] for k in pruned}

    new_payload = {
        "account": account,
        "updated_at": datetime.now(JST).isoformat(timespec="seconds"),
        "months_keep": months_keep,
        "months": new_months,
    }
    new_content = json.dumps(new_payload, indent=2, ensure_ascii=False)

    # Shape validator: gist_safety passes the already-parsed object (not raw string).
    def _shape_ok(parsed):
        if not isinstance(parsed, dict) or "months" not in parsed:
            raise ValueError("missing 'months' key")

    log("PATCHing Gist (with rolling backup + race detection)…")
    try:
        st = safe_patch_gist_file(
            pat, GIST_ID, TIMESHEET_GIST_FILE,
            new_content=new_content,
            snapshot=snapshot,
            shape_validator=_shape_ok,
            log=log,
        )
        log(f"Gist PATCH HTTP {st} ✓ ({len(new_months)} months total)")
    except RaceDetected as e:
        log(str(e))
        log("⛔ Aborting — will retry on next scheduled run.")
        sys.exit(3)
    except GistSafetyError as e:
        log(f"⛔ Safety check failed: {e}")
        sys.exit(2)

    if new_refresh != refresh_token:
        _emit_token_rotation(new_refresh)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"❌ {e}")
        traceback.print_exc()
        sys.exit(1)
