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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ot_gist import load_ot_from_gist  # noqa: E402

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
    """Render monthly OT report as shadcn/ui dark-themed HTML email."""
    BG = "#0a0a0a"
    CARD = "#0f0f0f"
    BORDER = "#262626"
    FG = "#fafafa"
    MUTED = "#a3a3a3"
    MUTED_BG = "#171717"

    if not report:
        return f'<!DOCTYPE html><html><body style="background:{BG};color:{MUTED};font-family:-apple-system,sans-serif;padding:40px;text-align:center;">No OT entries found for this month.</body></html>'

    # Entry rows
    entry_rows = ""
    for e in report["entries"]:
        cats = ", ".join(f"{RATES[c]['label']} {h:.1f}h" for c, h in e["breakdown"].items())
        entry_rows += f'''<tr style="border-bottom:1px solid {BORDER};">
            <td style="padding:9px 8px;color:{FG};font:13px ui-monospace,SFMono-Regular,Consolas,monospace;">{e['date']}</td>
            <td style="padding:9px 8px;color:{MUTED};font-size:12px;">{e['day']}</td>
            <td style="padding:9px 8px;color:{MUTED};font:12px ui-monospace,SFMono-Regular,Consolas,monospace;">{e['start']}→{e['end']}</td>
            <td style="padding:9px 8px;text-align:right;color:{FG};font:600 13px ui-monospace,SFMono-Regular,Consolas,monospace;">{e['hours']:.1f}h</td>
            <td style="padding:9px 8px;font-size:11px;color:{MUTED};">{cats}</td>
        </tr>'''

    # Rate breakdown rows
    summary_rows = ""
    for cat, info in RATES.items():
        hours = report["totals"][cat]
        if hours > 0:
            pay = hours * info["rate"] * BASE_HOURLY
            summary_rows += f'''<tr style="border-bottom:1px solid {BORDER};">
                <td style="padding:10px 8px;color:{FG};font-size:13px;">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:{info['color']};margin-right:10px;vertical-align:middle;"></span>{info['label']}
                </td>
                <td style="padding:10px 8px;text-align:right;color:{FG};font:13px ui-monospace,SFMono-Regular,Consolas,monospace;">{hours:.1f}h</td>
                <td style="padding:10px 8px;text-align:right;color:{MUTED};font:13px ui-monospace,SFMono-Regular,Consolas,monospace;">×{info['rate']:.0%}</td>
                <td style="padding:10px 8px;text-align:right;color:{FG};font:600 13px ui-monospace,SFMono-Regular,Consolas,monospace;">¥{pay:,.0f}</td>
            </tr>'''

    month_label = f"{year}-{month:02d}" if year and month else "Current"

    def stat_card(label, value, color=FG):
        return f'''<td width="33%" style="padding:0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;">
          <tr><td style="padding:16px 14px;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:{MUTED};margin-bottom:6px;">{label}</div>
            <div style="font:700 24px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:-0.02em;color:{color};">{value}</div>
          </td></tr></table></td>'''

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:{BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{FG};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG}" style="background:{BG};">
<tr><td align="center" style="padding:24px 12px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:{CARD};border:1px solid {BORDER};border-radius:12px;overflow:hidden;">

  <tr><td style="padding:24px 24px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.25);border-radius:9999px;padding:4px 12px;color:#a78bfa;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Monthly Report</td>
    </tr></table>
    <h1 style="margin:14px 0 4px;font-size:24px;font-weight:700;letter-spacing:-0.01em;color:{FG};">OT Summary · {month_label}</h1>
    <p style="margin:0;color:{MUTED};font-size:13px;">Overtime hours and estimated premium pay</p>
  </td></tr>

  <!-- Stats -->
  <tr><td style="padding:20px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      {stat_card('Total Hours', f"{report['total_hours']:.1f}h", '#4ade80')}
      {stat_card('Entries', len(report['entries']), FG)}
      {stat_card('Premium', f"¥{report['premium']:,}", '#a78bfa')}
    </tr></table>
  </td></tr>

  <!-- Rate breakdown -->
  <tr><td style="padding:24px 24px 0;">
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:{MUTED};margin-bottom:10px;">Rate breakdown</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {BORDER};border-radius:8px;overflow:hidden;">
      <thead><tr style="background:{MUTED_BG};">
        <th style="padding:10px 8px;text-align:left;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Category</th>
        <th style="padding:10px 8px;text-align:right;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Hours</th>
        <th style="padding:10px 8px;text-align:right;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Rate</th>
        <th style="padding:10px 8px;text-align:right;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Amount</th>
      </tr></thead>
      <tbody>{summary_rows}
        <tr style="background:{MUTED_BG};">
          <td style="padding:12px 8px;color:{FG};font-weight:700;font-size:13px;">Total</td>
          <td style="padding:12px 8px;text-align:right;color:{FG};font:700 13px ui-monospace,SFMono-Regular,Consolas,monospace;">{report['total_hours']:.1f}h</td>
          <td></td>
          <td style="padding:12px 8px;text-align:right;color:#4ade80;font:700 15px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:-0.01em;">¥{report['total_pay']:,}</td>
        </tr>
      </tbody>
    </table>
  </td></tr>

  <!-- Detail entries -->
  <tr><td style="padding:24px 24px 0;">
    <details>
      <summary style="cursor:pointer;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:{MUTED};margin-bottom:10px;">OT entries · {len(report['entries'])} rows</summary>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border:1px solid {BORDER};border-radius:8px;overflow:hidden;">
        <thead><tr style="background:{MUTED_BG};">
          <th style="padding:9px 8px;text-align:left;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Date</th>
          <th style="padding:9px 8px;text-align:left;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Day</th>
          <th style="padding:9px 8px;text-align:left;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Time</th>
          <th style="padding:9px 8px;text-align:right;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Hours</th>
          <th style="padding:9px 8px;text-align:left;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Category</th>
        </tr></thead>
        <tbody>{entry_rows}</tbody>
      </table>
    </details>
  </td></tr>

  <tr><td style="padding:20px 24px;border-top:1px solid {BORDER};background:#080808;margin-top:20px;">
    <div style="color:#737373;font-size:11px;letter-spacing:0.02em;">Auto OT Report · GitHub Actions · Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}</div>
  </td></tr>
</table>

</td></tr></table></body></html>'''


def main():
    parser = argparse.ArgumentParser(description="Generate monthly OT report")
    parser.add_argument("--year", type=int, default=None, help="Year (default: from schedule)")
    parser.add_argument("--month", type=int, default=None, help="Month (default: from schedule)")
    args = parser.parse_args()

    # Allow override from env (for GitHub Actions workflow_dispatch)
    year = args.year or (int(os.environ["INPUT_YEAR"]) if os.environ.get("INPUT_YEAR") else None)
    month = args.month or (int(os.environ["INPUT_MONTH"]) if os.environ.get("INPUT_MONTH") else None)

    # Load schedule from Gist (authoritative) with schedule.json fallback
    def _log(m): print(m, file=sys.stderr)
    gist_pending = load_ot_from_gist(log=_log)

    sched_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
    with open(sched_path, encoding="utf-8") as f:
        schedule = json.load(f)

    if gist_pending is not None:
        schedule["pending_ot"] = gist_pending
        print(f"☁️ OT source: Gist ({len(gist_pending)} entries)", file=sys.stderr)
    else:
        print(f"📂 OT source: schedule.json ({len(schedule.get('pending_ot', []))} entries)",
              file=sys.stderr)

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
