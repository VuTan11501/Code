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
import concurrent.futures
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh_ot_creator import (  # type: ignore
    JST, API_BASE, GIST_ID, ACCOUNT as DEFAULT_ACCOUNT,
    log, LOG_LINES, refresh_azure_token, get_kintai_token,
    api_headers, send_email,
)
from gh_payslip_fetch import get_fjp_token, fjp_headers  # type: ignore
from gh_timesheet_fetch import normalize_month, TIMESHEET_GIST_FILE  # type: ignore
from gist_safety import read_gist_file, safe_patch_gist_file  # type: ignore

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


def _esc(v):
    return str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_timesheet_html(obj, account, year, month, action, badge, blocked_reason=None):
    """shadcn/ui dark-themed HTML email — matches gh_checkin / gh_ot_creator."""
    BG, CARD, BORDER = "#0a0a0a", "#0f0f0f", "#262626"
    FG, MUTED, MUTED_BG = "#fafafa", "#a3a3a3", "#171717"
    accents = {
        "success": {"bg": "rgba(34,197,94,0.12)", "fg": "#4ade80", "border": "rgba(34,197,94,0.25)"},
        "info":    {"bg": "rgba(59,130,246,0.12)", "fg": "#60a5fa", "border": "rgba(59,130,246,0.25)"},
        "warning": {"bg": "rgba(234,179,8,0.12)",  "fg": "#facc15", "border": "rgba(234,179,8,0.25)"},
        "error":   {"bg": "rgba(239,68,68,0.12)",  "fg": "#f87171", "border": "rgba(239,68,68,0.25)"},
    }
    if badge.startswith("✅"):
        status = "success"
    elif badge.startswith("🧮"):
        status = "info"
    elif badge.startswith("⛔"):
        status = "warning"
    else:
        status = "error"
    a = accents[status]

    s = lambda k: _esc(obj.get(k) or "")
    gross, _parts = rough_ot_gross(obj)
    status_txt = s("statusDisplay") or _esc(obj.get("status"))
    actual = s("displayTotalActualWorkingTime") or "—"
    ot_req = s("displayOTRequestHours") or "—"
    ot_total = s("displayTotalOTHours") or s("displayOvertimeHours") or "—"
    badge_clean = _esc(badge)

    def row(k, v, mono=False, accent=None):
        vcol = accent or FG
        vstyle = (f"color:{vcol};font-size:13px;"
                  + ("font-family:ui-monospace,SFMono-Regular,Consolas,monospace;" if mono else ""))
        return (f'<tr><td style="padding:10px 0;color:{MUTED};font-size:12px;width:120px;'
                f'border-bottom:1px solid {BORDER};">{k}</td>'
                f'<td style="padding:10px 0;{vstyle}border-bottom:1px solid {BORDER};text-align:right;">{v}</td></tr>')

    def tile(label, value):
        return (f'<td width="50%" style="padding:0 4px;">'
                f'<div style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:10px;padding:14px 16px;">'
                f'<div style="color:{MUTED};font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">{label}</div>'
                f'<div style="color:{FG};font-size:22px;font-weight:700;letter-spacing:-0.01em;'
                f'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;">{value}</div></div></td>')

    rows = ""
    rows += row("Status", status_txt or "—", mono=True)
    rows += row("Std hours", f"{s('displayStandardWorkingHour') or '—'} "
                f"<span style='color:{MUTED}'>→ {s('displayTotalWorkingHours') or '—'}</span>", mono=True)
    rows += row("Recognized OT", ot_total, mono=True)
    rows += row("OT request", f"{ot_req} <span style='color:{MUTED}'>/ cap 75:00</span>", mono=True)
    gap = s("displayTotalWorkingTimeGap")
    if gap:
        rows += row("Gap (lost)", gap, mono=True, accent="#facc15")
    rows += row("Est. OT gross", f"≈ ¥{gross:,}", mono=True, accent=a["fg"])

    # OT breakdown sub-card
    bd = [("Weekday", s("displayOvertimeHours")),
          ("Sat / holiday", s("displayHolidayOvertimeHours")),
          ("Sunday", s("displaySundayOvertimeHours")),
          ("Night (subset +25%)", s("displayNightWorkingHours"))]
    bd_rows = "".join(
        f'<tr><td style="padding:6px 0;color:{MUTED};font-size:12px;">{k}</td>'
        f'<td style="padding:6px 0;color:{FG};font-size:12px;text-align:right;'
        f'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;">{v or "—"}</td></tr>'
        for k, v in bd)

    blocked_html = ""
    if blocked_reason:
        bcol = a["fg"]
        blocked_html = (f'<div style="background:{a["bg"]};border:1px solid {a["border"]};border-radius:8px;'
                        f'padding:14px;margin-top:18px;">'
                        f'<div style="color:{bcol};font-size:12px;font-weight:600;text-transform:uppercase;'
                        f'letter-spacing:0.04em;margin-bottom:6px;">Note</div>'
                        f'<div style="color:{FG};font-size:13px;line-height:1.5;">{_esc(blocked_reason)}</div></div>')

    log_html = "<br>".join(_esc(x) for x in LOG_LINES)
    date_str = datetime.now(JST).strftime("%Y-%m-%d %H:%M")

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:{BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{FG};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG}" style="background:{BG};">
<tr><td align="center" style="padding:24px 12px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:{CARD};border:1px solid {BORDER};border-radius:12px;overflow:hidden;">

  <tr><td style="padding:24px 24px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:{a['bg']};border:1px solid {a['border']};border-radius:9999px;padding:4px 12px;color:{a['fg']};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">{badge_clean}</td>
    </tr></table>
    <h1 style="margin:14px 0 4px;font-size:22px;font-weight:700;letter-spacing:-0.01em;color:{FG};">Timesheet {year}-{month:02d}</h1>
    <p style="margin:0 0 4px;color:{MUTED};font-size:13px;">DokoKin monthly timesheet · {_esc(action)} · {_esc(account)}</p>
  </td></tr>

  <!-- Highlight tiles -->
  <tr><td style="padding:18px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      {tile("Actual worked", actual)}
      {tile("OT request", ot_req)}
    </tr></table>
  </td></tr>

  <tr><td style="padding:20px 24px 0;"><div style="height:1px;background:{BORDER};"></div></td></tr>

  <tr><td style="padding:4px 24px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>
  </td></tr>

  <!-- OT breakdown -->
  <tr><td style="padding:8px 24px 4px;">
    <div style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:12px 14px;">
      <div style="color:{MUTED};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">OT breakdown</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{bd_rows}</table>
    </div>
    {blocked_html}
  </td></tr>

  <!-- Log (collapsed) -->
  <tr><td style="padding:16px 24px 20px;">
    <details style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;">
      <summary style="cursor:pointer;padding:10px 14px;color:{MUTED};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Execution log ({len(LOG_LINES)} lines)</summary>
      <div style="padding:0 14px 14px;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#d4d4d4;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;">{log_html}</div>
    </details>
  </td></tr>

  <tr><td style="padding:14px 24px;border-top:1px solid {BORDER};background:#080808;">
    <div style="color:#737373;font-size:11px;letter-spacing:0.02em;">Timesheet Action · GitHub Actions · {date_str} JST · rough gross @ ¥{BASE_HOURLY_RATE}/h</div>
  </td></tr>
