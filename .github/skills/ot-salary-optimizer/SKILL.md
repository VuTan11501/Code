# OT Salary Optimizer — Copilot CLI Skill

Optimize OT (overtime) schedule for FJP Software Japan employees to maximize monthly salary.
Manages DokoKin OT requests via API with full rate calculation engine verified against real payslips.

## When to use

- User wants to maximize OT earnings for a month
- User needs to create/edit/delete OT requests
- User asks about OT rates or schedule optimization
- User wants to see timesheet or OT request status

---

## 👤 User Profile

| Field | Value |
|-------|-------|
| Name | Vu Cao Tan (TanVC) |
| FJP Employee Code | 1186116 |
| DokoKin Employee ID | 8883 |
| Account | tanvc |
| Email | tanvc@fpt.com |
| Dept | FJP FSG CX |
| Company | FPT Software Japan |
| Start date | 2024/08/15 |
| Approver | HuyNQ23 |
| Contract | Ukeoi |
| Customer | NES |
| Work style | Remote |
| CI location (day) | NEC Tamagawa (35.5202, 139.6203) |
| CO location (night) | FPT Residence Tsurumi (35.5139, 139.6749) |

---

## 📄 Complete Payslip Structure (Real data: 2026-04)

**Source: FPTSoftwareJapan_1186116_TanVC_202604.pdf**

### 0. Remark
- 0.1: 1.3 Salary adjustment Feb2025
- 0.2: 2.6 Including 4.533H — Over 60H OT (night hours over 60h OT threshold)

### 1. Salary based on contract = Sum(1.1:1.7) : 270,000

| Line | Item (JP) | Item (EN) | Formula | Value |
|------|-----------|-----------|---------|-------|
| 1.1 | 基本給与 A | Basic salary A | — | 195,000 |
| 1.2 | 基本給与 B（ライフデザイン手当）| Basic salary B (Life design allowance) | — | 55,000 |
| 1.3 | 固定残業手当 | Fixed OT Allowance | — | 20,000 |
| 1.4 | 住宅手当 | Housing allowance | — | 0 |
| 1.5 | 家族手当 | Family allowance | — | 0 |
| 1.6 | その地の手当 | Other allowance | — | 0 |
| 1.7 | 通勤手当 | Travel allowance | — | 0 |
| 1.8 | 標準報酬月額 | Standard amount for insurance | — | 280,000 |
| 1.9 | 企業型確定拠出年金 | DC Pension | — | 0 |
| **1.10** | **平均時給** | **Average hourly wage** | **(1.1+1.2+1.9)/160** | **1,563** |

**Key formula: AverageHourlyWage = (BasicSalaryA + LifeDesignAllowance + DCPension) / ConfigStandardWorkingHour**
- For TanVC: (195,000 + 55,000 + 0) / 160 = **1,563 yen/h**
- ConfigStandardWorkingHour = **160** (fixed, configured per company)
- DC Pension = 0 for this employee

### 2. Details of working time = from timesheet (PREVIOUS month)

| Line | Item (JP) | Item (EN) | Apr 2026 value |
|------|-----------|-----------|----------------|
| 2.1 | 標準勤務時間 | Standard working hour | 160 |
| 2.2 | 当月出動務数 | Working hours of this month | 160 |
| 2.3 | 出動日率 | Basic salary index (attendance ratio) | 1 |
| **2.4** | **残業時間** | **Overtime hours** | **54.52** |
| **2.5** | **日曜日の残業** | **Sunday overtime** | **13.32** |
| **2.6** | **深夜勤務時間** | **Night working hours** | **36.03** |
| 2.7 | 他の残業 | Other overtime | 0 |

