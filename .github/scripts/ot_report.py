#!/usr/bin/env python3
"""Generate monthly OT report from schedule.json.

Calculates total OT hours by category and applies rate multipliers:
  - Sunday Night (22:00-05:00 on Sunday): 160%
  - Any Night (22:00-05:00 non-Sunday):   150%
  - Sunday Day (daytime on Sunday):        135%
  - Weekday/Saturday:                      125%

Outputs email-friendly HTML to stdout.
Zero external dependencies (stdlib only).
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

RATES = {
    "sunday_night": {"label": "Sunday Night (22-05)", "rate": 1.60, "color": "#dc2626"},
    "any_night": {"label": "Night OT (22-05)", "rate": 1.50, "color": "#ea580c"},
    "sunday_day": {"label": "Sunday Day", "rate": 1.35, "color": "#d97706"},
    "weekday_sat": {"label": "Weekday/Saturday", "rate": 1.25, "color": "#2563eb"},
}

BASE_HOURLY = 1600  # Base hourly rate in JPY (example, adjustable)


def classify_ot_entry(entry):
    """Classify an OT entry into rate categories. Returns dict of {category: hours}."""
    d = date.fromisoformat(entry["date"])
    start_h, start_m = map(int, entry["start"].split(":"))
    end_h, end_m = map(int, entry["end"].split(":"))
    total_hours = entry["hours"]
    is_sunday = d.weekday() == 6

    # Build minute-by-minute timeline
    start_dt = datetime(d.year, d.month, d.day, start_h, start_m)
    if end_h < start_h or (end_h == start_h and end_m < start_m):
        end_date = d + timedelta(days=1)
    else:
        end_date = d
    end_dt = datetime(end_date.year, end_date.month, end_date.day, end_h, end_m)

    total_minutes = int((end_dt - start_dt).total_seconds() / 60)
    if total_minutes <= 0:
        return {}

    night_minutes = 0
    day_minutes = 0

    for m in range(total_minutes):
        h = (start_dt + timedelta(minutes=m)).hour
        if h >= 22 or h < 5:
            night_minutes += 1
        else:
            day_minutes += 1

    # Scale to match reported hours (may differ from raw minutes due to breaks)
    scale = total_hours / (total_minutes / 60) if total_minutes > 0 else 1.0
    night_hours = round((night_minutes / 60) * scale, 2)
    day_hours = round((day_minutes / 60) * scale, 2)

    result = {}
    if is_sunday:
        if night_hours > 0:
            result["sunday_night"] = night_hours
        if day_hours > 0:
            result["sunday_day"] = day_hours
    else:
        if night_hours > 0:
            result["any_night"] = night_hours
        if day_hours > 0:
            result["weekday_sat"] = day_hours

    return result


def generate_report(schedule, year=None, month=None):
    """Generate OT report data from schedule."""
    pending_ot = schedule.get("pending_ot", [])
    if not pending_ot:
        return None

    # Filter by year/month if specified
    if year and month:
        prefix = f"{year}-{month:02d}"
        pending_ot = [e for e in pending_ot if e["date"].startswith(prefix)]

    totals = {cat: 0.0 for cat in RATES}
    entries = []

    for entry in pending_ot:
        breakdown = classify_ot_entry(entry)
        d = date.fromisoformat(entry["date"])
        day_name = DAY_NAMES[d.weekday()]

        entry_info = {
            "date": entry["date"],
            "day": day_name,
            "start": entry["start"],
            "end": entry["end"],
            "hours": entry["hours"],
            "breakdown": breakdown,
        }
        entries.append(entry_info)

        for cat, hours in breakdown.items():
            totals[cat] += hours

    total_hours = sum(totals.values())
    total_pay = sum(totals[cat] * RATES[cat]["rate"] * BASE_HOURLY for cat in RATES)
    base_pay = total_hours * BASE_HOURLY

    return {
        "entries": entries,
        "totals": totals,
        "total_hours": round(total_hours, 2),
        "base_pay": base_pay,
        "total_pay": round(total_pay),
        "premium": round(total_pay - base_pay),
    }


def render_html(report, year, month):
    """Render report as email-friendly HTML."""
    if not report:
        return "<html><body><p>No OT entries found for this month.</p></body></html>"

    # Entry rows
    entry_rows = ""
    for i, e in enumerate(report["entries"]):
        bg = "#f9fafb" if i % 2 == 0 else "#ffffff"
        cats = ", ".join(
            f"{RATES[c]['label']} {h:.1f}h" for c, h in e["breakdown"].items()
        )
        entry_rows += f"""<tr style="background:{bg};">
            <td style="padding:8px 12px;">{e['date']}</td>
            <td style="padding:8px 12px;">{e['day']}</td>
            <td style="padding:8px 12px;">{e['start']}→{e['end']}</td>
            <td style="padding:8px 12px;text-align:right;font-weight:600;">{e['hours']:.1f}h</td>
            <td style="padding:8px 12px;font-size:12px;color:#6b7280;">{cats}</td>
        </tr>"""

    # Summary rows
    summary_rows = ""
    for cat, info in RATES.items():
        hours = report["totals"][cat]
        if hours > 0:
            pay = hours * info["rate"] * BASE_HOURLY
            summary_rows += f"""<tr>
                <td style="padding:8px 12px;">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:{info['color']};margin-right:8px;"></span>
                    {info['label']}
                </td>
                <td style="padding:8px 12px;text-align:right;">{hours:.1f}h</td>
                <td style="padding:8px 12px;text-align:right;">×{info['rate']:.0%}</td>
                <td style="padding:8px 12px;text-align:right;font-weight:600;">¥{pay:,.0f}</td>
            </tr>"""

    month_label = f"{year}-{month:02d}" if year and month else "Current"

    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:640px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1e40af,#7c3aed);padding:24px;text-align:center;">
    <div style="font-size:40px;">📊</div>
    <div style="color:#fff;font-size:22px;font-weight:700;margin-top:8px;">Monthly OT Report</div>
    <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:4px;">{month_label}</div>
  </div>

  <!-- Summary Cards -->
  <div style="display:flex;padding:20px 24px;gap:12px;">
    <div style="flex:1;background:#f0fdf4;border-radius:8px;padding:16px;text-align:center;">
      <div style="color:#16a34a;font-size:12px;font-weight:600;text-transform:uppercase;">Total Hours</div>
      <div style="font-size:28px;font-weight:700;margin-top:4px;">{report['total_hours']:.1f}h</div>
    </div>
    <div style="flex:1;background:#eff6ff;border-radius:8px;padding:16px;text-align:center;">
      <div style="color:#2563eb;font-size:12px;font-weight:600;text-transform:uppercase;">Entries</div>
      <div style="font-size:28px;font-weight:700;margin-top:4px;">{len(report['entries'])}</div>
    </div>
    <div style="flex:1;background:#faf5ff;border-radius:8px;padding:16px;text-align:center;">
      <div style="color:#7c3aed;font-size:12px;font-weight:600;text-transform:uppercase;">OT Premium</div>
      <div style="font-size:28px;font-weight:700;margin-top:4px;">¥{report['premium']:,}</div>
    </div>
  </div>

  <!-- Rate Breakdown -->
  <div style="padding:0 24px 20px;">
    <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:12px;">Rate Breakdown</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="border-bottom:2px solid #e5e7eb;">
        <th style="padding:8px 12px;text-align:left;color:#6b7280;">Category</th>
        <th style="padding:8px 12px;text-align:right;color:#6b7280;">Hours</th>
        <th style="padding:8px 12px;text-align:right;color:#6b7280;">Rate</th>
        <th style="padding:8px 12px;text-align:right;color:#6b7280;">Amount</th>
      </tr>
      {summary_rows}
      <tr style="border-top:2px solid #1e293b;font-weight:700;">
        <td style="padding:10px 12px;">Total</td>
        <td style="padding:10px 12px;text-align:right;">{report['total_hours']:.1f}h</td>
        <td style="padding:10px 12px;"></td>
        <td style="padding:10px 12px;text-align:right;font-size:16px;">¥{report['total_pay']:,}</td>
      </tr>
    </table>
  </div>

  <!-- Detail Table -->
  <div style="padding:0 24px 20px;">
    <details>
      <summary style="cursor:pointer;font-size:14px;font-weight:600;color:#374151;margin-bottom:12px;">
        OT Entries Detail ({len(report['entries'])} entries)
      </summary>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;">
        <tr style="border-bottom:2px solid #e5e7eb;">
          <th style="padding:6px 12px;text-align:left;color:#6b7280;">Date</th>
          <th style="padding:6px 12px;text-align:left;color:#6b7280;">Day</th>
          <th style="padding:6px 12px;text-align:left;color:#6b7280;">Time</th>
          <th style="padding:6px 12px;text-align:right;color:#6b7280;">Hours</th>
          <th style="padding:6px 12px;text-align:left;color:#6b7280;">Category</th>
        </tr>
        {entry_rows}
      </table>
    </details>
  </div>

  <!-- Footer -->
  <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;">
    <span style="color:#9ca3af;font-size:11px;">🤖 Auto OT Report • GitHub Actions • Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}</span>
  </div>

</div></body></html>"""


