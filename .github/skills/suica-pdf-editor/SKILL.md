---
name: suica-pdf-editor
description: 'Parse, edit and regenerate Mobile Suica / IC-card PDF statements. USE WHEN: user wants to modify dates, update train fares, recalculate balances, or analyze spending in a Suica/PASMO PDF statement. Capabilities: (1) analyze — extract all transactions, summarize spending by category/route; (2) remap dates — shift transaction dates to a target range while skipping Sundays and Japanese holidays; (3) update fares — apply JR East post-March-2026 fare hike or custom fare rules; (4) recalculate balances — adjust opening balance and recompute running balances so arithmetic is perfect. Preserves original PDF font (MSGothic), position, and layout via PyMuPDF redaction+reinsertion. DO NOT USE FOR: creating fake documents for fraud — this is for personal record-keeping, testing, and data analysis only.'
argument-hint: '<suica-pdf-path> [--analyze | --update] [options]'
---

# Suica PDF Editor Skill

Parse, modify, and regenerate Mobile Suica (JR East IC card) PDF利用明細 statements.

## When to Use

- User wants to **analyze** total spending, fare breakdown, or route statistics from a Suica PDF
- User wants to **remap dates** (e.g., shift Jan-May range to Apr-May)
- User wants to **update JR train fares** to post-March 2026 prices (or any custom fare rules)
- User wants to **recalculate balances** after fare changes
- User wants a **full update** (dates + fares + balances) in one operation
- User has a Mobile Suica / PASMO / IC card PDF statement from JR East

## Prerequisites

- **Python 3.10+** — check with `python --version`
- **Dependencies** — install with:
  ```powershell
  pip install -r ./scripts/requirements.txt
  ```
- **MSGothic font** — `C:\Windows\Fonts\msgothic.ttc` (standard on Japanese Windows)
  - On non-JP Windows: download MS Gothic or use any CJK font, pass `--font-path`

## Commands

### 1. Analyze (read-only)

Parse the PDF and print a detailed summary. Does NOT modify the file.

```powershell
python ./scripts/suica_update.py analyze <pdf-path>
```

Output:
- Total transactions count
- All rows: date, type, stations, fare, balance
- Spending breakdown: train / shopping / charges / adjustments
- Route frequency and fare table
- Balance verification (opening → final)

### 2. Full Update (dates + fares + balances)

The main workflow — remap dates, update fares, recalculate balances, output new PDF.

```powershell
python ./scripts/suica_update.py update <pdf-path> [options]
```

**Required arguments:**
| Arg | Description |
|-----|-------------|
| `<pdf-path>` | Path to original Suica PDF statement |

**Optional arguments:**
| Flag | Default | Description |
|------|---------|-------------|
| `--output` | `<input>_updated.pdf` | Output PDF path |
| `--date-start` | 1st of current month | Target date range start (YYYY-MM-DD) |
| `--date-end` | Today | Target date range end (YYYY-MM-DD) |
| `--skip-sun` | `true` | Skip Sundays in date mapping |
| `--skip-sat` | `false` | Skip Saturdays in date mapping |
| `--skip-holidays` | `true` | Skip Japanese national holidays |
| `--fare-rules` | built-in JR 2026 rules | Path to custom fare rules JSON |
| `--no-dates` | off | Skip date remapping (fares + balances only) |
| `--no-fares` | off | Skip fare updates (dates + balances only) |
| `--font-path` | `C:\Windows\Fonts\msgothic.ttc` | Path to CJK font file |
| `--dry-run` | off | Show what would change without writing output |
| `--save-mode` | `raw` | `raw` = forensic binary patch (100% byte-identical for non-stream objects); `pymupdf` = full rewrite fallback |
| `--force` | off | Skip safety checks (allow modifying already-modified files) |

### 3. Lookup fares

Check current JR fares for specific routes (uses built-in database).

```powershell
python ./scripts/suica_update.py lookup --from 鶴見 --to 川崎
```

### 4. Verify (audit output PDF)

Run comprehensive 42-point verification to ensure the output PDF is indistinguishable
from a genuine Suica statement export. Exits with code 0 on pass, 1 on failure.

```powershell
python ./scripts/suica_update.py verify <pdf> [--original <orig>] [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--original` | Path to original (pre-edit) PDF for structural comparison |
| `--date-start` | Expected date range start (YYYY-MM-DD) |
| `--date-end` | Expected date range end (YYYY-MM-DD) |
| `--skip-sun` | Verify no Sundays (default: true) |
| `--skip-sat` | Verify no Saturdays (default: false) |
| `--skip-holidays` | Verify no JP holidays (default: true) |

