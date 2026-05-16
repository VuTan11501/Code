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
| Employee ID | 8883 |
| Account | tanvc |
| Email | tanvc@fpt.com |
| Approver | HuyNQ23 |
| Base hourly wage | 1,563 yen/h |
| Max OT/month | 75 hours |
| Max OT/day | 12 hours |
| Work style | Remote |
| CI location (day) | NEC Tamagawa (35.5202, 139.6203) |
| CO location (night) | FPT Residence Tsurumi (35.5139, 139.6749) |

---

## 💰 Rate Table (Verified from actual payslip)

**CRITICAL: These are REAL rates from payslip, not from source code assumptions.**

| Payslip Line | Rate | Stacking | ¥/hour |
|---|---|---|---|
| 3.8 Overtime allowance | 125% | Base for ALL OT | 1,954 |
| 3.9 Sunday OT allowance | +10% | Stacks on 125% | +156 |
| 3.10 Night working allowance | +25% | Stacks on any | +391 |

### Effective rates by time slot

| Slot | Calculation | ¥/hour | Priority |
|---|---|---|---|
| Sunday Night (22:00-05:00) | 125%+10%+25% = 160% | 2,501 | ★★★★ HIGHEST |
| Any Night (22:00-05:00) | 125%+25% = 150% | 2,344 | ★★★ |
| Sunday Daytime | 125%+10% = 135% | 2,110 | ★★ |
| Weekday/Saturday Daytime | 125% | 1,954 | ★ LOWEST |

**⚠️ Saturday = Weekday rate (125%). No holiday premium in actual payslip!**
The code has `HolidayOTAllowanceRate: 135%` but it's NOT applied to Saturday in practice.

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
6. **API create window**: Only within 7-day future (cannot create past dates)
7. **Request date**: requestDate is the START date of OT (even if shift crosses midnight)
8. **Token expiry**: DokoKin token expires ~48h; Azure refresh token ~90 days

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

---

## 🔧 API Reference

### Base URL
`https://api.fjpservice.com/api/`

### Headers
```
Authorization: Bearer <dokokin_token>
Content-Type: application/json
Module: SMS
Origin: https://dokokin.fjpservice.com
Referer: https://dokokin.fjpservice.com/
```

### Token exchange
Azure AD token → DokoKin token:
```json
POST token
{
  "module": "SMS",
  "grant_type": "azure_ad_token",
  "token": "<azure_access_token>"
}
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

## 📊 Salary Calculation (from CalculateService.cs)

```
OT_Allowance = OT_Hours × AverageHourlyWage × (Rate / 100)
AverageHourlyWage = (BasicSalary + LifeDesignAllowance + DCPension) / StandardWorkingHour
```

- Uses timesheet from **PREVIOUS month** (AddMonths(-1))
- `hasAllowance = true` → forces all OT to 0
- Separate DB fields: OvertimeHours (125%), HolidaysOvertime (135%), SundayOvertime (10%), NightWorkingHours (25%)
- **Saturday → OvertimeHours (125%)**, NOT HolidaysOvertime

---

## 🚨 Known Issues & Gotchas

1. **API field typo**: `checkinLongitute` (not longitude)
2. **Create payload**: MUST be JSON array `[{...}]`, not single object
3. **7-day window**: Cannot create requests > 7 days in future
4. **Past dates**: Cannot create requests for past dates via API
5. **Token expiry**: DokoKin SMS token ~48h, Azure access ~1h, Azure refresh ~90 days
6. **Saturday rate**: Code says 135% but payslip proves 125% — trust the payslip!
7. **create_ot_requests function** takes a list of dicts, each needs full payload fields
