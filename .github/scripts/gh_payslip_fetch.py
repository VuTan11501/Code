#!/usr/bin/env python3
"""GitHub Actions — Payslip Fetch.

Pulls the user's monthly payslip from FJP Payroll (api/payroll/salary/{y}/{m})
and stores it in the Gist file `payslip-history.json` for the PWA Salary chip
+ OT Planner Net take-home estimator to consume.

Background:
  Salary cycle: work done in month X (incl. all OT) is paid on day 22 of
  month X+1. So we run on day 22 (and a few days after for safety) and
  fetch the CURRENT calendar month's slip — this contains last month's
  work + OT.

Authentication:
  Same Azure AD → FJP KINTAI module token as the timesheet fetcher.
  Frontend `mykintai.service.ts` calls this endpoint with a KINTAI session,
  so we reuse the existing `get_kintai_token()` helper.

Authorization:
  The endpoint also requires the user's "alternative password" (salary
  passcode) in the request body. Stored as repo secret FJP_PAYROLL_PASSCODE.

Inputs (env):
  AZURE_REFRESH_TOKEN     required
  GH_PAT                  required
  FJP_PAYROLL_PASSCODE    required — user's alternative password
  ACCOUNT                 optional, default "tanvc"
  YEAR_MONTH              optional override "YYYY-MM" (else: current JST month)
  MONTHS_BACK             optional, default 0 — also fetch this many earlier months
  FORCE                   optional "1" — overwrite existing entries

Stdlib only.
"""
import os, sys, json, urllib.request, urllib.error, traceback
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh_ot_creator import (  # type: ignore
    JST, API_BASE, GIST_ID, ACCOUNT as DEFAULT_ACCOUNT,
    log, refresh_azure_token, get_kintai_token, api_headers, http_post,
)
from gist_safety import (  # type: ignore
    read_gist_file, safe_patch_gist_file,
    GistSafetyError, RaceDetected,
)

PAYSLIP_GIST_FILE = "payslip-history.json"


def get_fjp_token(azure_token: str, module: str = "FES") -> str:
    """Exchange Azure AD id_token for an FJP JWT scoped to `module`.

    The web client (FJP.Web) uses module='FES' for /api/payroll endpoints,
    while our /api/timesheet calls use 'KINTAI'. Without the right module
    the payroll endpoint returns 401.
    """
    status, data = http_post(
        API_BASE + "token",
        data={"module": module, "grant_type": "azure_ad_token", "token": azure_token},
    )
    if status != 200 or not data.get("access_token"):
        raise RuntimeError(f"{module} token exchange failed ({status}): {data}")
    return data["access_token"]


def fjp_headers(token: str, module: str = "FES") -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Module": module,
    }


# ═══════════════════════════════════════════════════════════
#  FETCH FROM FJP PAYROLL
# ═══════════════════════════════════════════════════════════

def fetch_payslip(token: str, passcode: str, year: int, month: int):
    """POST /api/payroll/salary/{y}/{m} body = JSON.stringify(passcode).

    Returns list[dict] of CalculateViewModel, or None if not available
    (e.g. month not yet published, or no slip for that month).
    """
    url = f"{API_BASE}payroll/salary/{year}/{month}"
    body = json.dumps(passcode).encode()  # raw JSON string e.g. b'"mypasscode"'
    req = urllib.request.Request(
        url, data=body, headers=fjp_headers(token, "FES"), method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read() or b"[]")
        if isinstance(data, list):
            return data
        return None
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")[:300]
        # 400 with PAYROLL_NOT_EXIST is expected (slip not published yet
        # or no entry for that month) — log gently and skip.
        if e.code == 400 and ("NOT_EXIST" in raw.upper() or "not exist" in raw.lower()):
            log(f"  · {year}-{month:02d}: payslip not available yet")
        else:
            log(f"  ⚠ {year}-{month:02d} HTTP {e.code}: {raw}")
        return None
    except Exception as e:
        log(f"  ⚠ {year}-{month:02d} fetch failed: {e}")
        return None


# ═══════════════════════════════════════════════════════════
#  MAP CalculateViewModel → payslip-history.json schema
# ═══════════════════════════════════════════════════════════

def _f(v, default=0):
    """Best-effort float-or-0 from decimal? / null."""
    if v is None:
        return default
    try:
        return float(v)
    except Exception:
        return default