def main():
    parser = argparse.ArgumentParser(description="Generate monthly OT report")
    parser.add_argument("--year", type=int, default=None, help="Year (default: from schedule)")
    parser.add_argument("--month", type=int, default=None, help="Month (default: from schedule)")
    args = parser.parse_args()

    # Allow override from env (for GitHub Actions workflow_dispatch)
    year = args.year or (int(os.environ["INPUT_YEAR"]) if os.environ.get("INPUT_YEAR") else None)
    month = args.month or (int(os.environ["INPUT_MONTH"]) if os.environ.get("INPUT_MONTH") else None)

    # Load schedule
    sched_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
    with open(sched_path, encoding="utf-8") as f:
        schedule = json.load(f)

    # Auto-detect year/month from first pending_ot entry if not specified
    if not year or not month:
        pending = schedule.get("pending_ot", [])
        if pending:
            first_date = date.fromisoformat(pending[0]["date"])
            year = year or first_date.year
            month = month or first_date.month
        else:
            today = date.today()
            year = year or today.year
            month = month or today.month

    report = generate_report(schedule, year, month)

    if not report:
        print("<html><body><p>No OT entries found.</p></body></html>")
        return

    # Print summary to stderr for logging
    print(f"OT Report for {year}-{month:02d}", file=sys.stderr)
    print(f"  Total hours: {report['total_hours']:.1f}h", file=sys.stderr)
    print(f"  Entries: {len(report['entries'])}", file=sys.stderr)
    for cat, info in RATES.items():
        hours = report["totals"][cat]
        if hours > 0:
            print(f"  {info['label']}: {hours:.1f}h × {info['rate']:.0%}", file=sys.stderr)
    print(f"  Total pay: ¥{report['total_pay']:,}", file=sys.stderr)
    print(f"  OT premium: ¥{report['premium']:,}", file=sys.stderr)

    # Output HTML to stdout (use UTF-8 for emoji support)
    html = render_html(report, year, month)
    sys.stdout.buffer.write(html.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