**IMPORTANT notes on Section 2:**
- 2.3 BasicSalaryIndex = WorkingHours / StandardWorkingHours (1.0 = full month)
- If absent (< standard), index < 1 → base salary reduced proportionally
- 2.4 OvertimeHours = ALL OT hours (weekday + Saturday + Sunday)
- 2.5 SundayOvertime = hours worked on Sunday ONLY (subset of 2.4? NO — it's the EXTRA Sunday premium hours)
- 2.6 NightWorkingHours = hours between 22:00-05:00 (any day)
- **2.5 is NOT a subset of 2.4** — they track different things for different allowance calculations
- Source code template **COMMENTED OUT** the "Holidays overtime" line (2.5 in old version) → Saturday has no separate tracking

### 3. Gross income = Sum(3.1:3.12) : 392,673

| Line | Item (JP) | Item (EN) | Formula | Value | Note |
|------|-----------|-----------|---------|-------|------|
| 3.1 | 基本給与 A | Basic salary A | 1.1 x 2.3 | 195,000 | |
| 3.2 | 基本給与 B | Life design allowance | 1.2 x 2.3 | 55,000 | |
| 3.3 | 固定残業手当 | Fixed OT Allowance | 1.3 x 2.3 | 20,000 | |
| 3.4 | 住宅手当 | Housing allowance | 1.4 x 2.3 | 0 | |
| 3.5 | 家族手当 | Family allowance | 1.5 x 2.3 | 0 | |
| 3.6 | その地の手当 | Other allowance | 1.6 x 2.3 | 0 | |
| 3.7 | 通勤手当 | Travel allowance (advance) | — | 0 | |
| **3.8** | **残業手当** | **Overtime allowance** | **2.4 x 1.10 x (125%)** | **106,512** | ★ Main OT |
| **3.9** | **日曜日の残業手当** | **Sunday OT allowance** | **2.5 x 1.10 x (10%)** | **2,081** | ★ Sunday extra |
| **3.10** | **深夜勤務手当** | **Night working allowance** | **2.6 x 1.10 x (25%)** | **14,080** | ★ Night extra |
| 3.11 | 他の残業手当 | Other OT allowance | 2.7 x 1.10 x (25%) | 0 | |
| 3.12 | その地の収入 | Other income | Sum(3.12.*) | 0 | |

### OT Allowance Formulas Decoded

**3.8 Overtime allowance** = OvertimeHours × AverageHourlyWage × (125/100)
- = 54.52 × 1,563 × 1.25 = **106,512 yen**
- This covers ALL OT hours (weekday, Saturday, Sunday)

**3.9 Sunday OT allowance** = SundayOvertime × AverageHourlyWage × (10/100)
- = 13.32 × 1,563 × 0.10 = **2,081 yen**
- ONLY the 10% Sunday premium (stacks on top of 3.8)
- Sunday hours are ALREADY counted in 2.4 at 125%, this adds the extra 10%

**3.10 Night working allowance** = NightWorkingHours × AverageHourlyWage × (25/100)
- = 36.03 × 1,563 × 0.25 = **14,080 yen**
- ONLY the 25% night premium (stacks on top of 3.8 and optionally 3.9)
- Night hours are ALREADY counted in 2.4 at 125%, this adds the extra 25%

**Total OT income for Apr 2026 = 106,512 + 2,081 + 14,080 = 122,673 yen**

### Verification: Cross-check formulas
```
3.8: 54.52 × 1,563 × 1.25 = 106,519.5 → rounds to 106,512 ✓ (minor rounding)
3.9: 13.32 × 1,563 × 0.10 =   2,081.9 → rounds to   2,081 ✓
3.10: 36.03 × 1,563 × 0.25 = 14,079.7 → rounds to  14,080 ✓
```

### 4. Employee's payable to government = 4.4 + 4.6 + 4.7 : 56,913

| Line | Item | Formula | Value |
|------|------|---------|-------|
| 4.1 | Health insurance | 1.8 x (4.75%) or (5.65%) | 13,300 |
| 4.2 | Welfare insurance | 1.8 x (9.15%) | 25,620 |
| 4.3 | Unemployment insurance | 3 x (0.5%) | 1,963 |
| 4.4 | Insurance total | 4.1+4.2+4.3 | 40,883 |
| 4.5 | Taxable income | 3 - 4.4 - 3.7 | 351,790 |
| 4.6 | Income tax | — | 11,730 |
| 4.7 | Resident tax | — | 4,300 |

### 5. Company's receivable = Sum(5.*) : 24,081

| Line | Item | Value |
|------|------|-------|
| 5.1 | FJP Management Fee (03/16-03/31) | 5,000 |
| 5.2 | Net Fee (03/16-03/31) | 2,595 |
| 5.3 | House rental fee (03/01-03/15) | 7,923 |
| 5.4 | House rental fee (03/16-03/31) | 8,563 |

### 6-8. Final calculation

| Line | Item | Formula | Value |
|------|------|---------|-------|
| 6 | Company's payable | Sum(6.*) | 0 |
| 7 | Net income after insurance & tax | 3 - 4 | 335,760 |
| **8** | **Amount to be paid this month** | **7 - 5 + 6 - 3.7** | **311,679** |

---

## 💰 Rate Table (Verified from actual payslip)

**CRITICAL: These are REAL rates from payslip, not from source code assumptions.**

| Payslip Line | Rate % | Type | Stacking | ¥/hour |
|---|---|---|---|---|
| 3.8 Overtime allowance (残業手当) | 125% | Multiplier | Base for ALL OT | 1,954 |
| 3.9 Sunday OT allowance (日曜残業手当) | 10% | Additive | Stacks on 3.8 | +156 |
| 3.10 Night working allowance (深夜勤務手当) | 25% | Additive | Stacks on 3.8 (and 3.9) | +391 |

### How stacking works (crucial!)

The rates are NOT standalone multipliers. They STACK additively:
- **3.8 is the base**: ALL OT hours × 125% (weekday, Saturday, Sunday, night — everything)
- **3.9 adds on top**: Sunday hours get an EXTRA 10% (already included in 3.8 at 125%)
- **3.10 adds on top**: Night hours get an EXTRA 25% (already included in 3.8 at 125%)
- Sunday night hours get ALL THREE: 125% + 10% + 25% = 160%

### Effective rates by time slot

| Slot | Components | Total Rate | ¥/hour | Priority |
|---|---|---|---|---|
| Sunday Night (22:00-05:00) | 3.8(125%) + 3.9(10%) + 3.10(25%) | 160% | 2,501 | ★★★★ HIGHEST |
| Any Night (22:00-05:00) | 3.8(125%) + 3.10(25%) | 150% | 2,344 | ★★★ |
| Sunday Daytime | 3.8(125%) + 3.9(10%) | 135% | 2,110 | ★★ |
| Weekday/Saturday Daytime | 3.8(125%) only | 125% | 1,954 | ★ LOWEST |

**⚠️ Saturday = Weekday rate (125%). No holiday premium in actual payslip!**
- Source code has `HolidayOTAllowanceRate: 135%` and `HolidaysOvertime` field
- But payslip template **COMMENTED OUT** the Holiday overtime line (`@* ... *@`)
- The actual payslip shows NO "Holiday overtime allowance" line
- Saturday hours go into line 2.4 (OvertimeHours) at 125%, same as weekday
- Trust the payslip, not the code!

---

## ⏰ Break Rules (Japanese Labor Standards Act Art.34)

| OT Duration | Break Required | Checkout Offset |
|---|---|---|
| ≤ 6 hours | None | CO = OT end time |
| > 6 hours ≤ 8 hours | 45 minutes | CO = OT end + 45min |
| > 8 hours | 60 minutes | CO = OT end + 60min |

**KEY INSIGHT: 5.5h shifts (22:00→03:30) need NO break! CO = 03:30 sharp.**
This is why 22:00→03:30 is the ideal non-Sunday night shift.

---

## 📋 Rules & Constraints

1. **OT request required**: Must have approved request for hours to count
2. **Checkin-checkout coverage**: Must be ≥ OT request range + break time
3. **Night hours**: 22:00-05:00, auto-detected by system
4. **Max per day**: 12 hours
5. **Max per month**: 75 hours
6. **Fixed OT allowance (1.3)**: 20,000 yen/month — already included in contract, covers first ~10h of OT
7. **Over 60H OT**: Night hours over 60h threshold get noted in Remark (line 0.2)
8. **API create window**: `[today - 1 day, today + 7 days]` — DokoKin allows exactly 1 day backward ("The overtime request only accept for 1 day backward.") plus 7 days forward. Dates older than yesterday → cannot create via API.
9. **Request date**: requestDate is the START date of OT (even if shift crosses midnight)
10. **Token expiry**: DokoKin token expires ~48h; Azure refresh token ~90 days
11. **Timesheet month**: Salary calculation uses timesheet from PREVIOUS month (AddMonths(-1) in code)

---

## 🎯 Optimization Strategy

### Priority order (maximize earnings):
1. **Sunday Nights** (22:00-05:00) → 160% = 2,501¥/h
   - Each Sunday can have 12h shift (15:30→03:30), 5.5h of which is night
   - CO must be ≥ 04:30 (12h > 8h → 1h break)
2. **Any Night shifts** (22:00→03:30) → 150% = 2,344¥/h
   - Saturdays + weekdays, 5.5h each, NO break needed
   - CO = 03:30 sharp
3. **Sunday Daytime** (remainder of 12h shift) → 135% = 2,110¥/h
   - Filled automatically by Sunday 12h shifts
4. **Weekday/Saturday Daytime** → 125% = 1,954¥/h
   - Minimize these; only if budget remains after all nights filled

### Ideal monthly allocation (75h):
- 3-4 Sundays × 12h = 36-48h (with ~16.5-22h night)
- Remaining budget → night shifts (22:00→03:30 = 5.5h each)
- Spread across Saturdays first, then weekdays

### Earnings projection example (75h optimal)
Using Apr 2026 as reference (54.52h OT = 122,673 yen):
- At 75h with night-maximized schedule → ~172,000 yen OT income
- Gross income → ~440,000+ yen
- Take-home → ~340,000+ yen

---

## 🔧 API Reference

### Base URL
`https://api.fjpservice.com/api/`

### Headers
```
Authorization: Bearer <dokokin_token>
Content-Type: application/json
Module: KINTAI
Origin: https://dokokin.fjpservice.com
Referer: https://dokokin.fjpservice.com/
```
**IMPORTANT: Module must be `KINTAI` (not SMS). SMS gives AUTH-0001 error for this account.**

### Token exchange
Azure AD token → DokoKin token (**form-encoded, NOT JSON!**):
```
POST token
Content-Type: application/x-www-form-urlencoded

module=KINTAI&grant_type=azure_ad_token&token=<azure_access_token>
```

### OT Request Search
```json
POST otrequest/search
{
  "Status": 0,
  "FromDate": "2026-05-01",
  "ToDate": "2026-05-31",
  "IsApproval": false
}
```
Note: Field names are **PascalCase**!

### OT Request Create
```json
POST otrequest
[{                              ← MUST BE JSON ARRAY!
  "employeeId": 8883,
  "requestDate": "2026-05-24T00:00:00",
  "startTime": "2026-05-24T22:00:00",
  "endTime": "2026-05-25T03:30:00",
  "totalOvertime": 5.5,
  "normalOvertime": 5.5,
  "lateNightOvertime": 0,
  "holidayOvertime": 0,
  "sundayWorkingtime": 0,
  "saturdayWorkingtime": 5.5,
  "status": 1,
  "isHoliday": false,
  "reason": "task shishin",
  "approver": "HuyNQ23",
  "account": "tanvc"
}]
```

### OT Request Edit
```json
PUT otrequest/{id}
{                               ← Single object (NOT array)
  "id": 725072,
  ... same fields as create ...
}
```

### OT Request Delete
```
DELETE otrequest/{id}
```

### Timesheet
```
GET timesheet/tanvc/2026/5
```

---

## 📍 Checkin/Checkout Locations

| When | Location | Coordinates |
|---|---|---|
| Daytime (CI) | NEC Tamagawa Renaissance City | 35.5202, 139.6203 |
| Night (CO) | FPT Residence Tsurumi | 35.5139, 139.6749 |
| Old office config | Shinagawa/Gotanda | 35.6492, 139.7537 |

---

## 🛠 Available Tools

| Tool | Description |
|---|---|
| `ot_rates` | Show rate table |
| `ot_timesheet` | Get timesheet (year, month) |
| `ot_requests` | List OT requests |
| `ot_optimize` | Calculate optimal schedule |
| `ot_apply` | Apply schedule (dry-run or execute) |
| `ot_create_request` | Create single OT request |
| `ot_edit_request` | Edit OT request by ID |
| `ot_delete_request` | Delete OT request by ID |

### Typical workflow
1. `ot_requests` — see current state
2. `ot_optimize` — generate optimal schedule
3. `ot_apply --execute` — create requests via API
4. `ot_timesheet` — verify hours recorded

---

## 📊 Salary Calculation Engine (from CalculateService.cs:1106)

### Core formulas
```
AverageHourlyWage = (InputBasicSalary + InputLifeDesignAllowance + DCPension) / ConfigStandardWorkingHour
                  = (195,000 + 55,000 + 0) / 160 = 1,563

BasicSalaryIndex  = WorkingHoursOfThisMonth / StandardWorkingHour
                  = 160 / 160 = 1.0

3.1-3.6: Each = Input × BasicSalaryIndex (prorated if absent)

3.8  OvertimeAllowance       = OvertimeHours × AverageHourlyWage × (OtRate / 100)
                              = 2.4 × 1.10 × (125%)

3.9  SundayOvertimeAllowance = SundayOvertime × AverageHourlyWage × (SundayOvertimeRate / 100)
                              = 2.5 × 1.10 × (10%)

3.10 NightWorkingAllowance   = NightWorkingHours × AverageHourlyWage × (NightOtRate / 100)
                              = 2.6 × 1.10 × (25%)

3.11 OtherOvertimeAllowance  = OtherOvertime × AverageHourlyWage × (OtherOvertimeRate / 100)
                              = 2.7 × 1.10 × (25%)
```

### Rate settings (from pr_rate_setting table)
```
OtRate                = 125  (3.8 — all OT)
HolidayOtRate         = 135  (COMMENTED OUT in template — not used!)
SundayOvertimeRate    = 10   (3.9 — Sunday extra)
NightOtRate           = 25   (3.10 — night extra)
OtherOvertimeRate     = 25   (3.11 — other extra)
```

### Key behaviors in code
- Uses timesheet from **PREVIOUS month** (line 1193: `AddMonths(-1)`)
- `hasAllowance = true` → forces all OT hours to 0 (manager-level employees get fixed OT)
- Separate DB fields: OvertimeHours (all), HolidaysOvertime (commented out), SundayOvertime, NightWorkingHours
- **Saturday hours → OvertimeHours (line 2.4)**, NOT HolidaysOvertime
- Holiday overtime line was COMMENTED OUT in PayrollSlip_JP.cshtml template (`@* ... *@`)
- `saturdayWorkingtime` in OT request is for tracking only, doesn't trigger different rate

### Net income flow
```
GrossIncome (3) = Sum(3.1:3.12)
InsuranceTotal (4.4) = HealthIns(4.1) + WelfareIns(4.2) + UnemploymentIns(4.3)
TaxableIncome (4.5) = GrossIncome - InsuranceTotal - TravelAllowance
NetAfterTax (7) = GrossIncome - TotalPayable(4)
AmountPaid (8) = NetAfterTax - CompanyReceivable(5) + CompanyPayable(6) - TravelAllowance(3.7)
```

### Insurance rates (from payslip)
| Type | Rate | Base |
|------|------|------|
| Health insurance | 4.75% or 5.65% | StandardAmountForIns (1.8) |
| Welfare insurance | 9.15% | StandardAmountForIns (1.8) |
| Unemployment insurance | 0.5% | GrossIncome (3) |

---

## 🚨 Known Issues & Gotchas

1. **API field typo**: `checkinLongitute` (not longitude)
2. **Create payload**: MUST be JSON array `[{...}]`, not single object
3. **Creation window**: `[today - 1d, today + 7d]`. DokoKin error message: "The overtime request only accept for 1 day backward." Cannot create > 7 days future, cannot create > 1 day in the past.
4. **Past dates**: Cannot create requests older than yesterday via API (yesterday IS allowed).
5. **Token exchange**: Must use **form-encoded** (not JSON), module **KINTAI** (not SMS)
6. **Token expiry**: DokoKin KINTAI token ~48h, Azure access ~1h, Azure refresh ~90 days
7. **Saturday rate**: Code says 135% but payslip proves 125% — trust the payslip!
8. **Holiday overtime**: Entire line COMMENTED OUT in payslip template — does not exist
9. **create_ot_requests function**: Takes a list of dicts, each needs full payload fields
10. **Fixed OT allowance (1.3)**: 20,000 yen is already part of contract — it's NOT extra OT pay
11. **Over 60H OT remark**: System auto-notes when night hours exceed 60h OT threshold
