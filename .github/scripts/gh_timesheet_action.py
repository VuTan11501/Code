#!/usr/bin/env python3
"""GitHub Actions — Timesheet Action (Calculate + Save Draft).

Drives the DokoKin monthly-timesheet "Calculate" (計算) and "Save Draft"
(一時保存) actions for a single month, the way the FJP web client does:

    GET  /api/timesheet/{account}/{year}/{month}   → full month object
    POST /api/timesheet/calculate    body = month object → recalculated object
    POST /api/timesheet/save         body = month object → persists as Draft

⚠️  This is a WRITE path against a real HR system. Design rules (do not relax):
  • We NEVER hand-build the payload — we round-trip the server's OWN object.
  • We only ever Save Draft (status stays 1 = Draft). We do NOT Submit (申請).
  • calc-save saves ONLY if /calculate succeeded and returned a valid object.
  • Hard refuse to touch a month that is already submitted/confirmed/approved
    (status != 1, or isLeaderConfirm / isHrConfirm). FORCE cannot override this.
  • A pre-save anomaly guard blocks save on suspicious data (missing checkout,
    invalid working-place, invalid break). FORCE=1 overrides ONLY this guard.

Inputs (env):
  AZURE_REFRESH_TOKEN   required
  GH_PAT                required (token rotation queue)
  ACTION                calculate | save | calc-save   (default: calc-save)
  YEAR, MONTH           optional — default current JST month
  ACCOUNT               optional — default "tanvc"
  DRY_RUN               "1" → do everything except the final POST /save
  FORCE                 "1" → override the anomaly guard only (NOT status gate)
  SMTP_USER/SMTP_PASS/NOTIFY_EMAIL  for the summary email

Exit codes: 0 ok · 1 error · 2 blocked (anomaly/status guard) · 3 calc failed

Stdlib only.
"""
import os, sys, json, urllib.request, urllib.error, traceback
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh_ot_creator import (  # type: ignore
    JST, API_BASE, ACCOUNT as DEFAULT_ACCOUNT,
    log, LOG_LINES, refresh_azure_token, get_kintai_token,
    api_headers, send_email,
)
from gh_payslip_fetch import get_fjp_token, fjp_headers  # type: ignore

try:
    from user_config import EMPLOYEE_ID, BASE_HOURLY_RATE
except Exception:  # pragma: no cover
    EMPLOYEE_ID = int(os.environ.get("EMPLOYEE_ID", "8883"))
    BASE_HOURLY_RATE = int(os.environ.get("BASE_HOURLY_RATE", "1563"))


# ═══════════════════════════════════════════════════════════
#  HTTP
# ═══════════════════════════════════════════════════════════

def _request(method, url, token, module, body_obj=None, timeout=40):
    """Generic JSON request. Returns (status, parsed_or_text)."""
    data = None
    if body_obj is not None:
        data = json.dumps(body_obj).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers=fjp_headers(token, module), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw or not raw.strip():
                return resp.status, {}
            try:
                return resp.status, json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                return resp.status, {"_raw": raw.decode(errors="replace")}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, {"error": raw}
    except Exception as e:  # network etc.
        return 0, {"error": str(e)}


def fetch_month(kt, fes, account, year, month):
    """GET the full month object. Try FES first (matches the write pipeline,
    the web timesheet page uses FES), fall back to the proven KINTAI path."""
    url = f"{API_BASE}timesheet/{account}/{year}/{month}"
    st, data = _request("GET", url, fes, "FES")
    if st == 200 and isinstance(data, dict) and data.get("details") is not None:
        log(f"  GET month via FES ✓ ({len(data.get('details') or [])} days)")
        return data
    log(f"  GET via FES returned HTTP {st}; falling back to KINTAI")
    # KINTAI fallback uses the KINTAI-scoped token + api_headers
    req = urllib.request.Request(url, headers=api_headers(kt), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read() or b"{}")
        if isinstance(data, dict) and data.get("details") is not None:
            log(f"  GET month via KINTAI ✓ ({len(data.get('details') or [])} days)")
            return data
    except Exception as e:
        log(f"  GET via KINTAI failed: {e}")
    return None


# ═══════════════════════════════════════════════════════════
#  VALIDATION & GUARDS
# ═══════════════════════════════════════════════════════════

