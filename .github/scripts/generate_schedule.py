#!/usr/bin/env python3
"""Generate schedule.json for next month.

Usage:
    python generate_schedule.py [--year 2026] [--month 6]
        [--ot-dates 2,5,9,12,16,19,23,26,30]
        [--sunday-ot 7,14,21,28]
        [--location office]

Generates the full schedule.json consumed by gh_checkin.py, including:
  - Base weekday CI/CO entries (09:00/18:00 Mon-Fri, skip holidays)
  - Night OT entries (22:00 CI, next-day 03:30 CO)
  - Sunday OT entries (14:30 CI, next-day 03:30 CO)
  - pending_ot list for gh_ot_creator.py

Zero external dependencies (stdlib only).
"""
import argparse
import json
import os
import sys
from calendar import monthrange
from datetime import date, timedelta

# Japanese public holidays 2026-2027
JAPANESE_HOLIDAYS = {
    date(2026, 1, 1), date(2026, 1, 12), date(2026, 2, 11), date(2026, 2, 23),
    date(2026, 3, 20), date(2026, 4, 29), date(2026, 5, 3), date(2026, 5, 4),
    date(2026, 5, 5), date(2026, 5, 6), date(2026, 7, 20), date(2026, 8, 11),
    date(2026, 9, 21), date(2026, 9, 22), date(2026, 9, 23), date(2026, 10, 12),
    date(2026, 11, 3), date(2026, 11, 23), date(2026, 12, 23),
    date(2027, 1, 1), date(2027, 1, 11), date(2027, 2, 11), date(2027, 2, 23),
    date(2027, 3, 21), date(2027, 4, 29), date(2027, 5, 3), date(2027, 5, 4),
    date(2027, 5, 5), date(2027, 7, 19), date(2027, 8, 11), date(2027, 9, 20),
    date(2027, 9, 23), date(2027, 10, 11), date(2027, 11, 3), date(2027, 11, 23),
}

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def next_month(today=None):
    """Return (year, month) for next month."""
    today = today or date.today()
    if today.month == 12:
        return today.year + 1, 1
    return today.year, today.month + 1


def is_workday(d):
    """True if d is Mon-Fri and not a Japanese holiday."""
    return d.weekday() < 5 and d not in JAPANESE_HOLIDAYS


def parse_day_list(s, year, month):
    """Parse comma-separated day numbers into date list."""
    if not s:
        return []
    last_day = monthrange(year, month)[1]
    days = []
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        day = int(part)
        if 1 <= day <= last_day:
            days.append(date(year, month, day))
        else:
            print(f"Warning: day {day} out of range for {year}-{month:02d}", file=sys.stderr)
    return days


