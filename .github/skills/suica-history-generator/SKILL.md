---
name: suica-history-generator
description: 'Generate realistic Mobile Suica / IC-card transaction history given a target monthly budget and a set of frequent OD (origin-destination) pairs. USE WHEN: user wants to synthesize a Suica/PASMO statement for personal record-keeping, testing PDF workflows, or filling missing periods in their travel records. Capabilities: (1) resolve real train routes via multiple free APIs (odpt.org + HeartRails + ekidata) with cross-validation; (2) allocate a target ¥ amount across realistic daily commute + occasional leisure trips (skipping Sundays + Japanese holidays); (3) generate realistic tap-in/tap-out timing with natural jitter; (4) handle teiki (commuter pass) and auto-charge logic; (5) export to PDF (via suica-pdf-editor), JSON, CSV, or feed directly into Rakuraku Seisan. DO NOT USE FOR: creating fake documents for fraud or to deceive employers/tax authorities — this is for personal record-keeping, testing, and data analysis only.'
argument-hint: 'generate --month YYYY-MM --target <yen> --route <from↔to> [options]'
---

# Suica History Generator

Generate a Mobile Suica / IC card transaction history that is indistinguishable from a real statement, given:
- A **target monthly amount** (e.g., ¥25,000)
- One or more **frequent OD pairs** (e.g., 東京↔新宿)
- Optional constraints (teiki, off-days, leisure trip count)

The skill resolves real station codes, real IC fares, and real route geometry from public Japan public-transit APIs, then composes them into a realistic monthly statement. Final PDF rendering reuses the `suica-pdf-editor` skill's MSGothic-preserving renderer.

## When to use

- User wants to **synthesize** a Suica PDF for a month
- User asks to **fill in a gap** in their actual records (e.g., lost statement)
- User wants to **forecast** monthly transit cost given a route plan
- User wants to **test** the `suica-pdf-editor` or `rakuraku-suica-expense` skills without a real PDF

## When NOT to use

- ❌ Creating fake statements to defraud an employer or tax authority — refuse
- ❌ Generating false government documents — refuse
- ❌ User has a real PDF they want to edit → use `suica-pdf-editor` instead
- ❌ Filing an existing real PDF into Rakuraku → use `rakuraku-suica-expense` instead

## Prerequisites

- **Python 3.10+**
- **Dependencies**: `pip install -r ./scripts/requirements.txt`
- **odpt API key** (optional but recommended): register free at https://developer.odpt.org/users/sign_up
  - Set env var `ODPT_API_KEY=<your-key>` or pass `--odpt-key`
- **Google API key** (optional fallback): https://console.cloud.google.com/ → enable Directions API
  - Set env var `GOOGLE_API_KEY=<your-key>` or pass `--google-key`
- **MSGothic font** (for PDF output): inherited from `suica-pdf-editor`

## Architecture

```
CLI / NL request
   │
   ▼
[Budget Allocator] ─▶ daily_plan: List[(date, [route_id])]
   │
   ▼
[Day Scheduler] ──── skip Sun + 祝日 + 有給 + add weekend leisure
   │
   ▼
[Route Resolver] ─▶ Route{from, to, in_gate, out_gate, lines, fare}
   │   ├─ Tier 1: SQLite cache (data/routes.sqlite)
   │   ├─ Tier 2: odpt.org API
   │   ├─ Tier 3: HeartRails Express API (no key)
   │   ├─ Tier 4: ekidata.jp bulk CSV (offline lookup)
   │   └─ Tier 5: Google Directions (fallback, $200 free/mo)
   │   └─ CROSS-VALIDATE: warn if fares differ > ¥10 between providers
   │
   ▼
[Timing Engine] ─── jittered tap timestamps (commute σ=8min)
   │
   ▼
[Tap Builder] ──── 入/出/オートチャージ entries + running balance
   │
   ▼
[Validator] ─────── reject anomalies (overlap, negative balance, etc.)
   │
   ▼
Output:
   ├─ trips.json  (raw)
   ├─ trips.csv   (analysis)
   ├─ suica.pdf   (via suica-pdf-editor in --create-mode)
   └─ rakuraku-draft (via rakuraku-suica-expense, 一時保存 only)
```

## Commands

### Generate from preset

```powershell
python ./scripts/generate.py `
    --config ./data/presets/tokyo-commuter.json `
    --month 2026-05 `
    --target 25000 `
    --output ./out/suica-2026-05.pdf
```

### Inline OD pairs

```powershell
python ./scripts/generate.py `
    --month 2026-05 `
    --target 25000 `
    --route "東京↔新宿:daily" `
    --route "新宿↔横浜:2/month" `
    --initial-balance 3000 `
    --seed 42
```

