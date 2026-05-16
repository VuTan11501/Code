#!/usr/bin/env python3
"""OT Salary Optimizer — DokoKin/FJP
Pulls timesheet & OT requests, calculates optimal night-focused schedule,
and manages OT request CRUD via API.
"""
import sys, os, json, math, argparse, base64
from datetime import datetime, timedelta, date
from calendar import monthrange

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
API_BASE = "https://api.fjpservice.com/api/"
AZURE_TOKEN_FILE = os.path.join(SCRIPT_DIR, ".azure_tokens.json")
DOKOKIN_TOKEN_FILE = os.path.join(SCRIPT_DIR, ".dokokin_sms_token.json")

AZURE_APP_ID = "f5be0f68-7285-4365-b979-10af0f3f4106"
AZURE_TENANT = "f01e930a-b52e-42b1-b70f-a8882b5d043b"
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"

ACCOUNT = "tanvc"
EMPLOYEE_ID = 8883
APPROVER = "HuyNQ23"

# ── Rate table (verified from actual payslip) ──
HOURLY_WAGE = 1563
RATES = {
    "overtime": 125,   # 3.8 — all OT hours (weekday, Saturday, Sunday)
    "sunday": 10,      # 3.9 — Sunday premium (stacks with overtime)
    "night": 25,       # 3.10 — Night 22:00-05:00 (stacks with overtime)
    # Note: Saturday = Weekday (125%). No separate holiday premium in payslip.
    # HolidayOTAllowanceRate (135%) exists in code but NOT applied to Saturday.
}

# ── Value per hour (yen) ──
# Sunday Night  (22-05): 125+10+25 = 160% = 2,501
# Any Night     (22-05): 125+25    = 150% = 2,344
# Sunday Day:            125+10    = 135% = 2,110
# Weekday/Saturday Day:  125       = 125% = 1,954

# ── Break rules (Japanese Labor Standards Act Art.34) ──
# >6h ≤8h → 45min break; >8h → 1h break; ≤6h → no break
# Break affects CHECKOUT time, not OT request hours.

import requests as http_lib

# ═══════════════════════════════════════════════════════════
#  TOKEN MANAGEMENT
# ═══════════════════════════════════════════════════════════