def _i(v, default=0):
    return int(round(_f(v, default)))


def _get(slip: dict, *names, default=None):
    """Case-insensitive key lookup. Tries each name in order, then
    matches case-insensitively against slip keys. Returns first hit."""
    for n in names:
        if n in slip:
            return slip[n]
    lower_map = {k.lower(): k for k in slip.keys()}
    for n in names:
        k = lower_map.get(n.lower())
        if k is not None:
            return slip[k]
    return default


def slip_to_record(slip: dict, year: int, month: int) -> dict:
    """Convert FJP CalculateViewModel → schema used in payslip-history.json.

    Mirrors the manually-curated format already in the Gist so the PWA
    keeps working with no further changes.
    """
    receivable_items = []
    for idx, item in enumerate(_get(slip, "CompanyReceivableList", "companyReceivableList") or [], start=1):
        if not isinstance(item, dict):
            continue
        # Build label from note1 (date range) + note2 (description), e.g.
        # "03/16-03/31 FJP Management Fee". Fallback to Description/label fields
        # for older API variants.
        note1 = (_get(item, "note1", "Note1") or "").strip()
        note2 = (_get(item, "note2", "Note2") or "").strip()
        note3 = (_get(item, "note3", "Note3") or "").strip()
        label_parts = [p for p in (note1, note2, note3) if p]
        label = " ".join(label_parts) or (_get(item, "Description", "description") or "")
        sub = _get(item, "SubItem", "subItem", "sub", default=idx)
        try:
            sub_val = int(sub) if sub is not None else idx
        except Exception:
            sub_val = idx
        receivable_items.append({
            "sub": sub_val,
            "label": label,
            "value": _i(_get(item, "Amount", "amount")),
        })

    # Remarks list (optional explanatory notes — e.g. "1.3 Salary adjustment Feb2025").
    remarks = []
    for src_key in ("remarkList", "remarkListMonthly", "remarkListTotal"):
        raw = _get(slip, src_key)
        if not raw:
            continue
        # remarkList can be a single dict OR a list of dicts.
        if isinstance(raw, dict):
            raw = [raw]
        if not isinstance(raw, list):
            continue
        for r in raw:
            if isinstance(r, dict) and (r.get("remarkContent") or r.get("RemarkContent")):
                remarks.append({
                    "type": (r.get("type") or r.get("Type") or src_key),
                    "content": (r.get("remarkContent") or r.get("RemarkContent") or "").strip(),
                })

    # Hourly wage. Prefer AverageHourlyWage from API; else compute from contract.
    hourly = _i(_get(slip, "AverageHourlyWage"))
    basic_a = _i(_get(slip, "BasicSalary"))
    basic_b = _i(_get(slip, "LifeDesignAllowance"))
    is_fixed_ot = bool(_get(slip, "IsDisplayOnlyFixedOT", default=False))
    fixed_allow = _i(_get(slip, "OvertimeAllowance")) if is_fixed_ot else _i(_get(slip, "ManagerialAllowance"))
    if fixed_allow == 0:
        fixed_allow = 20000

    if hourly == 0 and (basic_a + basic_b + fixed_allow) > 0:
        std_hours = _f(_get(slip, "StandardWorkingHour"), 160) or 160
        hourly = int((basic_a + basic_b + fixed_allow) / std_hours)

    return {
        "month": f"{year:04d}-{month:02d}",
        "bonus": False,
        "contract": {
            "basic_a": basic_a,
            "basic_b": basic_b,
            "fixed_allowance": fixed_allow,
            "housing_allowance": _i(_get(slip, "HousingAllowance")),
            "family_allowance":  _i(_get(slip, "FamilyAllowance")),
            "other_allowance":   _i(_get(slip, "OtherAllowance")),
            "travel_allowance":  _i(_get(slip, "TravelAllowance")),
            "standard_insurance": _i(_get(slip, "StandardAmountForIns")),
            "hourly_wage": hourly,
        },
        "work": {
            "standard_hours":    _f(_get(slip, "StandardWorkingHour")),
            "month_hours":       _f(_get(slip, "WorkingHoursOfThisMonth")),
            "basic_index":       _f(_get(slip, "BasicSalaryIndex"), 1.0),
            "ot_hours":          _f(_get(slip, "OvertimeHours")),
            "sunday_hours":      _f(_get(slip, "SundayOvertime")),
            "night_hours":       _f(_get(slip, "NightWorkingHours")),
            "holiday_hours":     _f(_get(slip, "HolidaysOvertime")),
            "other_ot_hours":    _f(_get(slip, "OtherOvertime")),
        },
        "gross": _i(_get(slip, "GrossIncome")),
        "gross_breakdown": {
            "basic_a_paid":          _i(_get(slip, "BasicSalary")),
            "basic_b_paid":          _i(_get(slip, "LifeDesignAllowance")),
            "fixed_allowance_paid":  fixed_allow,
            "ot_allowance":          _i(_get(slip, "OvertimeAllowance")),
            "sunday_ot_allowance":   _i(_get(slip, "SundayOvertimeAllowance")),
            "night_allowance":       _i(_get(slip, "NightWorkingAllowance")),
            "holiday_ot_allowance":  _i(_get(slip, "HolidaysOvertimeAllowance")),
            "other_ot_allowance":    _i(_get(slip, "OtherOvertimeAllowance")),
            "other_income":          _i(_get(slip, "OtherIncome")),
        },
        "deductions": {
            "health_insurance":       _i(_get(slip, "HealthInsurance")),
            "welfare_insurance":      _i(_get(slip, "WelfareInsurance")),
            "unemployment_insurance": _i(_get(slip, "UnemploymentInsurance")),
            "insurance_total":        _i(_get(slip, "InsuranceTotal")),
            "taxable_income":         _i(_get(slip, "TaxableIncome")),
            "income_tax":             _i(_get(slip, "IncomeTax")),
            "resident_tax":           _i(_get(slip, "ResidentTax")),
            "total_payable_to_gov":   _i(_get(slip, "InsuranceTotal"))
                                      + _i(_get(slip, "IncomeTax"))
                                      + _i(_get(slip, "ResidentTax")),
        },
        "company_receivables": {
            "total": _i(_get(slip, "CompanyReceivableTotal")),
            "items": receivable_items,
        },
        "company_payable":  _i(_get(slip, "CompanyPayableTotal")),
        "net_after_tax":    _i(_get(slip, "NetIncomeAfterInsTax")),
        "take_home":        _i(_get(slip, "AmountPaidThisMonth")),
        "remarks":          remarks,
        "fetched_at":       datetime.now(JST).isoformat(timespec="seconds"),
    }