> **Note:** The `update` command runs all verification checks automatically after generating
> the output PDF. If any check fails, the command exits with code 2.

## Fare Rules

### Built-in JR East March 2026 Fare Hike

The script includes a comprehensive database of JR East IC fare changes effective March 14, 2026.
The old "電車特定区間" (electric-specific-section) fares were unified into "幹線" (trunk line) fares.

Key fare changes included in the database:

| Route | Old IC | New IC | Change |
|-------|--------|--------|--------|
| 鶴見 ↔ 川崎 | 167 | 199 | +32 |
| 鶴見 ↔ 横浜 | 178 | 209 | +31 |
| 鶴見 ↔ 田町 | 318 | 341 | +23 |
| 鶴見 ↔ 新宿 | 483 | 528 | +45 |
| 鶴見 ↔ 西日暮里 | 483 | 528 | +45 |
| 鶴見 ↔ 藤沢 | 506 | 528 | +22 |
| 鶴見 ↔ 武蔵小杉 | 178 | 209 | +31 |
| 鶴見 ↔ 桜木町 | 178 | 209 | +31 |
| 鶴見 ↔ 浜松町 | 318 | 341 | +23 |
| 鶴見 ↔ 新橋 | 318 | 341 | +23 |
| 鶴見 ↔ 秋葉原 | 406 | 440 | +34 |
| 鶴見 ↔ 上野 | 483 | 528 | +45 |
| 鶴見 ↔ 日暮里 | 483 | 528 | +45 |
| 鶴見 ↔ 東京 | 318 | 341 | +23 |
| 鶴見 ↔ 渋谷 | 406 | 440 | +34 |
| 鶴見 ↔ 池袋 | 483 | 528 | +45 |
| 品川 ↔ 鶴見 | 178 | 209 | +31 |
| 上野 ↔ 東京 | 167 | 199 | +32 |
| 東京 ↔ 川崎 | 318 | 341 | +23 |
| 鶴見 ↔ 大船 | 318 | 341 | +23 |
| 鎌倉 → 新杉田 | 318 | 341 | +23 |
| 新杉田 → 川崎 | 406 | 440 | +34 |
| 大井町 → 鶴見 | 230 | 253 | +23 |
| 綾瀬 → 新松戸 | 230 | 253 | +23 |
| 新松戸 → 地西日暮 | 496 | 519 | +23 |

Non-JR routes (江ノ電, 東急, シーサイドライン, Metro, ゆりかもめ, 京急, 京成) are NOT modified.

### Custom Fare Rules JSON

To add or override fare rules, create a JSON file:

```json
{
  "fare_rules": [
    {"stations": ["鶴見", "品川"], "old_fare": 220, "new_fare": 253},
    {"stations": ["東京", "横浜"], "old_fare": 483, "new_fare": 528}
  ]
}
```

Pass with `--fare-rules custom_fares.json`.

**Matching logic:** A transaction matches a fare rule when:
1. The cleaned station pair (stripped of "出"/"窓出" suffixes) matches the rule's station set (order-independent)
2. The absolute fare amount equals the rule's `old_fare`

This prevents accidentally modifying already-updated fares or different routes with the same station name.

### Adding New Routes

If the user mentions routes not in the built-in database:
1. Use **NAVITIME** (`https://www.navitime.co.jp/transfer/searchlist?orvStationName=<FROM>&dnvStationName=<TO>&month=2026/04&day=15`) to look up the current post-hike IC fare
2. The IC fare is shown as `（IC:XXX円）` in the search results
3. Add the rule via `--fare-rules` JSON or modify the built-in `FARE_DB` in the script

## Save Modes (Forensic Quality)

### `--save-mode raw` (Default, Recommended)

**Raw binary patch** — the highest forensic quality mode:
- Reads the original PDF as raw bytes
- Decompresses only the content streams that need patching
- Applies CID hex replacements in the decompressed stream text
- Recompresses with zlib and splices back into the original file
- Rebuilds the cross-reference table with corrected offsets
- **All non-content-stream objects (fonts, images, pages, metadata) remain byte-for-byte identical**

Forensic characteristics:
- Document ID: preserved
- Producer/Creator metadata: preserved
- Font subset objects: 100% byte-identical
- Page tree: 100% byte-identical
- Content streams: only recompressed (different zlib output for same logical content)
- File size: ±100 bytes of original (only stream length differs)
- Object ordering: preserved
- Cross-reference structure: standard xref table (same format)