</table>

</td></tr></table></body></html>'''


def push_month_to_gist(obj, account, year, month):
    """Write the fresh/recalculated month straight into timesheet-history.json
    so the PWA can reload from the Gist WITHOUT dispatching a second
    timesheet-fetch workflow (saves a whole ~60-90s round-trip). Non-fatal."""
    pat = os.environ.get("GH_PAT") or os.environ.get("GH_TOKEN")
    if not pat:
        log("  ⚠ GH_PAT missing — skip Gist cache update (PWA will need manual Sync)")
        return
    key = f"{year}-{month:02d}"
    try:
        snap = normalize_month(obj)
        snapshot = read_gist_file(pat, GIST_ID, TIMESHEET_GIST_FILE, log=log)
        existing = snapshot.get("parsed")
        if not isinstance(existing, dict) or "months" not in existing:
            existing = {"months": {}, "account": account}
        months = existing.get("months")
        if not isinstance(months, dict):
            months = {}
        months[key] = snap
        payload = {
            "account": account,
            "updated_at": datetime.now(JST).isoformat(timespec="seconds"),
            "months_keep": existing.get("months_keep", 24),
            "months": months,
        }
        new_content = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)

        def _shape_ok(parsed):
            if not isinstance(parsed, dict) or "months" not in parsed:
                raise ValueError("missing 'months' key")

        st = safe_patch_gist_file(
            pat, GIST_ID, TIMESHEET_GIST_FILE,
            new_content=new_content,
            snapshot=snapshot,
            shape_validator=_shape_ok,
            backup=False,
            log=log,
        )
        log(f"  📤 Gist cache updated {key} (HTTP {st}) — PWA can reload directly")
    except Exception as e:
        log(f"  ⚠ Gist cache update failed (non-fatal): {e}")


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
    # KINTAI + FES token exchanges both depend ONLY on the Azure token and are
    # independent of each other → run them in parallel to shave a round-trip.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f_kt = ex.submit(get_kintai_token, az_tok)
        f_fes = ex.submit(get_fjp_token, az_tok, "FES")
        kt = f_kt.result()
        fes = f_fes.result()
    log("Tokens OK ✓ (KINTAI + FES, parallel)")

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

    # ── Push fresh month into the Gist cache so the PWA can reload directly
    #    (skips a whole second timesheet-fetch workflow). Only on success. ──
    if isinstance(month_obj, dict) and (badge.startswith("✅") or badge == "🧮 CALCULATED"):
        if not dry_run:
            push_month_to_gist(month_obj, account, year, month)
        else:
            log("  (dry-run: skipping Gist cache update)")

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
    html_body = None
    if isinstance(month_obj, dict):
        try:
            html_body = build_timesheet_html(
                month_obj, account, year, month, action, badge, blocked_reason)
        except Exception as e:
            log(f"⚠️ html email build failed (sending plain): {e}")
    try:
        send_email(subject, body, html=html_body)
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
