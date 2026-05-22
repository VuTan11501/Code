# Benchmarking the Suica PDF generator

Repeatable harness to validate **pixel-perfect accuracy** across many seeds,
months, and budgets at once. Use whenever you change `pdf_export.py`,
`verify_pdf.py`, or the underlying fare/route resolvers.

## Quick: single-case smoke

```powershell
cd C:\path\to\Code\.github\skills\suica-history-generator
python -m scripts.generate `
  --config data/presets/tokyo-commuter.json `
  --month 2026-06 --target 25000 --seed 42 `
  --out C:\Users\Admin\Downloads\smoke.pdf `
  --template fixtures/template.pdf --no-validate
```

Expect at the bottom:
```
PDF verification PASSED (20/20 checks)
```
Exit code **0** = all 20 checks pass. Exit code **3** = at least one failed.

## 20-case stress harness (PowerShell)

Drives 20 distinct `(month, target, seed)` triples and tabulates results.

```powershell
$ROOT = "C:\path\to\Code\.github\skills\suica-history-generator"
$OUT  = "C:\Users\Admin\Downloads\bench20"
cd $ROOT; New-Item -ItemType Directory -Path $OUT -Force | Out-Null

$months  = @("2025-01","2025-04","2025-07","2025-10","2025-12",
             "2026-01","2026-02","2026-03","2026-04","2026-05",
             "2026-06","2026-07","2026-08","2026-09","2026-10",
             "2026-11","2026-12","2027-01","2027-03","2027-06")
$targets = @(8000,12000,15000,18000,20000,22000,24000,26000,28000,30000,
             32000,34000,36000,40000,45000,50000,10000,17000,29000,38000)
$seeds   = @(1,3,7,11,17,23,42,77,99,128,256,512,777,888,999,1234,2024,2026,3141,9999)

$results = @()
for ($i=0; $i -lt 20; $i++) {
  $m=$months[$i]; $t=$targets[$i]; $s=$seeds[$i]
  $pdf="$OUT\b$m.pdf"
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $log=python -m scripts.generate `
    --config data/presets/tokyo-commuter.json `
    --month $m --target $t --seed $s --out $pdf `
    --template fixtures/template.pdf --no-validate 2>&1
  $sw.Stop()
  $passed=($log|Select-String "PASSED \((\d+)/(\d+)").Matches.Groups
  $size=if(Test-Path $pdf){[math]::Round((Get-Item $pdf).Length/1KB,1)}else{0}
  $results+=[PSCustomObject]@{
    N=$i+1; Month=$m; Seed=$s; Target=$t
    Exit=$LASTEXITCODE; KB=$size
    Sec=[math]::Round($sw.Elapsed.TotalSeconds,1)
    Status=if($passed){"PASS $($passed[1])/$($passed[2])"}else{"FAIL"}
  }
}
$results | Format-Table -AutoSize
"Pass: " + ($results | Where-Object {$_.Exit -eq 0}).Count + "/20"
```

## Deep accuracy audit (across all bench PDFs)

The script `deep_audit.py` (kept in the session workspace, can be checked
into `scripts/dev/` if needed) re-opens every PDF in `bench20/` and computes
worst-case Y-baseline drift, right-edge alignment drift, font count,
and re-runs the full 20-check verifier.

Expected output for a healthy build:

```
WORST y-baseline drift across all 20: 0.09 pt  (tolerance 0.5)
WORST right-align drift across all 20: 0.00 pt (tolerance 2.0)
All 20 PDFs pass full verifier: True
```

Any regression that pushes Y-baseline drift above ~0.1pt or right-align
above 0pt likely means a font swap or new `insert_text()` call site that
isn't using the canonical `COL_X` / `BAL_RIGHT` / `AMT_RIGHT` anchors in
`pdf_export.py`.

## Negative tests (verifier must catch corruption)

```python
import fitz
# 1. Foreign-font injection
doc = fitz.open("good.pdf")
doc[0].insert_text((400, 200), "9999", fontname="helv", fontsize=9)
doc.save("corrupt_font.pdf")
# Expect verifier to fail FONT-ALLOWLIST + ALIGN-LEFT + Y-MATCH-TEMPLATE + GLYPH-METRICS

# 2. Blank page
doc = fitz.open()
doc.new_page(width=595, height=842)
doc.save("corrupt_blank.pdf")
# Expect verifier to fail STRUCT-PAGES + STRUCT-CHROME + BALANCE-ARITH + CARRYOVER-FIRST
```

Then:
```python
from scripts.verify_pdf import verify_pdf
ok, rep = verify_pdf("corrupt_font.pdf", "fixtures/template.pdf")
assert not ok and any(c.code == "FONT-ALLOWLIST" and not c.ok for c in rep.checks)
```

## Baseline numbers (2026-05-23, commit `fb0cd8d`)

| Stat                          | Value |
|---|---|
| Pass rate (20 diverse cases)  | **20/20** |
| Worst Y-baseline drift        | 0.09 pt |
| Worst right-align drift       | 0.00 pt |
| File size range               | 63.6 – 67.7 KB |
| File size avg                 | 66.7 KB |
| Render time avg (Windows)     | 6.3 s |
| Fonts embedded                | 2 (MSGothic subset + MS Gothic Regular) |
| Reference file size           | 55 KB (mobile Suica export) |

If a future change drops file size to ~50 KB while keeping 20/20 pass rate,
that almost certainly means the hybrid CID-patching path has been
implemented — update this doc and `VERIFY_PDF.md` accordingly.