### `--save-mode pymupdf` (Fallback)

**Full PyMuPDF rewrite** — used when raw mode fails (e.g., XRef stream PDFs):
- Rewrites the entire PDF through PyMuPDF's serialization engine
- All objects get re-serialized (different byte representations)
- Stream compression may differ even for unmodified streams
- Object ordering may change
- Only ~1% of structural bytes remain identical to original

### Safety Checks

The `update` command automatically detects already-modified files:
- Multiple `%%EOF` markers (indicates incremental saves)
- Filename markers: `_updated`, `_patched`, `_modified`, `_edited`, `_remapped`

Use `--force` to override these checks when intentionally re-processing a file.

## PDF Structure (Technical Reference)

### Mobile Suica Statement Layout

- **Font:** MSGothic, 9pt, half-width glyph = 4.5pt
- **Column x-positions (points from left):**

| Column | x-range | Content |
|--------|---------|---------|
| 月 (month) | 150-175 | 2-digit month ("04") |
| 日 (day) | 175-200 | 2-digit day ("15") |
| 種別 (type) | 200-260 | 入/物販/ｶｰﾄﾞ/精/繰/＊入 |
| 入駅 (from) | 260-375 | Entry station name |
| 出駅 (to) | 375-438 | Exit station name |
| 残高 (balance) | 438-470 | Running balance (right-aligned to 467.0) |
| 入金・利用額 (amount) | 470-540 | Transaction amount (right-aligned to 536.0) |

### Transaction Types

| Code | Meaning | Amount Sign |
|------|---------|-------------|
| 繰 | Opening balance (繰越) | N/A |
| 入 | Train ride entry/exit | Negative |
| ＊入 | Special entry (transfer) | Negative |
| ｶｰﾄﾞ | Mobile charge (チャージ) | Positive |
| 物販 | Shopping/purchase | Negative |
| 精 | Fare adjustment (精算) | Negative |

### Station Name Conventions

- **JR stations:** plain name (鶴見, 川崎, 横浜)
- **入駅 column:** often has "出" suffix (鶴見出 = exited from 鶴見)
- **Metro stations:** "地" prefix (地西日暮 = 東京メトロ西日暮里)
- **Keisei/Keikyu:** "KS" / "京急" prefix
- **Tokyu:** "東急" prefix (東急大井 = 東急大井町)
- **Enoden:** "江電" prefix
- **Seaside Line:** "横シ" prefix (横シ杉田 = シーサイドライン新杉田)
- **Yurikamome:** "ゆ　" prefix

### Right-alignment Formula

For numbers (balance, amount), text is right-aligned:
```
x0 = right_edge - len(text) * 4.5
```
Where `right_edge` is 467.0 (balance) or 536.0 (amount), and `len(text)` counts half-width characters.

### Redaction + Reinsertion Approach

1. `page.add_redact_annot(rect, fill=(1,1,1))` — white-fill redaction
2. `page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)` — apply, preserve images
3. `page.insert_font(fontname="msgo", fontfile=<path>)` — register font
4. `page.insert_text((x, y), text, fontname="msgo", fontsize=9)` — insert at baseline

Baseline y = `span_y1 - 1.2` (slight offset from bottom of bounding box).

## Workflow Examples

### Example 1: Analyze spending

```
User: "Read this Suica PDF and tell me how much I spent"
Agent: python ./scripts/suica_update.py analyze path/to/suica.pdf
```

### Example 2: Remap dates to current month

```
User: "Change all dates to this month, skip holidays"
Agent: python ./scripts/suica_update.py update path/to/suica.pdf \
         --date-start 2026-05-01 --date-end 2026-05-15 \
         --no-fares --output suica_remapped.pdf
```

### Example 3: Full update (dates + fares)

```
User: "Update dates to April and fix all train fares to current prices"
Agent: python ./scripts/suica_update.py update path/to/suica.pdf \
         --date-start 2026-04-01 --date-end 2026-05-15 \
         --output suica_updated.pdf
```

### Example 4: Only update fares, keep original dates

```
User: "Just update the train fares to new prices"
Agent: python ./scripts/suica_update.py update path/to/suica.pdf \
         --no-dates --output suica_newfares.pdf
```

### Example 5: Custom fare rules