def _decode_jwt_exp(token):
    """Extract expiry from JWT without external libs."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (4 - len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("exp", 0)
    except Exception:
        return 0

def _refresh_azure_token():
    """Refresh Azure AD token using cached refresh_token."""
    if not os.path.exists(AZURE_TOKEN_FILE):
        raise RuntimeError("No Azure tokens. Run dokokin_auth_login first.")
    tokens = json.load(open(AZURE_TOKEN_FILE))
    rt = tokens.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh_token. Run dokokin_auth_login.")
    resp = http_lib.post(
        f"https://login.microsoftonline.com/{AZURE_TENANT}/oauth2/v2.0/token",
        data={
            "client_id": AZURE_APP_ID,
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "scope": AZURE_SCOPE,
        },
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Azure refresh failed: {resp.text}")
    data = resp.json()
    tokens["access_token"] = data["access_token"]
    if "refresh_token" in data:
        tokens["refresh_token"] = data["refresh_token"]
    tokens["expires_on"] = _decode_jwt_exp(data["access_token"])
    json.dump(tokens, open(AZURE_TOKEN_FILE, "w"), indent=2)
    return data["access_token"]

def _get_azure_token():
    """Get valid Azure AD access token (refresh if needed)."""
    if not os.path.exists(AZURE_TOKEN_FILE):
        raise RuntimeError("No Azure tokens cached.")
    tokens = json.load(open(AZURE_TOKEN_FILE))
    exp = tokens.get("expires_on", 0)
    if datetime.utcnow().timestamp() < exp - 300:
        return tokens["access_token"]
    return _refresh_azure_token()

def get_dokokin_token():
    """Get DokoKin SMS token (exchange from Azure AD token)."""
    # Check cache
    if os.path.exists(DOKOKIN_TOKEN_FILE):
        cached = json.load(open(DOKOKIN_TOKEN_FILE))
        exp = _decode_jwt_exp(cached.get("token", ""))
        if datetime.utcnow().timestamp() < exp - 300:
            return cached["token"]
    # Exchange Azure → DokoKin (form-encoded, NOT json!)
    # KINTAI module works; SMS gives AUTH-0001 error for this account
    azure_token = _get_azure_token()
    resp = http_lib.post(API_BASE + "token", data={
        "module": "KINTAI",
        "grant_type": "azure_ad_token",
        "token": azure_token,
    })
    if resp.status_code != 200:
        raise RuntimeError(f"DokoKin token exchange failed: {resp.text}")
    data = resp.json()
    token = data.get("access_token") or data.get("token")
    if not token:
        raise RuntimeError(f"No token in response: {data}")
    json.dump({"token": token}, open(DOKOKIN_TOKEN_FILE, "w"), indent=2)
    return token

def _headers():
    return {
        "Authorization": f"Bearer {get_dokokin_token()}",
        "Content-Type": "application/json",
        "Module": "KINTAI",
        "Origin": "https://dokokin.fjpservice.com",
        "Referer": "https://dokokin.fjpservice.com/",
    }

# ═══════════════════════════════════════════════════════════
#  API WRAPPERS
# ═══════════════════════════════════════════════════════════

def api_get(endpoint, params=None):
    r = http_lib.get(API_BASE + endpoint, headers=_headers(), params=params)
    r.raise_for_status()
    return r.json() if r.text else None

def api_post(endpoint, data):
    r = http_lib.post(API_BASE + endpoint, headers=_headers(), json=data)
    return r.status_code, (r.json() if r.text.strip() else {})

def api_put(endpoint, data):
    r = http_lib.put(API_BASE + endpoint, headers=_headers(), json=data)
    return r.status_code, (r.json() if r.text.strip() else {})

def api_delete(endpoint):
    r = http_lib.delete(API_BASE + endpoint, headers=_headers())
    return r.status_code

# ═══════════════════════════════════════════════════════════
#  TIMESHEET
# ═══════════════════════════════════════════════════════════

def get_timesheet(year=None, month=None):
    now = datetime.now()
    y = year or now.year
    m = month or now.month
    data = api_get(f"timesheet/{ACCOUNT}/{y}/{m}")
    return data

def get_timesheet_list(page=0, size=20):
    h = _headers()
    h["X-Pagination-Page"] = str(page)
    h["X-Pagination-Size"] = str(size)
    r = http_lib.get(API_BASE + "timesheet/list", headers=h)
    r.raise_for_status()
    return r.json()

# ═══════════════════════════════════════════════════════════
#  OT REQUESTS
# ═══════════════════════════════════════════════════════════

def get_ot_requests(year=None, month=None):
    now = datetime.now()
    y = year or now.year
    m = month or now.month
    last_day = monthrange(y, m)[1]
    code, data = api_post("otrequest/search", {
        "Status": 0,
        "FromDate": f"{y}-{m:02d}-01",
        "ToDate": f"{y}-{m:02d}-{last_day}",
        "IsApproval": False,
    })
    return data if code == 200 else []

def create_ot_requests(requests_list):
    """Create OT request(s). Input: list of dicts with date/start/end/reason."""
    payload = []
    for req in requests_list:
        payload.append({
            "employeeId": EMPLOYEE_ID,
            "requestDate": req["requestDate"],
            "startTime": req["startTime"],
            "endTime": req["endTime"],
            "totalOvertime": req.get("totalOvertime", 0),
            "normalOvertime": req.get("normalOvertime", 0),
            "lateNightOvertime": 0.0,
            "holidayOvertime": 0.0,
            "sundayWorkingtime": req.get("sundayWorkingtime", 0.0),
            "saturdayWorkingtime": req.get("saturdayWorkingtime", 0.0),
            "status": 1,
            "isHoliday": False,
            "reason": req.get("reason", "task shishin"),
            "approver": APPROVER,
            "account": ACCOUNT,
        })
    code, resp = api_post("otrequest", payload)
    return code, resp

def edit_ot_request(req_id, data):
    """Edit OT request by ID."""
    data["id"] = req_id
    data.setdefault("employeeId", EMPLOYEE_ID)
    data.setdefault("status", 1)
    data.setdefault("isHoliday", False)
    data.setdefault("approver", APPROVER)
    data.setdefault("account", ACCOUNT)
    data.setdefault("lateNightOvertime", 0.0)
    data.setdefault("holidayOvertime", 0.0)
    code, resp = api_put(f"otrequest/{req_id}", data)
    return code, resp

def delete_ot_request(req_id):
    return api_delete(f"otrequest/{req_id}")

# ═══════════════════════════════════════════════════════════
#  RATE CALCULATION
# ═══════════════════════════════════════════════════════════

def calc_night_hours(start_h, start_m, end_h, end_m):
    """Hours between 22:00-05:00 for a shift (may cross midnight)."""
    s = start_h * 60 + start_m
    e = end_h * 60 + end_m
    if e <= s:
        e += 24 * 60
    night = 0
    for ns, ne in [(22*60, 24*60), (24*60, 29*60)]:
        ov_s, ov_e = max(s, ns), min(e, ne)
        if ov_e > ov_s:
            night += (ov_e - ov_s) / 60
    return night

def calc_break_minutes(ot_hours):
    if ot_hours > 8: return 60
    if ot_hours > 6: return 45
    return 0

def calc_earnings(ot_hours, night_hours, is_sunday=False):
    """Calculate earnings for a shift."""
    base = ot_hours * HOURLY_WAGE * (RATES["overtime"] / 100)
    sun = ot_hours * HOURLY_WAGE * (RATES["sunday"] / 100) if is_sunday else 0
    night = night_hours * HOURLY_WAGE * (RATES["night"] / 100)
    return base + sun + night

def value_per_hour(is_sunday=False, is_night=False):
    rate = RATES["overtime"]
    if is_sunday:
        rate += RATES["sunday"]
    yen = HOURLY_WAGE * rate / 100
    if is_night:
        yen += HOURLY_WAGE * RATES["night"] / 100
    return yen

# ═══════════════════════════════════════════════════════════
#  OPTIMIZER
# ═══════════════════════════════════════════════════════════

def get_weekends(year, month):
    """Return list of (date, day_name) for Sat/Sun in month."""
    days_in_month = monthrange(year, month)[1]
    weekends = []
    for d in range(1, days_in_month + 1):
        dt = date(year, month, d)
        if dt.weekday() == 5:
            weekends.append((dt, "Sat"))
        elif dt.weekday() == 6:
            weekends.append((dt, "Sun"))
    return weekends

def get_weekdays(year, month, exclude_dates=None):
    """Return weekdays (Mon-Fri) not in exclude set."""
    exclude = set(exclude_dates or [])
    days_in_month = monthrange(year, month)[1]
    result = []
    for d in range(1, days_in_month + 1):
        dt = date(year, month, d)
        if dt.weekday() < 5 and dt not in exclude:
            result.append((dt, ["Mon","Tue","Wed","Thu","Fri"][dt.weekday()]))
    return result

def optimize_schedule(year=None, month=None, cap=75.0, max_day=12.0,
                       end_time="03:30", keep_existing=True):
    """
    Generate optimal OT schedule maximizing earnings.
    Priority: Sunday Night > Any Night > Sunday Day > Any Day
    """
    now = datetime.now()
    y = year or now.year
    m = month or now.month
    today = now.date()

    end_h, end_m = map(int, end_time.split(":"))

    # Get existing requests
    existing = get_ot_requests(y, m) if keep_existing else []
    existing_dates = {}
    existing_hours = 0
    kept = []

    for req in existing:
        rd = datetime.fromisoformat(req["requestDate"]).date()
        if keep_existing:
            existing_dates[rd] = req
            existing_hours += req["totalOvertime"]
            s = datetime.fromisoformat(req["startTime"])
            e = datetime.fromisoformat(req["endTime"])
            nh = calc_night_hours(s.hour, s.minute, e.hour, e.minute)
            kept.append({
                "date": rd, "day": rd.strftime("%a"),
                "start": s.strftime("%H:%M"), "end": e.strftime("%H:%M"),
                "ot": req["totalOvertime"], "night": nh,
                "action": f"KEEP #{req['id']}", "is_sunday": rd.weekday() == 6,
            })

    budget = cap - existing_hours

    # Collect future available days
    weekends = [(d, dn) for d, dn in get_weekends(y, m)
                if d >= today and d not in existing_dates]
    weekdays = [(d, dn) for d, dn in get_weekdays(y, m, existing_dates.keys())
                if d >= today]

    # Separate Sundays from Saturdays
    sundays = [(d, dn) for d, dn in weekends if d.weekday() == 6]
    saturdays = [(d, dn) for d, dn in weekends if d.weekday() == 5]

    schedule = list(kept)

    # ── Step 1: Fill Sundays (135% base) ──
    for d, dn in sundays:
        if budget <= 0:
            break
        ot = min(max_day, budget)
        # For Sunday: start early to get 12h ending at end_time
        total_min = ot * 60
        end_total = end_h * 60 + end_m
        if end_total < 12 * 60:
            end_total += 24 * 60
        start_total = end_total - total_min
        sh, sm = int((start_total // 60) % 24), int(start_total % 60)
        nh = calc_night_hours(sh, sm, end_h, end_m)
        schedule.append({
            "date": d, "day": dn,
            "start": f"{sh:02d}:{sm:02d}", "end": end_time,
            "ot": ot, "night": nh,
            "action": "NEW", "is_sunday": True,
        })
        budget -= ot

    # ── Step 2: Fill Saturdays with all-night shifts ──
    night_shift_hours = calc_night_hours(22, 0, end_h, end_m)
    for d, dn in saturdays:
        if budget <= 0:
            break
        ot = min(night_shift_hours, budget)
        schedule.append({
            "date": d, "day": dn,
            "start": "22:00", "end": end_time,
            "ot": ot, "night": ot,
            "action": "NEW", "is_sunday": False,
        })
        budget -= ot

    # ── Step 3: Fill weekdays with all-night shifts ──
    for d, dn in weekdays:
        if budget <= 0:
            break
        ot = min(night_shift_hours, budget)
        schedule.append({
            "date": d, "day": dn,
            "start": "22:00", "end": end_time,
            "ot": ot, "night": ot,
            "action": "NEW", "is_sunday": False,
        })
        budget -= ot

    # Sort by date
    schedule.sort(key=lambda x: x["date"])

    # Calculate totals
    total_ot = sum(s["ot"] for s in schedule)
    total_night = sum(s["night"] for s in schedule)
    total_earn = sum(calc_earnings(s["ot"], s["night"], s["is_sunday"]) for s in schedule)

    return {
        "schedule": schedule,
        "total_ot": total_ot,
        "total_night": total_night,
        "total_earn": total_earn,
        "budget_remaining": cap - total_ot,
    }

# ═══════════════════════════════════════════════════════════
#  CLI OUTPUT FORMATTERS
# ═══════════════════════════════════════════════════════════

def print_rates():
    print("OT Rate Table (from actual payslip)")
    print("=" * 55)
    tbl = [
        ("Sunday Night (22-05)", "160%", f"{value_per_hour(True,True):,.0f}"),
        ("Any Night (22-05)", "150%", f"{value_per_hour(False,True):,.0f}"),
        ("Sunday Daytime", "135%", f"{value_per_hour(True,False):,.0f}"),
        ("Weekday/Saturday Day", "125%", f"{value_per_hour(False,False):,.0f}"),
    ]
    for name, rate, yen in tbl:
        print(f"  {name:<25} {rate:>5}  = {yen} yen/h")
    print(f"\nHourly wage: {HOURLY_WAGE} yen")
    print("Saturday = Weekday (no holiday premium in payslip)")

def print_schedule(result):
    sched = result["schedule"]
    print(f"\n{'Date':<10} {'Day':>3} {'OT Range':<14} {'OT':>5} {'Night':>5} {'Earn':>10}  Action")
    print("-" * 72)
    for s in sched:
        rng = f"{s['start']}→{s['end']}"
        earn = calc_earnings(s["ot"], s["night"], s["is_sunday"])
        brk = calc_break_minutes(s["ot"])
        eh, em = map(int, s["end"].split(":"))
        co_m = (eh * 60 + em + brk) % (24 * 60)
        co = f"{co_m//60:02d}:{co_m%60:02d}"
        typ = "SUN" if s["is_sunday"] else "WD"
        print(f"{s['date']}  {s['day']:>3} {rng:<14} {s['ot']:5.1f} {s['night']:5.1f} {earn:10,.0f}  {s['action']} CO≥{co}")
    print("-" * 72)
    r = result
    print(f"TOTAL: {r['total_ot']:.1f}h OT | {r['total_night']:.1f}h Night ({r['total_night']/r['total_ot']*100:.0f}%) | {r['total_earn']:,.0f} yen")

def print_ot_requests(reqs):
    print(f"\nOT Requests ({len(reqs)} items)")
    print("=" * 65)
    total = 0
    for r in sorted(reqs, key=lambda x: x["requestDate"]):
        rd = datetime.fromisoformat(r["requestDate"]).strftime("%b %d")
        st = datetime.fromisoformat(r["startTime"]).strftime("%H:%M")
        et = datetime.fromisoformat(r["endTime"]).strftime("%H:%M")
        total += r["totalOvertime"]
        status = {1:"Submitted",2:"Approved",3:"Rejected",4:"Cancelled"}.get(r["status"],"?")
        print(f"  {rd} ({r['dayOfWeek'][:3]})  {st}→{et}  {r['totalOvertime']:5.1f}h  #{r['id']}  {status}")
    print(f"  Total: {total:.1f}h")

def print_timesheet_summary(ts):
    print(f"\nTimesheet: {ACCOUNT} — {ts.get('year','?')}/{ts.get('month','?')}")
    print("=" * 50)
    status_map = {1:"DRAFT",2:"SUBMITTED",3:"CONFIRMED",4:"APPROVED",5:"REJECTED"}
    print(f"  Status: {status_map.get(ts.get('status',0),'?')}")
    print(f"  Standard hours: {ts.get('standardWorkingHours',0)}")
    print(f"  OT hours: {ts.get('overtimeHours',0)}")
    print(f"  Night hours: {ts.get('nightWorkingHours',0)}")
    print(f"  OT request hours: {ts.get('oTRequestHours',0)}")
    print(f"  Allowance: {ts.get('allowance','?')}")
    print(f"  Fix OT limit: {ts.get('fixOverTimeLimit',0)}h")

# ═══════════════════════════════════════════════════════════
#  APPLY SCHEDULE (create/edit OT requests)
# ═══════════════════════════════════════════════════════════

def build_request_payload(entry):
    """Convert schedule entry to OT request payload."""
    d = entry["date"]
    sh, sm = map(int, entry["start"].split(":"))
    eh, em = map(int, entry["end"].split(":"))
    start_dt = datetime(d.year, d.month, d.day, sh, sm)
    if eh < sh or (eh == sh and em < sm):
        end_dt = datetime(d.year, d.month, d.day, eh, em) + timedelta(days=1)
    else:
        end_dt = datetime(d.year, d.month, d.day, eh, em)
    is_sun = entry["is_sunday"]
    is_sat = d.weekday() == 5
    return {
        "requestDate": f"{d}T00:00:00",
        "startTime": start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "endTime": end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "totalOvertime": entry["ot"],
        "normalOvertime": entry["ot"],
        "sundayWorkingtime": entry["ot"] if is_sun else 0.0,
        "saturdayWorkingtime": entry["ot"] if is_sat else 0.0,
        "reason": "task shishin",
    }

def apply_schedule(result, dry_run=True):
    """Apply optimized schedule: create new OT requests."""
    for entry in result["schedule"]:
        if "KEEP" in entry["action"] or "EDIT" in entry["action"]:
            continue
        payload = build_request_payload(entry)
        if dry_run:
            print(f"  [DRY RUN] Would create: {entry['date']} {entry['start']}→{entry['end']} ({entry['ot']}h)")
        else:
            code, resp = create_ot_requests([payload])
            status = "OK" if code == 200 else f"FAIL ({code}: {resp})"
            print(f"  Created {entry['date']} {entry['start']}→{entry['end']} ({entry['ot']}h) → {status}")

# ═══════════════════════════════════════════════════════════
#  CLI MAIN
# ═══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="OT Salary Optimizer")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("rates", help="Show rate table")
    p_ts = sub.add_parser("timesheet", help="Get timesheet")
    p_ts.add_argument("--year", type=int); p_ts.add_argument("--month", type=int)

    p_ot = sub.add_parser("ot-requests", help="Get OT requests")
    p_ot.add_argument("--year", type=int); p_ot.add_argument("--month", type=int)

    p_opt = sub.add_parser("optimize", help="Optimize OT schedule")
    p_opt.add_argument("--year", type=int); p_opt.add_argument("--month", type=int)
    p_opt.add_argument("--cap", type=float, default=75.0)
    p_opt.add_argument("--max-day", type=float, default=12.0)
    p_opt.add_argument("--end-time", default="03:30")
    p_opt.add_argument("--no-keep", action="store_true")

    p_apply = sub.add_parser("apply", help="Apply optimized schedule")
    p_apply.add_argument("--year", type=int); p_apply.add_argument("--month", type=int)
    p_apply.add_argument("--cap", type=float, default=75.0)
    p_apply.add_argument("--max-day", type=float, default=12.0)
    p_apply.add_argument("--end-time", default="03:30")
    p_apply.add_argument("--execute", action="store_true", help="Actually create requests (default: dry run)")

    p_cr = sub.add_parser("create", help="Create OT request")
    p_cr.add_argument("--date", required=True)
    p_cr.add_argument("--start", required=True)
    p_cr.add_argument("--end", required=True)
    p_cr.add_argument("--reason", default="task shishin")

    p_ed = sub.add_parser("edit", help="Edit OT request")
    p_ed.add_argument("--id", type=int, required=True)
    p_ed.add_argument("--start", required=True)
    p_ed.add_argument("--end", required=True)
    p_ed.add_argument("--reason")

    p_del = sub.add_parser("delete", help="Delete OT request")
    p_del.add_argument("--id", type=int, required=True)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    if args.command == "rates":
        print_rates()

    elif args.command == "timesheet":
        ts = get_timesheet(args.year, args.month)
        print_timesheet_summary(ts)

    elif args.command == "ot-requests":
        reqs = get_ot_requests(args.year, args.month)
        print_ot_requests(reqs)

    elif args.command == "optimize":
        result = optimize_schedule(args.year, args.month, args.cap, args.max_day,
                                    args.end_time, not args.no_keep)
        print_schedule(result)

    elif args.command == "apply":
        result = optimize_schedule(args.year, args.month, args.cap, args.max_day,
                                    args.end_time)
        print_schedule(result)
        print()
        apply_schedule(result, dry_run=not args.execute)

    elif args.command == "create":
        d = datetime.strptime(args.date, "%Y-%m-%d").date()
        sh, sm = map(int, args.start.split(":"))
        eh, em = map(int, args.end.split(":"))
        start_dt = datetime(d.year, d.month, d.day, sh, sm)
        end_dt = datetime(d.year, d.month, d.day, eh, em)
        if eh < sh or (eh == sh and em < sm):
            end_dt += timedelta(days=1)
        s_min = sh*60+sm; e_min = eh*60+em
        if e_min <= s_min: e_min += 24*60
        ot = (e_min - s_min) / 60
        is_sun = d.weekday() == 6
        is_sat = d.weekday() == 5
        payload = [{
            "requestDate": f"{d}T00:00:00",
            "startTime": start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "endTime": end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "totalOvertime": ot, "normalOvertime": ot,
            "sundayWorkingtime": ot if is_sun else 0,
            "saturdayWorkingtime": ot if is_sat else 0,
            "reason": args.reason,
        }]
        code, resp = create_ot_requests(payload)
        print(f"Create {d} {args.start}→{args.end} ({ot}h): HTTP {code}")
        if code != 200:
            print(f"  Error: {resp}")

    elif args.command == "edit":
        sh, sm = map(int, args.start.split(":"))
        eh, em = map(int, args.end.split(":"))
        # Need to find the existing request to get the date
        reqs = get_ot_requests()
        existing = next((r for r in reqs if r["id"] == args.id), None)
        if not existing:
            print(f"Request #{args.id} not found")
            return
        d = datetime.fromisoformat(existing["requestDate"]).date()
        start_dt = datetime(d.year, d.month, d.day, sh, sm)
        end_dt = datetime(d.year, d.month, d.day, eh, em)
        if eh < sh or (eh == sh and em < sm):
            end_dt += timedelta(days=1)
        s_min = sh*60+sm; e_min = eh*60+em
        if e_min <= s_min: e_min += 24*60
        ot = (e_min - s_min) / 60
        is_sun = d.weekday() == 6
        is_sat = d.weekday() == 5
        data = {
            "requestDate": f"{d}T00:00:00",
            "startTime": start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "endTime": end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "totalOvertime": ot, "normalOvertime": ot,
            "sundayWorkingtime": ot if is_sun else 0,
            "saturdayWorkingtime": ot if is_sat else 0,
            "reason": args.reason or existing.get("reason", "task shishin"),
        }
        code, resp = edit_ot_request(args.id, data)
        print(f"Edit #{args.id} → {args.start}→{args.end} ({ot}h): HTTP {code}")

    elif args.command == "delete":
        code = delete_ot_request(args.id)
        print(f"Delete #{args.id}: HTTP {code}")

if __name__ == "__main__":
    main()