def validate_identity(obj, year, month):
    """Make sure the object is the month/account/employee we asked for."""
    errs = []
    if not isinstance(obj, dict):
        return ["not a JSON object"]
    if obj.get("id") in (None, 0):
        errs.append("missing root id")
    if int(obj.get("year") or 0) != year:
        errs.append(f"year mismatch (got {obj.get('year')}, want {year})")
    if int(obj.get("month") or 0) != month:
        errs.append(f"month mismatch (got {obj.get('month')}, want {month})")
    if EMPLOYEE_ID and int(obj.get("employeeId") or 0) != int(EMPLOYEE_ID):
        errs.append(f"employeeId mismatch (got {obj.get('employeeId')})")
    details = obj.get("details")
    if not isinstance(details, list) or not details:
        errs.append("empty/invalid details[]")
    else:
        bad = [d.get("workingDate") for d in details
               if isinstance(d, dict) and str(d.get("month") or month) != str(month)]
        if bad:
            errs.append(f"{len(bad)} detail rows not in month {month}")
    return errs


def status_gate(obj):
    """Hard gate: refuse to write a month that is NOT a plain Draft.
    Returns (ok: bool, reason: str). NOT overridable by FORCE."""
    status = obj.get("status")
    sd = (obj.get("statusDisplay") or "").strip()
    if obj.get("isLeaderConfirm"):
        return False, "leader already confirmed (isLeaderConfirm=true)"
    if obj.get("isHrConfirm"):
        return False, "HR already confirmed (isHrConfirm=true)"
    # status 1 == Draft (verified from a real capture). Treat anything else as
    # already-progressed and refuse. statusDisplay is only diagnostic.
    if status != 1:
        return False, f"status={status} (statusDisplay={sd!r}) is not Draft"
    return True, f"Draft (status=1, statusDisplay={sd!r})"


def _is_past(working_date, today):
    if not working_date or not isinstance(working_date, str):
        return False
    try:
        d = datetime.fromisoformat(working_date.replace("Z", "+00:00")).date()
        return d < today
    except Exception:
        return False


def anomaly_scan(obj):
    """Feature B — pre-save guard. Returns list of {date, kind, detail}.
    Only flags days that actually have attendance, so plain weekends / leave
    days never false-positive."""
    today = datetime.now(JST).date()
    issues = []
    for d in obj.get("details") or []:
        if not isinstance(d, dict):
            continue
        date = (d.get("workingDate") or "")[:10]
        has_in = bool(d.get("startWorkingTime"))
        has_out = bool(d.get("endWorkingTime"))
        # 1) Missing checkout on a past day that has a checkin
        if has_in and not has_out and _is_past(d.get("workingDate"), today):
            issues.append({"date": date, "kind": "missing_checkout",
                           "detail": f"in {d.get('displayStartWorkingTime')}, no checkout"})
        # 2) Working Place empty / invalid — only when there is attendance
        if (has_in or has_out):
            if d.get("isWorkingTypeValid") is False or d.get("workingType") == -1:
                issues.append({"date": date, "kind": "working_place_invalid",
                               "detail": f"workingType={d.get('workingType')}"})
            if d.get("isBreakTimeValid") is False:
                issues.append({"date": date, "kind": "break_invalid",
                               "detail": "isBreakTimeValid=false"})
    # 3) Server-provided warnings
    for w in (obj.get("warnings") or []):
        issues.append({"date": "", "kind": "server_warning", "detail": str(w)})
    return issues


# ═══════════════════════════════════════════════════════════
#  CALCULATE / SAVE
# ═══════════════════════════════════════════════════════════

def do_calculate(fes, month_obj, year, month):
    """POST /calculate. Returns (ok, recalculated_obj_or_None, status)."""
    st, data = _request("POST", API_BASE + "timesheet/calculate", fes, "FES",
                        body_obj=month_obj)
    if st != 200:
        log(f"  /calculate HTTP {st}: {str(data)[:200]}")
        return False, None, st
    if not isinstance(data, dict):
        log(f"  /calculate returned non-object ({type(data).__name__})")
        return False, None, st
    errs = validate_identity(data, year, month)
    if errs:
        log(f"  /calculate response failed validation: {errs}")
        return False, None, st
    log("  /calculate ✓ (response validated)")
    return True, data, st