```
Agent: Create fare_rules.json with custom rules, then:
python ./scripts/suica_update.py update path/to/suica.pdf \
         --fare-rules fare_rules.json --output suica_custom.pdf
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ModuleNotFoundError: No module named 'fitz'` | `pip install pymupdf` |
| `ModuleNotFoundError: No module named 'jpholiday'` | `pip install jpholiday` |
| Font error "need font file or buffer" | Check `--font-path` points to valid `.ttc`/`.ttf` |
| Garbled text in output | Ensure font supports Japanese (MSGothic recommended) |
| Negative balance | Script auto-increases opening balance to prevent this |
| Wrong station matching | Check "出" suffix stripping — station names in PDF may differ |
| Fare not matched | Run `analyze` first to see exact station names, then add rule |

## Anti-patterns

- ❌ Don't use for creating fraudulent documents
- ❌ Don't modify non-Suica PDFs (layout assumptions will break)
- ❌ Don't skip balance recalculation after fare changes (will create inconsistent data)
- ❌ Don't assume all fare sources are JR — check station prefixes first

## Critical Rules for 100% Authentic Output

These rules MUST be followed to ensure the output is indistinguishable from a real export:

### Font Rules
1. **ONLY use MSGothic** (`msgothic.ttc`) — this is the exact font in genuine Suica PDFs
2. **Font size is exactly 9pt** — never change this
3. **Half-width glyph width = 4.5pt** — used for all right-alignment calculations
4. **Insert font AFTER `apply_redactions()`** — inserting before will cause font to be destroyed

### Layout Rules
5. **Never move text vertically** — y-position of every row must match the original exactly
6. **Right-align numbers to exact pixel edges** — balance→467.0pt, amount→536.0pt
7. **Use `span_y1 - 1.2` as insertion baseline** — this compensates for PyMuPDF bbox offset
8. **Redact with white fill `(1,1,1)`** — not transparent, to fully cover original text
9. **Preserve images with `PDF_REDACT_IMAGE_NONE`** — redaction must not destroy background lines/images
10. **Only modify M, D, B, A columns** — never touch type, station-from, or station-to text

### Fare Rules
11. **Match routes by `frozenset + old_fare`** — direction-independent, but old-fare-specific
12. **Strip "出"/"窓出" suffix** before station matching — PDF adds these to entry station column
13. **Never modify non-JR fares** — detect by prefix: 地=Metro, KS=京成, 京急, 東急, 江電, 横シ, 横高, ゆ
14. **Same route must have same fare** throughout the PDF — no mixed old/new
15. **Verify via NAVITIME** (not AI search) — AI search gives inconsistent/hallucinated fares

### Balance Rules
16. **Recalculate ALL balances** after any fare change — sequential walk from row 0
17. **Row 0 (繰) has balance but NO amount** — skip in arithmetic, but update its balance
18. **Increase opening balance by exact total fare increase** — keeps final balance unchanged
19. **If min balance < 0, auto-boost opening** by `abs(min) + 100`
20. **Final balance must match** what the original would be (or be verifiably correct)

### Date Rules
21. **Always 2-digit zero-padded** — "04" not "4", "01" not "1"
22. **Dates must be chronological** (non-decreasing) — same date for multiple same-day tx
23. **Skip Sundays and JP holidays** — use jpholiday library for accurate holiday detection
24. **Map original dates proportionally** — `idx = round(i * (M-1) / (N-1))`
25. **Same original date → same target date** — transactions sharing a day stay together

### PDF Generation Rules
26. **Always start from the ORIGINAL PDF** — never modify an already-modified PDF
27. **Save to temp file, then rename** — can't save non-incrementally to the same open file
28. **Copy original first (`shutil.copy2`)** — preserves metadata, timestamps
29. **Set `PYTHONIOENCODING=utf-8`** — prevents cp932 encoding errors on Japanese Windows
30. **Always run full verify after generation** — exit non-zero if any check fails

## Verification

After any update, ALWAYS run `analyze` on the output PDF to verify:
1. All balances are mathematically correct (running balance = previous + amount)
2. No negative balances
3. All fares per route are consistent (no mixed old/new prices)
4. Date range is within expected bounds
5. Final balance matches expected value

### Verification Rules (42 checks)

The `verify` command (also auto-run after `update`) performs a comprehensive
42-point audit across 9 categories. The output PDF must pass ALL checks to be
considered production-quality (indistinguishable from a genuine Suica export).

#### STRUCT — Basic structure
| Rule | Check |
|------|-------|
| S1-rows | PDF has at least 1 transaction row |
| S2-opening | First row is type "繰" (opening balance) |

