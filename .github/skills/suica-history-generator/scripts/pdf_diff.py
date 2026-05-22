"""pdf_diff.py — Compare a generated Suica PDF against a reference PDF.

Two diff modes are supported, in order of preference:

1. **Pixel diff** (default): rasterize both PDFs at the same DPI and
   compare grayscale pixel arrays. Reports per-page similarity in [0, 1]
   and an aggregated score. A score >= 0.95 generally means "visually
   indistinguishable" — anything below indicates font / spacing drift.

2. **Structural diff** (--text-only): extract text spans with positions
   via PyMuPDF and compare row counts + font names. Use this when you
   don't have Pillow / numpy installed.

The reference PDF is typically a redacted real Suica statement.

CLI:
    python -m scripts.pdf_diff generated.pdf reference.pdf
    python -m scripts.pdf_diff gen.pdf ref.pdf --dpi 200 --threshold 0.95 --report-json out/diff.json
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

log = logging.getLogger("pdf_diff")

DEFAULT_DPI = 150
DEFAULT_THRESHOLD = 0.95


@dataclass(slots=True)
class PageDiff:
    page: int
    similarity: float
    mean_abs_diff: float    # 0..255
    px_above_thresh: int    # pixels differing by > 32 / 255
    width: int
    height: int


@dataclass(slots=True)
class DiffReport:
    mode: str
    pages: list[PageDiff]
    overall_similarity: float
    threshold: float
    passes: bool

    def summary(self) -> str:
        verdict = "✓ PASS" if self.passes else "✗ FAIL"
        lines = [
            f"PDF diff ({self.mode}): overall similarity = {self.overall_similarity:.4f}",
            f"  threshold = {self.threshold:.4f}   verdict = {verdict}",
        ]
        for p in self.pages:
            lines.append(
                f"  page {p.page + 1}: sim={p.similarity:.4f}  mean|Δ|={p.mean_abs_diff:.2f}  "
                f"px>32={p.px_above_thresh}  ({p.width}x{p.height})"
            )
        return "\n".join(lines)


# ----------------------------------------------------------------------
# Pixel diff (preferred)
# ----------------------------------------------------------------------

def _rasterize(path: Path, dpi: int):
    import fitz  # type: ignore
    from PIL import Image  # type: ignore

    doc = fitz.open(str(path))
    try:
        out = []
        for page in doc:
            mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")
            out.append(img)
        return out
    finally:
        doc.close()


def pixel_diff(generated: Path, reference: Path,
               dpi: int = DEFAULT_DPI,
               threshold: float = DEFAULT_THRESHOLD) -> DiffReport:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    gen_pages = _rasterize(generated, dpi)
    ref_pages = _rasterize(reference, dpi)

    n = min(len(gen_pages), len(ref_pages))
    pages: list[PageDiff] = []
    sims: list[float] = []
    for i in range(n):
        g = gen_pages[i]
        r = ref_pages[i]
        # Resize to the smaller intersection so the comparison is well-defined
        w = min(g.width, r.width)
        h = min(g.height, r.height)
        if g.size != (w, h):
            g = g.resize((w, h), Image.BILINEAR)
        if r.size != (w, h):
            r = r.resize((w, h), Image.BILINEAR)
        ga = np.asarray(g, dtype=np.int16)
        ra = np.asarray(r, dtype=np.int16)
        diff = np.abs(ga - ra)
        mean_abs = float(diff.mean())
        px_above = int((diff > 32).sum())
        # Similarity = 1 - mean_abs/255 (simple, deterministic, no SSIM dep)
        sim = max(0.0, 1.0 - mean_abs / 255.0)
        pages.append(PageDiff(i, sim, mean_abs, px_above, w, h))
        sims.append(sim)
    overall = sum(sims) / len(sims) if sims else 0.0
    return DiffReport(
        mode="pixel",
        pages=pages,
        overall_similarity=overall,
        threshold=threshold,
        passes=overall >= threshold,
    )


# ----------------------------------------------------------------------
# Structural diff (fallback)
# ----------------------------------------------------------------------

def structural_diff(generated: Path, reference: Path,
                    threshold: float = DEFAULT_THRESHOLD) -> DiffReport:
    """Compare text-block counts + font names per page. No images needed."""
    import fitz  # type: ignore

    def stats(path: Path):
        doc = fitz.open(str(path))
        try:
            per_page = []
            for page in doc:
                blocks = page.get_text("dict").get("blocks", [])
                spans = 0
                fonts: set[str] = set()
                for b in blocks:
                    for line in b.get("lines", []):
                        for span in line.get("spans", []):
                            spans += 1
                            fonts.add(span.get("font", ""))
                per_page.append((spans, fonts, page.rect.width, page.rect.height))
            return per_page
        finally:
            doc.close()

    g = stats(generated)
    r = stats(reference)
    n = min(len(g), len(r))
    pages: list[PageDiff] = []
    sims: list[float] = []
    for i in range(n):
        gs, gf, gw, gh = g[i]
        rs, rf, rw, rh = r[i]
        if max(gs, rs) == 0:
            span_sim = 1.0
        else:
            span_sim = 1.0 - abs(gs - rs) / max(gs, rs)
        # Font overlap as Jaccard
        union = gf | rf
        inter = gf & rf
        font_sim = len(inter) / len(union) if union else 1.0
        sim = (span_sim + font_sim) / 2.0
        pages.append(PageDiff(i, sim, 0.0, 0, int(gw), int(gh)))
        sims.append(sim)
    overall = sum(sims) / len(sims) if sims else 0.0
    return DiffReport(
        mode="structural",
        pages=pages,
        overall_similarity=overall,
        threshold=threshold,
        passes=overall >= threshold,
    )


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Diff a generated Suica PDF against a reference.")
    p.add_argument("generated", type=Path)
    p.add_argument("reference", type=Path)
    p.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    p.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    p.add_argument("--text-only", action="store_true",
                   help="Use structural diff (no Pillow/numpy required)")
    p.add_argument("--report-json", type=Path, default=None,
                   help="Write full report to this JSON path")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")

    if not args.generated.exists() or not args.reference.exists():
        log.error("Both PDFs must exist")
        return 2

    try:
        if args.text_only:
            report = structural_diff(args.generated, args.reference, args.threshold)
        else:
            try:
                report = pixel_diff(args.generated, args.reference, args.dpi, args.threshold)
            except ImportError as e:
                log.warning("Pixel diff unavailable (%s); falling back to structural", e)
                report = structural_diff(args.generated, args.reference, args.threshold)
    except Exception as e:
        log.error("Diff failed: %s", e)
        return 2

    print(report.summary())
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(
            json.dumps(
                {
                    "mode": report.mode,
                    "overall_similarity": report.overall_similarity,
                    "threshold": report.threshold,
                    "passes": report.passes,
                    "pages": [asdict(p) for p in report.pages],
                },
                ensure_ascii=False, indent=2,
            ),
            encoding="utf-8",
        )
        log.info("Wrote %s", args.report_json)
    return 0 if report.passes else 1


if __name__ == "__main__":
    raise SystemExit(main())