def do_save(fes, month_obj, dry_run):
    """POST /save. Returns (ok, status)."""
    if dry_run:
        log("  DRY_RUN=1 → skipping POST /save (would have saved Draft)")
        return True, 0
    st, data = _request("POST", API_BASE + "timesheet/save", fes, "FES",
                        body_obj=month_obj)
    if st == 200:
        log("  /save HTTP 200 ✓ (Draft persisted)")
        return True, st
    log(f"  /save HTTP {st}: {str(data)[:300]}")
    return False, st


# ═══════════════════════════════════════════════════════════
#  SUMMARY / EMAIL
# ═══════════════════════════════════════════════════════════

def _f(obj, key):
    try:
        return float(obj.get(key) or 0)
    except Exception:
        return 0.0


def rough_ot_gross(obj):
    """Feature C — rough OT gross estimate (¥). Clearly approximate."""
    rate = BASE_HOURLY_RATE
    wk = _f(obj, "overtimeHours")          # weekday normal OT
    sat = _f(obj, "holidayOvertimeHours")  # Sat / JP holiday OT
    sun = _f(obj, "sundayOvertimeHours")   # Sunday OT
    night = _f(obj, "nightWorkingHours")   # midnight subset → +25% premium
    gross = rate * (1.25 * wk + 1.35 * sat + 1.35 * sun) + rate * 0.25 * night
    return int(round(gross)), {"weekday": wk, "sat": sat, "sun": sun, "night": night}


def build_summary(obj, account, year, month):
    s = lambda k: obj.get(k) or ""
    gross, parts = rough_ot_gross(obj)
    lines = [
        f"Month        : {year}-{month:02d}  (account {account})",
        f"Status       : {s('statusDisplay') or obj.get('status')}",
        f"Std hours    : {s('displayStandardWorkingHour')} × work days "
        f"= {s('displayTotalWorkingHours')}",
        f"Actual work  : {s('displayTotalActualWorkingTime') or '—'}",
        f"Recognized OT: {s('displayTotalOTHours') or s('displayOvertimeHours')}",
        f"  · weekday   {s('displayOvertimeHours')}",
        f"  · Sat/hol   {s('displayHolidayOvertimeHours')}",
        f"  · Sunday    {s('displaySundayOvertimeHours')}",
        f"  · night     {s('displayNightWorkingHours')} (subset, +25%)",
        f"OT request   : {s('displayOTRequestHours')}  (cap 75:00)",
        f"Gap (lost)   : {s('displayTotalWorkingTimeGap')}",
        f"Est. OT gross: ≈ ¥{gross:,}  (rough: 1.25/1.35 + night 25% @ ¥{BASE_HOURLY_RATE}/h)",
    ]
    return "\n".join(lines)