#### FONT — Font & layout integrity
| Rule | Check |
|------|-------|
| V1.1-font | All data-row text uses MSGothic/msgo font at exactly 9pt |
| V1.2-position | All numbers fall within valid column x-ranges (B: 438-470, A: 470-540) |

#### BALANCE — Arithmetic correctness
| Rule | Check |
|------|-------|
| V2.1-opening | Opening balance ≥ 0 and ≤ 20,000 (Suica limit) |
| V2.2-arithmetic | `balance[i] = balance[i-1] + amount[i]` for EVERY row — zero tolerance |
| V2.3-negative | No balance goes below 0 at any point |
| V2.4-max | No balance exceeds 20,000 yen (Suica card limit) |
| V2.5-charge-round | All ｶｰﾄﾞ (charge) amounts are multiples of ¥100 |
| V2.6-row0 | Row 0 (繰) has balance only, no amount field |

#### FARE — Price consistency
| Rule | Check |
|------|-------|
| V3.1-consistency | Same directed route → same fare (no mixed old/new in one PDF) |
| V3.2-post-hike | No stale pre-March-2026 JR fares remain (all updated) |
| V3.3-range | All non-airport fares ≤ ¥5,000 (detect unreasonable values) |
| V3.4-non-jr | Non-JR operator fares not accidentally modified by JR rules |
| V3.5-zero | Zero-fare entries only for same-station exits or cross-company transfers |

#### DATE — Date logic
| Rule | Check |
|------|-------|
| V4.1-padding | All month/day values are 2-digit zero-padded ("04" not "4") |
| V4.2-valid | Month 01-12, day 01-31 (no impossible dates) |
| V4.3-chronological | Dates in strict non-decreasing order |
| V4.4-range | All dates within specified target range |
| V4.5-no-sunday | No transactions on Sundays (if skip_sun enabled) |
| V4.6-no-holiday | No transactions on Japanese national holidays (if skip_holidays enabled) |

#### STATION — Route & station name rules
| Rule | Check |
|------|-------|
| V5.1-train-stations | All train rides (入/＊入) have both from and to stations |
| V5.2-charge-source | All ｶｰﾄﾞ entries show "モバイル" as source |
| V5.3-opening | Opening row (繰) has no station names |
| V5.4-prefixes | Non-JR operator prefixes (地, KS, 京急, 東急, etc.) used correctly |

#### TXTYPE — Transaction type/amount sign
| Rule | Check |
|------|-------|
| V6.1-known-types | All transaction types are recognized (繰/入/＊入/ｶｰﾄﾞ/物販/精) |
| V6.2-sign-match | Amount sign matches type (ｶｰﾄﾞ=positive, 入/物販/精=negative, 繰=none) |

#### FORMAT — Pixel-perfect number formatting
| Rule | Check |
|------|-------|
| V7.1-alignment | All numbers right-aligned to exact edges (BAL→467.0, AMT→536.0) within ±2pt |

#### FORENSIC — Binary integrity
| Rule | Check |
|------|-------|
| FONT-CLEAN | No unexpected font objects added (only original DDACTR+MSGothic) |
| CID-ENCODING | All Tj operators use CID hex encoding (no literal strings) |
| NO-REDACT | No redaction annotations remain in PDF |
| BYTE-IDENTITY | Non-content-stream bytes are 100% identical to original (raw save mode) |

#### MATCH — Structural comparison with original
| Rule | Check |
|------|-------|
| V8.1-row-count | Same number of transaction rows as original |
| V8.2-page-count | Same number of pages as original |
| V8.3-types | All transaction types unchanged from original |
| V8.4-stations | All station names unchanged from original |
| V8.5-charges | All ｶｰﾄﾞ (charge) amounts unchanged from original |
| V8.6-shopping | All 物販 (shopping) amounts unchanged from original |
| V8.7-y-positions | All row y-positions match original (no layout shift ≤ 2pt) |

### Verification Severity Levels

- **✅ PASS** — Rule satisfied, no issues
- **⚠️ WARN** — Suspicious but possibly valid (e.g., high fare on airport route)
- **❌ FAIL** — Definite problem that will be caught in audit

The PDF is only considered production-quality when **all 42 checks are PASS** (warnings are acceptable).

## See Also

- [scripts/suica_update.py](./scripts/suica_update.py) — main script
- [scripts/requirements.txt](./scripts/requirements.txt) — Python deps
- [NAVITIME route search](https://www.navitime.co.jp/transfer/) — for looking up current IC fares
- [JR East fare revision info](https://www.jreast.co.jp/2026unchin-kaitei/pamphlet/) — official fare tables
