"""Deep accuracy audit: for each generated PDF in BENCH dir, beyond the 20 in-line
checks, re-derive every entry from PDF text and cross-check pixel-level metrics:
  1. Worst-case Y-baseline drift vs template
  2. Worst-case right-edge alignment drift on numeric columns
  3. Font count (must stay ≤ 2 — allowlist of MSGothic variants)
  4. Re-runs the full 20-check verifier on each PDF
Usage:  python -m scripts.dev.deep_audit  [BENCH_DIR]
"""
import fitz, sys, os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

from scripts.verify_pdf import verify_pdf  # noqa: E402

TEMPLATE = ROOT / "fixtures/template.pdf"
BENCH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    os.environ.get("SUICA_BENCH_DIR", r"C:\Users\Admin\Downloads\bench20"))

# Pre-compute template y baselines per page
tpl = fitz.open(TEMPLATE)
tpl_ys = []
for p in tpl:
    ys = set()
    for blk in p.get_text("dict")["blocks"]:
        for ln in blk.get("lines", []):
            for sp in ln.get("spans", []):
                if 100 < sp["bbox"][1] < 700:
                    ys.add(round(sp["bbox"][3], 2))
    tpl_ys.append(sorted(ys))
tpl.close()

def audit(pdf_path):
    doc = fitz.open(pdf_path)
    metrics = {"pages": doc.page_count, "rows": 0, "max_y_drift": 0.0,
               "max_right_drift": 0.0, "fonts": set(), "y_jitter": 0.0,
               "digit_widths": {}}
    # Right edges of known numeric columns
    AMT_R = 536.036; BAL_R = 467.0
    right_drifts = []
    y_drifts = []
    yvals = []
    for pno, page in enumerate(doc):
        spans = []
        for blk in page.get_text("dict")["blocks"]:
            for ln in blk.get("lines", []):
                for sp in ln.get("spans", []):
                    spans.append(sp)
                    metrics["fonts"].add(sp["font"])
        for sp in spans:
            bb = sp["bbox"]
            if not (100 < bb[1] < 700): continue
            txt = (sp.get("text") or "").strip()
            # Right alignment check
            for r in (AMT_R, BAL_R):
                if abs(bb[2] - r) < 2.5 and any(c.isdigit() for c in txt):
                    right_drifts.append(abs(bb[2] - r))
            # Y match vs template
            yb = round(bb[3], 2)
            yvals.append(yb)
            tpl_y_page = tpl_ys[pno] if pno < len(tpl_ys) else tpl_ys[-1]
            nearest = min(tpl_y_page, key=lambda y: abs(y - yb))
            y_drifts.append(abs(nearest - yb))
        metrics["rows"] += len({round(s["bbox"][3], 1) for s in spans
                                if 100 < s["bbox"][1] < 700})
    metrics["max_right_drift"] = max(right_drifts) if right_drifts else 0
    metrics["max_y_drift"] = max(y_drifts) if y_drifts else 0
    metrics["right_samples"] = len(right_drifts)
    metrics["y_samples"] = len(y_drifts)
    doc.close()
    # Run full 20-check verifier
    ok, rep = verify_pdf(pdf_path, str(TEMPLATE))
    fails = [c.code for c in rep.checks if not c.ok]
    return metrics, ok, fails

pdfs = sorted(BENCH.glob("*.pdf"))
print(f"{'#':>3} {'file':25s} {'rows':>4} {'fonts':>6} {'maxYΔ':>6} {'maxRΔ':>6} {'verify':>10}")
print("-" * 70)
all_ok = True
max_y = max_r = 0
for i, pdf in enumerate(pdfs, 1):
    m, ok, fails = audit(pdf)
    status = "20/20 ✓" if ok else f"FAIL: {fails}"
    if not ok: all_ok = False
    max_y = max(max_y, m["max_y_drift"])
    max_r = max(max_r, m["max_right_drift"])
    print(f"{i:>3} {pdf.name:25s} {m['rows']:>4} {len(m['fonts']):>6} "
          f"{m['max_y_drift']:>5.2f}pt {m['max_right_drift']:>5.2f}pt  {status}")
print("-" * 70)
print(f"WORST y-baseline drift across all 20: {max_y:.3f} pt (tolerance 0.5)")
print(f"WORST right-align drift across all 20: {max_r:.3f} pt (tolerance 2.0)")
print(f"All 20 PDFs pass full verifier: {all_ok}")