def emit_token_rotation(new_refresh, refresh_token):
    if new_refresh == refresh_token:
        return
    print(f"::add-mask::{new_refresh}")
    try:
        from pending_rotation import write_pending_or_alert as write_pending  # noqa
        gh_pat = os.environ.get("GH_PAT") or os.environ.get("GH_TOKEN")
        if gh_pat:
            write_pending(new_refresh, source="gh_timesheet_action", gh_pat=gh_pat)
            log("🔄 Refresh token rotated; queued for centralized rotation.")
    except Exception as e:
        log(f"⚠️ Failed to queue pending rotation (non-fatal): {e}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("token_rotated=true\n")


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def main():
    now = datetime.now(JST)
    action = (os.environ.get("ACTION") or "calc-save").strip().lower()
    if action not in ("calculate", "save", "calc-save"):
        raise SystemExit(f"invalid ACTION={action!r}")
    year = int(os.environ.get("YEAR") or now.year)
    month = int(os.environ.get("MONTH") or now.month)
    account = (os.environ.get("ACCOUNT") or DEFAULT_ACCOUNT or "tanvc").strip()
    dry_run = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")
    force = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
    wants_save = action in ("save", "calc-save")
    wants_calc = action in ("calculate", "calc-save")

    log(f"Timesheet Action — {action} {year}-{month:02d} account={account} "
        f"dry_run={dry_run} force={force}")

    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        raise RuntimeError("AZURE_REFRESH_TOKEN not set")

    az_tok, new_refresh = refresh_azure_token(refresh_token)
    kt = get_kintai_token(az_tok)
    fes = get_fjp_token(az_tok, "FES")
    log("Tokens OK ✓ (KINTAI + FES)")

    badge = "🚨 ERROR"
    blocked_reason = None
    save_ok = None
    block_exit = 2
    month_obj = None
    try:
        month_obj = fetch_month(kt, fes, account, year, month)
        if not month_obj:
            raise RuntimeError("could not fetch month object")

        errs = validate_identity(month_obj, year, month)
        if errs:
            raise RuntimeError(f"fetched object failed identity validation: {errs}")

        ok, reason = status_gate(month_obj)
        log(f"  Status gate: {reason}")
        if wants_save and not ok:
            # Hard refuse — NOT overridable by FORCE.
            badge = "⛔ BLOCKED"
            blocked_reason = f"Refusing to save: {reason}"
            log(f"  {blocked_reason} (status gate is not FORCE-overridable)")
            raise _Blocked(exit_code=2)

        # ── Calculate ──
        if wants_calc:
            cok, recalc, cst = do_calculate(fes, month_obj, year, month)
            if cok:
                month_obj = recalc
            elif wants_save:
                # calc-save must NOT save on calculate failure.
                badge = "🚨 ERROR"
                blocked_reason = f"/calculate failed (HTTP {cst}); not saving."
                log(f"  {blocked_reason}")
                raise _Blocked(exit_code=3)
            else:
                badge = "🚨 ERROR"
                blocked_reason = f"/calculate failed (HTTP {cst})."
                raise _Blocked(exit_code=3)

        # ── Pre-save anomaly guard ──
        if wants_save:
            issues = anomaly_scan(month_obj)
            if issues and not force:
                badge = "⛔ BLOCKED"
                blocked_reason = (f"{len(issues)} anomaly(ies) found — not saving. "
                                  f"Re-run with FORCE=1 to override.")
                for it in issues:
                    log(f"    ⚠ {it['date']} {it['kind']}: {it['detail']}")
                raise _Blocked(exit_code=2)
            elif issues and force:
                log(f"  FORCE=1 → overriding {len(issues)} anomaly(ies)")

            # Re-confirm status right before the write (cheap stale guard).
            ok2, reason2 = status_gate(month_obj)
            if not ok2:
                badge = "⛔ BLOCKED"
                blocked_reason = f"status changed before save: {reason2}"
                raise _Blocked(exit_code=2)

            sok, sst = do_save(fes, month_obj, dry_run)
            save_ok = sok
            if sok:
                badge = "✅ SAVED (DRY-RUN)" if dry_run else "✅ SAVED DRAFT"
            else:
                badge = "🚨 ERROR"
                blocked_reason = f"/save failed (HTTP {sst})"
        else:
            badge = "🧮 CALCULATED"

    except _Blocked as b:
        block_exit = b.exit_code
    except Exception as e:
        badge = "🚨 ERROR"
        blocked_reason = str(e)
        log(f"❌ {e}")

    # ── Email summary (always) ──
    subject = f"{badge} · Timesheet {year}-{month:02d} · {action}"
    body_lines = []
    if blocked_reason:
        body_lines.append(f"⚠ {blocked_reason}\n")
    try:
        if isinstance(month_obj, dict):
            body_lines.append(build_summary(month_obj, account, year, month))
    except Exception as e:
        body_lines.append(f"(summary unavailable: {e})")
    body_lines.append("\n── Log ──\n" + "\n".join(LOG_LINES))
    body = "\n".join(body_lines)
    try:
        send_email(subject, body)
    except Exception as e:
        log(f"⚠️ email failed: {e}")

    emit_token_rotation(new_refresh, refresh_token)

    # Exit code
    if badge.startswith("✅") or badge == "🧮 CALCULATED":
        return 0
    if badge == "⛔ BLOCKED":
        sys.exit(block_exit)
    sys.exit(1)


class _Blocked(Exception):
    def __init__(self, exit_code=2):
        super().__init__()
        self.exit_code = exit_code


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except SystemExit:
        raise
    except Exception as e:
        log(f"❌ fatal: {e}")
        traceback.print_exc()
        sys.exit(1)
