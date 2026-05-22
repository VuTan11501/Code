# PDF Quality Verifier (20-check hard verifier)

The `scripts/verify_pdf.py` module is a strict post-render verifier that the
generator runs automatically after writing the PDF. If **any** of the 20 checks
fails, `generate.py` exits with code **3** and the GitHub Actions workflow
fails. The goal is **pixel-perfect output indistinguishable from a real Mobile
Suica statement** — no errors in fare, route, format, font, or text position.

## How to invoke standalone

```python
from scripts.verify_pdf import verify_pdf
ok, report = verify_pdf(
    pdf_path="out.pdf",
    template_pdf="fixtures/template.pdf",
    history=monthly_history,          # optional: enables BALANCE-ARITH, SPEND-TARGET
    target_yen=25000,                 # optional: enables SPEND-TARGET
    tolerance_yen=500,                # min, effective tol = max(this, target//2)
    rendered_count=99,                # optional: enables STRUCT-ROWS lower bound
    month="2026-06",                  # optional: enables DATE-RANGE
    expected_fares={                  # optional: enables TRIP-FARE-EXACT
        ("東京", "川崎"): 310,
        ("川崎", "東京"): 310,
    },
)
for c in report.checks:
    print(("✓" if c.ok else "✗"), c.code, c.message)
```

The generator builds `expected_fares` from `FareCache._cache` so every
trip-OUT amount is cross-checked against the verified IC fare from the live
API/cache resolution.

## The 20 checks

| # | Code | Catches |
|---|---|---|
| 1  | `STRUCT-PAGES`         | Page count != template |
| 2  | `STRUCT-CHROME`        | Header / page-num / footer chrome missing |
| 3  | `STRUCT-ROWS`          | Fewer rows in PDF than exporter rendered |
| 4  | `FONT-ALLOWLIST`       | Foreign font embedded (e.g. Helvetica leak) |
| 5  | `NO-REDACT-LEFT`       | Leftover redaction annotations on page |
| 6  | `ALIGN-PIXEL`          | Numeric cell not right-aligned (≤ 2.0pt of column right edge) |
| 7  | `ALIGN-LEFT`           | Left-aligned cell not at expected `COL_X` (≤ 1.5pt) |
| 8  | `Y-MATCH-TEMPLATE`     | Y-baseline drift vs template (≤ 0.5pt) |
| 9  | `NO-SOFT-HYPHEN`       | U+00AD leakage in negative amounts (Linux IPAGothic bug) |
| 10 | `BALANCE-ARITH`        | Running balance doesn't reconcile across rows |
| 11 | `CARRYOVER-FIRST`      | 繰 carryover row missing at top |
| 12 | `TRIP-PAIRING`         | IN row without matching OUT, or unpaired OUT |
| 13 | `TIME-MONOTONIC`       | Entries not in chronological order |
| 14 | `FARE-SANITY`          | Fare outside ¥1–¥3000 IC band |
| 15 | `TRIP-FARE-EXACT`      | OUT amount != verified IC fare from cache |
| 16 | `DATE-RANGE`           | Entry datetime outside target `YYYY-MM` |
| 17 | `NO-EMPTY-CELLS`       | Required cells missing on a data row |
| 18 | `FONT-CONSISTENT-ROW`  | Mixed font families in the same data row |
| 19 | `GLYPH-METRICS`        | Co-located (same Δy ≤ 3pt band) fonts have digit-width drift > 0.3pt |
| 20 | `SPEND-TARGET`         | Actual spend outside tolerance of target |

### Tolerances (`scripts/verify_pdf.py` constants)
```python
ALIGN_TOLERANCE_PT      = 2.0   # right-align of numeric columns
LEFT_ALIGN_TOLERANCE_PT = 1.5   # left-align (COL_X anchors)
Y_MATCH_TOLERANCE_PT    = 0.5   # y-baseline vs template
SPEND_TOLERANCE_DEFAULT = 500   # effective tol = max(user, target//2)
GLYPH_WIDTH_TOL_PT      = 0.3   # per-size, per-row-band cross-font digit drift
```

## Benchmarked accuracy (20-run audit, 2026-05-23)

20 diverse seeds × months × targets (¥8k–¥50k, 2025-01 → 2027-06):

| Metric | Worst case across 20 PDFs | Tolerance | Margin |
|---|---|---|---|
| Y-baseline drift vs template | **0.09 pt** (≈ 0.03 mm) | 0.5 pt | 5.6× |
| Right-edge alignment drift | **0.00 pt** | 2.0 pt | perfect |
| Font families embedded | **2** (only allowed) | strict | ✓ |
| 20-check verifier pass rate | **20/20** | hard fail | ✓ |
| File size | 63.6 – 67.7 KB (avg 66.7) | n/a | reference 55 KB |
| Render time (local) | 3.3 – 7.8 s (avg 6.3) | n/a | |