# ═══════════════════════════════════════════════════════════
#  GIST UPDATE
# ═══════════════════════════════════════════════════════════

def upsert_payslips(new_records: list[dict], force: bool) -> int:
    """Merge records into Gist payslip-history.json. Returns # changed."""
    if not new_records:
        log("Nothing to write.")
        return 0
    pat = os.environ.get("GH_PAT")
    if not pat:
        raise RuntimeError("GH_PAT not set (needed to PATCH Gist)")
    snapshot = read_gist_file(pat, GIST_ID, PAYSLIP_GIST_FILE, log=log)
    existing = snapshot.get("parsed")
    if not isinstance(existing, dict):
        existing = {"payslips": []}
    payslips = existing.get("payslips") or []
    by_month = {p.get("month"): i for i, p in enumerate(payslips) if isinstance(p, dict) and p.get("month")}
    changed = 0
    for rec in new_records:
        m = rec["month"]
        if m in by_month:
            if not force:
                log(f"  · {m}: already present (use FORCE=1 to overwrite)")
                continue
            payslips[by_month[m]] = rec
            log(f"  ↻ {m}: overwritten")
            changed += 1
        else:
            payslips.append(rec)
            log(f"  + {m}: added")
            changed += 1
    if changed == 0:
        return 0
    # Sort chronologically (oldest → newest) for nice diffs.
    payslips.sort(key=lambda p: (p.get("month") or "", 1 if p.get("bonus") else 0))
    existing["payslips"] = payslips
    existing["updated_at"] = datetime.now(JST).isoformat(timespec="seconds")
    new_content = json.dumps(existing, ensure_ascii=False, indent=2)

    def _shape_ok(parsed):
        if not isinstance(parsed, dict) or "payslips" not in parsed:
            raise ValueError("missing 'payslips' key")

    try:
        st = safe_patch_gist_file(
            pat, GIST_ID, PAYSLIP_GIST_FILE,
            new_content=new_content,
            snapshot=snapshot,
            shape_validator=_shape_ok,
            log=log,
        )
        log(f"✅ Gist PATCH HTTP {st} ({changed} record(s))")
    except RaceDetected as e:
        log(f"⚠ Race on gist write: {e} — please re-run.")
        raise
    return changed


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def _emit_token_rotation(new_refresh: str):
    # Phase 3 hardening: queue rotation; token-monitor drains centrally.
    print(f"::add-mask::{new_refresh}")
    try:
        from pending_rotation import write_pending  # noqa: E402
        gh_pat = os.environ.get("GH_PAT") or os.environ.get("GH_TOKEN")
        if gh_pat:
            write_pending(new_refresh, source="gh_payslip_fetch", gh_pat=gh_pat)
            log("🔄 Refresh token rotated; queued for centralized rotation.")
        else:
            log("⚠️ Refresh token rotated but GH_PAT missing — cannot queue.")
    except Exception as _e:
        log(f"⚠️ Failed to queue pending rotation (non-fatal): {_e}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("token_rotated=true\n")


def _parse_year_month(s: str | None, fallback: datetime):
    if s:
        try:
            y, m = s.strip().split("-")
            return int(y), int(m)
        except Exception:
            log(f"⚠ Invalid YEAR_MONTH={s!r}, falling back to current month")
    return fallback.year, fallback.month


def _months_back(year: int, month: int, count: int):
    """Inclusive: [(year, month), (..., month-1), ...] of length count."""
    out = []
    y, m = year, month
    for _ in range(count):
        out.append((y, m))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    out.reverse()
    return out


def main():
    now = datetime.now(JST)
    account = (os.environ.get("ACCOUNT") or DEFAULT_ACCOUNT).strip()
    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        raise RuntimeError("AZURE_REFRESH_TOKEN not set")
    pat = os.environ.get("GH_PAT")
    if not pat:
        raise RuntimeError("GH_PAT not set (needed to PATCH Gist)")
    passcode = os.environ.get("FJP_PAYROLL_PASSCODE")
    if not passcode:
        raise RuntimeError("FJP_PAYROLL_PASSCODE not set (user's alternative password for /api/payroll/salary)")

    target_y, target_m = _parse_year_month(os.environ.get("YEAR_MONTH"), now)
    months_back = max(0, int(os.environ.get("MONTHS_BACK") or "0"))
    force = (os.environ.get("FORCE") or "").lower() in ("1", "true", "yes")
    targets = _months_back(target_y, target_m, months_back + 1)

    log(f"Payslip Fetch — account={account}, target={target_y}-{target_m:02d}, "
        f"months_back={months_back}, force={force}")

    log("Refreshing Azure → FES token…")
    az_tok, new_refresh = refresh_azure_token(refresh_token)
    fes = get_fjp_token(az_tok, module="FES")
    log("Token OK ✓")
    if new_refresh and new_refresh != refresh_token:
        _emit_token_rotation(new_refresh)

    records = []
    debug = (os.environ.get("DEBUG_DUMP") or "").lower() in ("1", "true", "yes")
    for (y, m) in targets:
        log(f"Fetching {y}-{m:02d}…")
        slips = fetch_payslip(fes, passcode, y, m)
        if not slips:
            continue
        # Use the latest (highest index) slip if multiple — corrections supersede.
        primary = slips[-1]
        if debug:
            log(f"  🔍 RAW KEYS ({y}-{m:02d}): {sorted(primary.keys())}")
            log(f"  🔍 RAW JSON ({y}-{m:02d}): {json.dumps(primary, ensure_ascii=False)[:2000]}")
        try:
            rec = slip_to_record(primary, y, m)
            records.append(rec)
            log(f"  ✓ {y}-{m:02d} mapped (take_home=¥{rec['take_home']:,})")
            if rec["take_home"] == 0 and not debug:
                # Mapping returned zero — likely field-name mismatch. Dump keys to help diagnose.
                log(f"  ⚠ take_home=0 — RAW KEYS: {sorted(primary.keys())}")
                log(f"  ⚠ RAW JSON SAMPLE: {json.dumps(primary, ensure_ascii=False)[:1500]}")
        except Exception as e:
            log(f"  ⚠ {y}-{m:02d} map failed: {e}\n{traceback.format_exc()}")

    upsert_payslips(records, force=force)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"❌ Fatal: {e}")
        log(traceback.format_exc())
        sys.exit(1)