def generate_schedule(year, month, ot_dates=None, sunday_ot_dates=None,
                      location="office", ot_location="home"):
    """Generate full schedule dict matching schedule.json format."""
    ot_dates = ot_dates or []
    sunday_ot_dates = sunday_ot_dates or []
    ot_date_set = set(ot_dates)
    sunday_ot_set = set(sunday_ot_dates)

    last_day = monthrange(year, month)[1]
    actions = []
    pending_ot = []

    for day_num in range(1, last_day + 1):
        d = date(year, month, day_num)
        ds = d.isoformat()
        day_name = DAY_NAMES[d.weekday()]

        # Workday base schedule (Mon-Fri, not holiday)
        if is_workday(d):
            note = f"{day_name} workday"
            # If this workday also has night OT, checkout is next-day 03:30
            if d in ot_date_set:
                note += " + OT"
                actions.append({"datetime": f"{ds} 09:00", "action": "checkin",
                                "location": location, "note": note})
                next_day = (d + timedelta(days=1)).isoformat()
                actions.append({"datetime": f"{next_day} 03:30", "action": "checkout",
                                "location": ot_location,
                                "note": f"{d.strftime('%b%d')} OT night CO"})
                pending_ot.append({
                    "date": ds, "start": "22:00", "end": "03:30",
                    "hours": 5.5, "reason": "task shishin",
                })
            else:
                actions.append({"datetime": f"{ds} 09:00", "action": "checkin",
                                "location": location, "note": note})
                actions.append({"datetime": f"{ds} 18:00", "action": "checkout",
                                "location": location})

        # Saturday night OT
        elif d.weekday() == 5 and d in ot_date_set:
            actions.append({"datetime": f"{ds} 22:00", "action": "checkin",
                            "location": ot_location, "note": "Sat OT night"})
            next_day = (d + timedelta(days=1)).isoformat()
            actions.append({"datetime": f"{next_day} 03:30", "action": "checkout",
                            "location": ot_location,
                            "note": f"{d.strftime('%b%d')} OT CO"})
            pending_ot.append({
                "date": ds, "start": "22:00", "end": "03:30",
                "hours": 5.5, "reason": "task shishin",
            })

        # Sunday OT (full day 14:30→03:30)
        if d.weekday() == 6 and d in sunday_ot_set:
            actions.append({"datetime": f"{ds} 14:30", "action": "checkin",
                            "location": ot_location,
                            "note": "Sun OT full (CI early 1h for break)"})
            next_day = (d + timedelta(days=1)).isoformat()
            actions.append({"datetime": f"{next_day} 03:30", "action": "checkout",
                            "location": ot_location,
                            "note": f"{d.strftime('%b%d')} OT CO"})
            pending_ot.append({
                "date": ds, "start": "14:30", "end": "03:30",
                "hours": 12.0, "reason": "task shishin",
            })

    # Sort actions by datetime
    actions.sort(key=lambda a: a["datetime"])

    return {
        "timezone": "Asia/Tokyo",
        "tolerance_minutes": 180,
        "locations": {
            "office": {"lat": 35.5202417, "lon": 139.620325, "name": "NEC Tamagawa"},
            "home": {"lat": 35.51386, "lon": 139.6749183, "name": "FPT Residence Tsurumi"},
        },
        "actions": actions,
        "pending_ot": pending_ot,
    }


def main():
    default_year, default_month = next_month()

    parser = argparse.ArgumentParser(description="Generate schedule.json for a month")
    parser.add_argument("--year", type=int, default=default_year, help="Year (default: next month's year)")
    parser.add_argument("--month", type=int, default=default_month, help="Month (default: next month)")
    parser.add_argument("--ot-dates", type=str, default="",
                        help="Comma-separated day numbers for night OT (22:00→03:30)")
    parser.add_argument("--sunday-ot", type=str, default="",
                        help="Comma-separated day numbers for Sunday OT (14:30→03:30)")
    parser.add_argument("--location", default="office", choices=["office", "home"],
                        help="Default workday location (default: office)")
    parser.add_argument("--output", type=str, default=None,
                        help="Output file path (default: schedule.json in same dir)")
    args = parser.parse_args()

    ot_dates = parse_day_list(args.ot_dates, args.year, args.month)
    sunday_ot_dates = parse_day_list(args.sunday_ot, args.year, args.month)

    schedule = generate_schedule(
        args.year, args.month,
        ot_dates=ot_dates,
        sunday_ot_dates=sunday_ot_dates,
        location=args.location,
    )

    output_path = args.output or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "schedule.json"
    )

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(schedule, f, indent=2, ensure_ascii=False)

    # Summary
    workdays = sum(1 for a in schedule["actions"] if a["action"] == "checkin" and "workday" in a.get("note", ""))
    night_ot = sum(1 for e in schedule["pending_ot"] if e["start"] == "22:00")
    sunday_ot = sum(1 for e in schedule["pending_ot"] if e["start"] == "14:30")
    total_ot = sum(e["hours"] for e in schedule["pending_ot"])

    print(f"Generated schedule for {args.year}-{args.month:02d}")
    print(f"  Workdays: {workdays}")
    print(f"  Night OT: {night_ot} ({night_ot * 5.5:.1f}h)")
    print(f"  Sunday OT: {sunday_ot} ({sunday_ot * 12.0:.1f}h)")
    print(f"  Total OT: {total_ot:.1f}h")
    print(f"  Actions: {len(schedule['actions'])}")
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    main()