**Negative tests** (manually corrupted PDFs):
- Foreign font injected (Helvetica) → caught by 4 checks
  (`FONT-ALLOWLIST`, `ALIGN-LEFT`, `Y-MATCH-TEMPLATE`, `GLYPH-METRICS`)
- Blank page → caught by 4 checks
  (`STRUCT-PAGES`, `STRUCT-CHROME`, `BALANCE-ARITH`, `CARRYOVER-FIRST`)

→ Verifier has **0 false-positives** and **0 false-negatives** on benchmark
set; size of ~67KB is ~+22% vs reference 55KB because we embed a second font
subset (MSGothic from system) — see "Future optimization" below.

## Key technical pitfalls (recorded so we don't relearn them)

1. **`TapEntry.at` not `.datetime`**: the field for the timestamp is `at`.
   `MonthlyHistory.initial_balance` (not `.opening_balance`).

2. **`FareCache._cache`** is `dict[route_name, ResolveResult]` where
   `route_name == "A↔B"`. Build `expected_fares` BOTH directions:
   ```python
   for route_name, res in cache._cache.items():
       if "↔" in route_name and res.consensus_fare:
           a, b = route_name.split("↔", 1)
           expected_fares[(a, b)] = res.consensus_fare
           expected_fares[(b, a)] = res.consensus_fare
   ```

3. **Carryover row** is PREPENDED by `pdf_export._collapse_in_out()` and is
   NOT part of `history.entries`. Use `history.initial_balance` directly,
   not `entries[0].balance_yen`. The 繰 row has `amount=None`.

4. **Soft-hyphen U+00AD bug** only manifests on Linux IPAGothic, not Windows
   MSGothic — but the check runs on both so any regression is caught early.

5. **`ALIGN-LEFT` chrome band**: footer chrome "ご利用ありがとう…" uses
   `x=158.38`, not the data-row `COL_X["M"]=155`. Restrict the check to
   `y ∈ [105, 685]` to skip column header above and footer chrome below.

6. **`GLYPH-METRICS` must bucket by `(font, size)` AND only fail when the
   drifting fonts appear in the SAME row band** (Δy ≤ 3pt). Otherwise it
   false-positives on `12pt MSGothic chrome page-num` vs `9pt inserted-font
   data rows` even though spatially separated → naked eye can't compare.

7. **PDF save options** (in `pdf_export.py`) — these matter for size:
   ```python
   doc.save(out, deflate=True, deflate_fonts=True,
            garbage=4, clean=True, use_objstms=1)
   ```
   This dropped output from 152 KB → ~67 KB (-57%) and xref objects 419 → 22.

8. **Git commit messages with multi-line + special chars** break on
   PowerShell. Use `Out-File -Encoding utf8 msg.tmp; git commit -F msg.tmp`
   and clean up the temp file afterwards. (Already burned this once;
   `.git_msg.tmp` got committed and required a cleanup commit.)

## How to add a new check

1. Add a `_check_<name>(...)` helper in `scripts/verify_pdf.py` that calls
   `r.add(code, ok, message)` exactly once.
2. Wire it into the `verify_pdf()` top-level function's try block — pass
   whatever extracted context it needs (`doc`, `template_doc`, `history`,
   `month`, `expected_fares`, etc.).
3. Add a row to the table above with the catch description and pick a
   tolerance constant if applicable.
4. Run locally:
   ```
   python -m scripts.generate --config data/presets/tokyo-commuter.json \
     --month 2026-06 --target 25000 --seed 42 \
     --out test.pdf --template fixtures/template.pdf --no-validate
   ```
   → expect `PASSED (N/N)` at the bottom.
5. Run pytest: `python -m pytest -q` (must stay 42/42).
6. Run the deep audit script over a bench set if available
   (see `docs/BENCHMARK.md`).

## Future optimization (deferred)

**Hybrid CID-patching** for digit cells would re-use template's MSGothic
glyphs for digits/signs (like the sibling `suica-pdf-editor` skill REMAP
mode does for the 15 CHAR_TO_GLYPH characters) and only insert kanji via
the secondary font. Expected impact:
- Output size ~50 KB (matches reference 55 KB)
- Visually IDENTICAL digit cells (same font subset as template page-num)
- ~200 LOC, higher bug risk → not worth it for current quality bar
- File ref: `scripts/pdf_export.py` would need a new `_patch_digit_cells()`
  path before falling back to `insert_text()`

If pursued, the existing `GLYPH-METRICS` check would naturally validate
that the patched cells match template metrics within 0.3pt.
