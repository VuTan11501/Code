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


def slip_to_record(slip: dict, year: int, month: int) -> dict:
    """Convert FJP CalculateViewModel → schema used in payslip-history.json.

    Mirrors the manually-curated format already in the Gist so the PWA
    keeps working with no further changes.
    """
    receivable_items = []
    for item in (slip.get("CompanyReceivableList") or []):
        if not isinstance(item, dict):
            continue
        # SubItem may be int or string; preserve sort-friendly numeric if possible.
        sub = item.get("SubItem") if "SubItem" in item else item.get("sub")
        try:
            sub_val = int(sub) if sub is not None else None
        except Exception:
            sub_val = sub
        receivable_items.append({
            "sub": sub_val,
            "label": item.get("Description") or item.get("description") or "",
            "value": _i(item.get("Amount") if "Amount" in item else item.get("amount")),
        })

    # Hourly wage. Prefer AverageHourlyWage from API; else compute from contract.
    hourly = _i(slip.get("AverageHourlyWage"))
    basic_a = _i(slip.get("BasicSalary"))
    basic_b = _i(slip.get("LifeDesignAllowance"))
    fixed_allow = _i(slip.get("OvertimeAllowance")) if slip.get("IsDisplayOnlyFixedOT") else _i(slip.get("ManagerialAllowance"))
    # The contract's "fixed_allowance" in existing data is the OT-irrelevant
    # ¥20k DC line; in API this is typically "ManagerialAllowance" or similar.
    # If user's payslip uses InputManagerialAllowance for the fixed ¥20k,
    # this catches it; otherwise default to 20000 for FJP standard contracts.
    if fixed_allow == 0:
        fixed_allow = 20000

    if hourly == 0 and (basic_a + basic_b + fixed_allow) > 0:
        std_hours = _f(slip.get("StandardWorkingHour"), 160) or 160
        hourly = int((basic_a + basic_b + fixed_allow) / std_hours)

    return {
        "month": f"{year:04d}-{month:02d}",
        "bonus": False,
        "contract": {
            "basic_a": basic_a,
            "basic_b": basic_b,
            "fixed_allowance": fixed_allow,
            "housing_allowance": _i(slip.get("HousingAllowance")),
            "family_allowance":  _i(slip.get("FamilyAllowance")),
            "other_allowance":   _i(slip.get("OtherAllowance")),
            "travel_allowance":  _i(slip.get("TravelAllowance")),
            "standard_insurance": _i(slip.get("StandardAmountForIns")),
            "hourly_wage": hourly,
        },
        "work": {
            "standard_hours":    _f(slip.get("StandardWorkingHour")),
            "month_hours":       _f(slip.get("WorkingHoursOfThisMonth")),
            "basic_index":       _f(slip.get("BasicSalaryIndex"), 1.0),
            "ot_hours":          _f(slip.get("OvertimeHours")),
            "sunday_hours":      _f(slip.get("SundayOvertime")),
            "night_hours":       _f(slip.get("NightWorkingHours")),
            "other_ot_hours":    _f(slip.get("OtherOvertime")),
        },
        "gross": _i(slip.get("GrossIncome")),
        "gross_breakdown": {
            "basic_a_paid":          _i(slip.get("BasicSalary")),
            "basic_b_paid":          _i(slip.get("LifeDesignAllowance")),
            "fixed_allowance_paid":  fixed_allow,
            "ot_allowance":          _i(slip.get("OvertimeAllowance")),
            "sunday_ot_allowance":   _i(slip.get("SundayOvertimeAllowance")),
            "night_allowance":       _i(slip.get("NightWorkingAllowance")),
            "other_ot_allowance":    _i(slip.get("OtherOvertimeAllowance")),
            "other_income":          _i(slip.get("OtherIncome")),
        },
        "deductions": {
            "health_insurance":       _i(slip.get("HealthInsurance")),
            "welfare_insurance":      _i(slip.get("WelfareInsurance")),
            "unemployment_insurance": _i(slip.get("UnemploymentInsurance")),
            "insurance_total":        _i(slip.get("InsuranceTotal")),
            "taxable_income":         _i(slip.get("TaxableIncome")),
            "income_tax":             _i(slip.get("IncomeTax")),
            "resident_tax":           _i(slip.get("ResidentTax")),
            "total_payable_to_gov":   _i(slip.get("InsuranceTotal"))
                                      + _i(slip.get("IncomeTax"))
                                      + _i(slip.get("ResidentTax")),
        },
        "company_receivables": {
            "total": _i(slip.get("CompanyReceivableTotal")),
            "items": receivable_items,
        },
        "company_payable":  _i(slip.get("CompanyPayableTotal")),
        "net_after_tax":    _i(slip.get("NetIncomeAfterInsTax")),
        "take_home":        _i(slip.get("AmountPaidThisMonth")),
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
    existing, etag = read_gist_file(GIST_ID, PAYSLIP_GIST_FILE, pat)
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
    try:
        safe_patch_gist_file(
            GIST_ID, PAYSLIP_GIST_FILE,
            json.dumps(existing, ensure_ascii=False, indent=2),
            pat, etag=etag,
        )
    except RaceDetected as e:
        log(f"⚠ Race on gist write: {e} — please re-run.")
        raise
    log(f"✅ Gist updated ({changed} record(s))")
    return changed


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def _emit_token_rotation(new_refresh: str):
    print(f"::add-mask::{new_refresh}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("token_rotated=true\n")
            f.write(f"new_refresh_token={new_refresh}\n")
    log("⚠️ Azure refresh token rotated — written to GITHUB_OUTPUT")


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
    for (y, m) in targets:
        log(f"Fetching {y}-{m:02d}…")
        slips = fetch_payslip(fes, passcode, y, m)
        if not slips:
            continue
        # Use the latest (highest index) slip if multiple — corrections supersede.
        primary = slips[-1]
        try:
            records.append(slip_to_record(primary, y, m))
            log(f"  ✓ {y}-{m:02d} mapped (take_home=¥{records[-1]['take_home']:,})")
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
