# 📅 Lịch Checkin-Checkout Tháng 5/2026

> Auto-generated for DokoKin auto-checkin/checkout script
> Employee: TanVC (ID: 8883) | Max OT: 75h/month
> Updated: 2026-05-16

## 📍 Locations

| ID | Location | Latitude | Longitude |
|----|----------|----------|-----------|
| office | NEC Tamagawa Renaissance City | 35.5202417 | 139.620325 |
| home | FPT Residence Tsurumi | 35.51386 | 139.6749183 |

## 📋 Quy tắc

- **Workday**: CI 09:00 (office) → CO 18:00 (office)
- **Workday + OT đêm**: CI 09:00 (office) → CO 03:30+1 (home) — ⚠️ **PHẢI skip default CO 18:00 trong Gist `skip_dates`**, nếu không workday đóng tại 18:00 và OT bị mất
- **Weekend OT đêm (Sat)**: CI 22:00 (home) → CO 03:30+1 (home)
- **Weekend OT full (Sun)**: CI 15:30 (home) → CO 04:30+1 (home)
- **Break**: ≤6h = 0min | >6h≤8h = 45min | >8h = 60min
- **+1** = ngày hôm sau

> 🚨 **CO closes workday permanently** — không thể "mở lại" session. Trên các ngày Work+OT có OT vắt qua nửa đêm (05/11, 05/18, 05/19, 05/21), recurring weekday CO 18:00 trong Gist phải có các date đó trong `recurrence.skip_dates`, và thay bằng explicit `once` CO tại 03:30+1 (hoặc 00:00+1 với OT 18:00→00:00).

## 🗓 Schedule

| Date | Day | Type | CI Time | CI Location | CO Time | CO Location | OT Request | OT Hours | Note |
|------|-----|------|---------|-------------|---------|-------------|------------|----------|------|
| 05/01 | Fri | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/02 | Sat | OFF | — | — | — | — | — | — | |
| 05/03 | Sun | OFF | — | — | — | — | — | — | 憲法記念日 |
| 05/04 | Mon | OFF | — | — | — | — | — | — | みどりの日 |
| 05/05 | Tue | OFF | — | — | — | — | — | — | こどもの日 |
| 05/06 | Wed | OFF | — | — | — | — | — | — | 振替休日 |
| 05/07 | Thu | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/08 | Fri | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/09 | Sat | OFF | — | — | — | — | — | — | |
| 05/10 | Sun | OFF | — | — | — | — | — | — | |
| 05/11 | Mon | Work+OT | 09:00 | office | 00:00+1 | home | #724475 | 6.0h | OT 18:00→00:00 |
| 05/12 | Tue | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/13 | Wed | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/14 | Thu | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/15 | Fri | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/16 | Sat | OT Night | 22:00 | home | 03:30+1 | home | #725072 | 5.5h | 🌙 全night |
| 05/17 | Sun | OT Full | 15:30 | home | 04:30+1 | home | #725073 | 12.0h | ☀️🌙 day+night, break 1h |
| 05/18 | Mon | Work+OT | 09:00 | office | 03:30+1 | home | ⏳ PENDING | 5.5h | 🌙 OT 22:00→03:30 |
| 05/19 | Tue | Work+OT | 09:00 | office | 03:30+1 | home | #726679 | 5.5h | 🌙 OT 22:00→03:30 |
| 05/20 | Wed | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/21 | Thu | Work+OT | 09:00 | office | 03:30+1 | home | #726678 | 5.5h | 🌙 OT 22:00→03:30 |
| 05/22 | Fri | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/23 | Sat | OT Night | 22:00 | home | 03:30+1 | home | #726676 | 5.5h | 🌙 全night |
| 05/24 | Sun | OT Full | 15:30 | home | 04:30+1 | home | ⏳ PENDING | 12.0h | ☀️🌙 day+night, break 1h |
| 05/25 | Mon | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/26 | Tue | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/27 | Wed | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/28 | Thu | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/29 | Fri | Work | 09:00 | office | 18:00 | office | — | — | |
| 05/30 | Sat | OT Night | 22:00 | home | 03:30+1 | home | ⏳ PENDING | 5.5h | 🌙 全night |
| 05/31 | Sun | OT Full | 15:30 | home | 04:30+1 | home | ⏳ PENDING | 12.0h | ☀️🌙 day+night, break 1h |

## 📊 Tổng kết

| Metric | Value |
|--------|-------|
| Tổng OT | 75.0h |
| OT đêm (22:00-05:00) | 51.5h (69%) |
| OT ban ngày | 23.5h (31%) |
| Dự kiến thu nhập OT | ~172,282 yen |
| Requests đã tạo | 6/10 (40.0h) |
| Requests chưa tạo | 4 (35.0h) |

### ⏳ Pending OT Requests (cần tạo khi vào 7-day window)

| Date | Range | OT | Tạo được từ | Status |
|------|-------|----|-------------|--------|
| 05/18 Mon | 22:00→03:30 | 5.5h | May 11 ✅ | **Cần tạo ngay!** |
| 05/24 Sun | 15:30→03:30 | 12.0h | May 17 | Chờ |
| 05/30 Sat | 22:00→03:30 | 5.5h | May 23 | Chờ |
| 05/31 Sun | 15:30→03:30 | 12.0h | May 24 | Chờ |

## 🔄 Checkin-Checkout Action Timeline (cho auto script)

```
# Workday thường (Mon-Fri, no OT)
CI  09:00  office  (35.5202417, 139.620325)
CO  18:00  office  (35.5202417, 139.620325)

# Workday + OT đêm (Mon/Tue/Thu with night OT)
CI  09:00  office  (35.5202417, 139.620325)
CO  03:30  home    (35.51386, 139.6749183)    ← next day!

# Saturday OT Night
CI  22:00  home    (35.51386, 139.6749183)
CO  03:30  home    (35.51386, 139.6749183)    ← next day!

# Sunday OT Full Day
CI  15:30  home    (35.51386, 139.6749183)
CO  04:30  home    (35.51386, 139.6749183)    ← next day! (includes 1h break)
```