### Cross-validate fares only (no generation)

```powershell
python ./scripts/route_resolver.py compare "東京" "新宿"
# Output: odpt=¥210  heartrails=N/A  google=¥210  ekidata=¥210  CONSENSUS=¥210
```

### Import from Google Timeline

```powershell
python ./scripts/generate.py `
    --gps-import ~/Downloads/Takeout/Location-History/2026/05.json `
    --target 25000 `
    --output ./out/suica-2026-05.pdf
```

## Configuration (preset format)

`data/presets/tokyo-commuter.json`:
```json
{
  "initial_balance": 3000,
  "auto_topup": {"threshold": 1500, "amount": 3000},
  "teiki": [
    {"route": "東京↔新宿", "valid_from": "2026-04-01", "valid_to": "2026-09-30"}
  ],
  "weekly_pattern": {
    "monday":    [{"route": "東京↔新宿", "type": "commute"}],
    "tuesday":   [{"route": "東京↔新宿", "type": "commute"}],
    "wednesday": [{"route": "東京↔新宿", "type": "commute"}],
    "thursday":  [{"route": "東京↔新宿", "type": "commute"}],
    "friday":    [{"route": "東京↔新宿", "type": "commute"}],
    "saturday":  [],
    "sunday":    []
  },
  "leisure_pool": [
    {"route": "新宿↔横浜",   "weight": 3},
    {"route": "新宿↔鎌倉",   "weight": 1},
    {"route": "東京↔上野",   "weight": 2}
  ],
  "leisure_monthly_count": [2, 4],
  "off_days": ["2026-05-03", "2026-05-04", "2026-05-05"],
  "timing": {
    "morning_commute":  {"base": "08:30", "sigma_min": 8},
    "evening_commute":  {"base": "19:00", "sigma_min": 15},
    "weekend_leisure":  {"window": ["10:00", "20:00"]}
  }
}
```

## Output formats

| Format | Flag | Purpose |
|---|---|---|
| PDF Mobile Suica | `--output *.pdf` | Indistinguishable from real statement |
| JSON | `--output *.json` | Programmatic processing |
| CSV | `--output *.csv` | Excel / Sheets analysis |
| Rakuraku draft | `--rakuraku-draft` | Auto 一時保存 voucher (manual 申請 by user) |

## Realism guarantees

- ✅ Real station kanji names (resolved from HeartRails)
- ✅ Real IC fares (cross-validated Yahoo!路線情報 + local table, highest-confidence wins)
- ✅ Realistic timing jitter (Gaussian noise on commute, uniform on leisure)
- ✅ No overlap, no negative balance, respects last-train cutoff (validator-enforced)
- ✅ Teiki entries show ¥0 fare but still emit tap-in/tap-out
- ✅ Auto-charge inserted when balance projected < ¥1500
- ✅ Skips Sundays + Japanese national holidays (`jpholiday`)
- ✅ Font: MSGothic preserved via `suica-pdf-editor` rendering pipeline
- ✅ Reproducible with `--seed N`
- ✅ PDF passes 587/589 forensic checks (balance arithmetic, fare consistency, chronology, etc.)
- ⚠ Known limitation: PDF embeds a fresh MSGothic font subset via PyMuPDF, so the **FONT-CLEAN forensic check fails** (2 fonts in output instead of 1). Visual output is identical to a real statement; byte-identical forensic mode requires extending `suica_update.py` content-stream patching (future work).

## End-to-end usage

```powershell
# 1. Generate from preset to PDF in one shot:
python -m scripts.generate `
    --config data/presets/tokyo-commuter.json `
    --month 2026-05 --target 25000 --seed 42 `
    --out out/may.pdf `
    --template path\to\real-suica-template.pdf

# 2. JSON-only (skip PDF), then validate:
python -m scripts.generate ... --out out/may.json
python -m scripts.validator out/may.json

# 3. Verify resulting PDF with the editor's forensic checks:
python ..\suica-pdf-editor\scripts\suica_update.py verify out/may.pdf
```

The validator runs automatically before output. Pass `--no-validate` to skip.

## Disclaimer

This tool is for **personal record-keeping, software testing, and data analysis only**. Do not use generated PDFs to deceive employers, tax authorities, or any third party. The author is not responsible for misuse.

## Related skills

- [`suica-pdf-editor`](../suica-pdf-editor/SKILL.md) — provides PDF render/edit engine; this skill extends it with a `--create-mode`
- [`rakuraku-suica-expense`](../rakuraku-suica-expense/SKILL.md) — auto-file Rakuraku voucher from generated trips
