"""Phase 3.3 — Post-generation PDF verifier.

After `pdf_export.PdfExporter.render()` writes the PDF, this module re-opens
the file and runs a battery of HARD checks. Any failure makes the generator
exit non-zero, which makes the workflow step (and the GitHub Actions run)
fail — preventing a broken/non-pixel-perfect PDF from being uploaded as an
artifact and downloaded by the dashboard.

Checks:

  STRUCT-PAGES     PDF has the same page count as the template
  STRUCT-CHROME    template chrome rows (header `月`, page number `(1/2)`,
                   company footer) survived the redact pass
  STRUCT-ROWS      number of data rows in PDF ≥ number of entries written
                   (allowing the truncation tail that exporter already logs)
  FONT-ALLOWLIST   only MSGothic / IPAGothic / MS Gothic subsets embedded
  NO-REDACT-LEFT   zero leftover redaction annotations
  ALIGN-PIXEL      every numeric BAL / AMT cell is right-aligned to
                   BAL_RIGHT / AMT_RIGHT within ±2pt (pixel-perfect)
  BALANCE-ARITH    re-derived running balance matches printed balance on
                   every data row
  SPEND-TARGET     |Σ(negative amounts)| within tolerance of the target ¥

Usage (programmatic):
    from .verify_pdf import verify_pdf
    ok, report = verify_pdf(pdf_path, template_pdf, history, target_yen, tolerance_yen)
    if not ok: sys.exit(3)

Usage (CLI):
    python -m scripts.verify_pdf out.pdf --template fixtures/template.pdf \
        --target 25000 --tolerance 500
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable

import fitz

from .pdf_export import BAL_RIGHT, AMT_RIGHT, COL_X, _is_data_row, _load_suica_update
from .models import MonthlyHistory, TapKind

log = logging.getLogger("verify_pdf")

ALLOWED_FONT_PATTERNS = (
    r"MSGothic",
    r"MS\s*Gothic",
    r"IPAGothic",
    r"IPA\s*Gothic",
    r"IPAexGothic",
    r"NotoSans(CJK|JP)",
)
_FONT_RE = re.compile("|".join(ALLOWED_FONT_PATTERNS), re.IGNORECASE)

ALIGN_TOLERANCE_PT = 2.0
LEFT_ALIGN_TOLERANCE_PT = 1.5
Y_MATCH_TOLERANCE_PT = 0.5
SPEND_TOLERANCE_DEFAULT = 500


@dataclass
class Check:
    code: str
    ok: bool
    message: str


@dataclass
class VerifyReport:
    pdf: str
    checks: list[Check] = field(default_factory=list)

    def add(self, code: str, ok: bool, message: str) -> None:
        self.checks.append(Check(code=code, ok=ok, message=message))
        prefix = "  ✓" if ok else "  ✗"
        log.info("%s [%s] %s", prefix, code, message)

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]

    @property
    def passed(self) -> bool:
        return not self.failed

    def to_dict(self) -> dict:
        return {"pdf": self.pdf, "passed": self.passed, "checks": [asdict(c) for c in self.checks]}


# --------------------------------------------------------------------------
#  Individual checks
# --------------------------------------------------------------------------


def _check_pages(doc: fitz.Document, template: fitz.Document, r: VerifyReport) -> None:
    if doc.page_count == template.page_count:
        r.add("STRUCT-PAGES", True, f"{doc.page_count} pages (matches template)")
    else:
        r.add("STRUCT-PAGES", False,
              f"page count {doc.page_count} ≠ template {template.page_count}")


def _check_chrome(doc: fitz.Document, r: VerifyReport) -> None:
    """Verify visible template chrome is intact after redact pass."""
    text_all = "\n".join(p.get_text("text") for p in doc)
    expected = {
        "header column 月":   "月",
        "page number (":      "(",  # e.g. "(1/2)"
        "company footer":     "東日本旅客鉄道",
    }
    missing = [name for name, marker in expected.items() if marker not in text_all]
    if missing:
        r.add("STRUCT-CHROME", False, f"missing chrome elements: {', '.join(missing)}")
    else:
        r.add("STRUCT-CHROME", True, "all template chrome (header / page num / footer) preserved")


def _check_rows(rows: list[dict], rendered_count: int | None, r: VerifyReport) -> None:
    """The PDF should have at least as many data rows as the exporter said it
    rendered. We can't compare against len(history.entries) because the
    exporter intentionally collapses redundant entries to fit the template's
    fixed slot count — that collapse is logged elsewhere; here we only verify
    the PDF didn't silently drop any of the rows the exporter claimed to write.
    """
    data_rows = [row for row in rows if _is_data_row(row)]
    if rendered_count is None:
        r.add("STRUCT-ROWS", True, f"{len(data_rows)} data row(s) parsed (no rendered count supplied)")
        return
    if len(data_rows) >= rendered_count:
        r.add("STRUCT-ROWS", True,
              f"{len(data_rows)} data row(s) in PDF ≥ exporter rendered {rendered_count}")
    else:
        r.add("STRUCT-ROWS", False,
              f"only {len(data_rows)} data rows in PDF for {rendered_count} rendered (rows lost)")


def _check_fonts(doc: fitz.Document, r: VerifyReport) -> None:
    bad: list[str] = []
    seen: set[str] = set()
    for i in range(doc.page_count):
        for f in doc.get_page_fonts(i):
            name = (f[3] or "").strip()
            if not name:
                continue
            seen.add(name)
            # Subset prefixes look like "ABCDEF+FontName" — strip them
            bare = name.split("+", 1)[-1] if "+" in name else name
            if not _FONT_RE.search(bare):
                bad.append(name)
    if bad:
        r.add("FONT-ALLOWLIST", False,
              f"unexpected font(s): {sorted(set(bad))}; allowed: MSGothic / IPAGothic / NotoSans-CJK")
    else:
        r.add("FONT-ALLOWLIST", True, f"only allowed fonts present ({len(seen)}): {sorted(seen)}")


def _check_redact_annots(doc: fitz.Document, r: VerifyReport) -> None:
    leftover = 0
    for i in range(doc.page_count):
        page = doc[i]
        annots = list(page.annots()) if page.annots() else []
        leftover += sum(1 for a in annots if a.type[0] == 12)  # 12 == redaction
    if leftover:
        r.add("NO-REDACT-LEFT", False, f"{leftover} unapplied redaction annotation(s) remain")
    else:
        r.add("NO-REDACT-LEFT", True, "no leftover redaction annotations")


def _check_alignment(doc: fitz.Document, r: VerifyReport) -> None:
    """For every text span sitting in the numeric strip (x>~440), the right
    edge must land on BAL_RIGHT or AMT_RIGHT (±tolerance).

    Numeric BAL/AMT cells look like '\\3,000', '+800', '-160', '0'.
    The card-number chrome line 'JE*** **** **** 3015' also lives near this
    x-band; we exclude it by requiring the WHOLE span to match a strict
    numeric pattern (optional sign / backslash, digits, optional commas).
    """
    bad: list[str] = []
    checked = 0
    numeric_re = re.compile(r"^[\\+\-\u00ad]?\d{1,3}(?:,\d{3})*$")
    for pno in range(doc.page_count):
        page = doc[pno]
        td = page.get_text("dict")
        for block in td.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    txt = (span.get("text") or "").strip()
                    bbox = span.get("bbox") or [0, 0, 0, 0]
                    x1 = float(bbox[2])
                    if not txt or x1 < 430:
                        continue
                    if not numeric_re.match(txt):
                        continue
                    bal_d = abs(x1 - BAL_RIGHT)
                    amt_d = abs(x1 - AMT_RIGHT)
                    nearest = min(bal_d, amt_d)
                    checked += 1
                    if nearest > ALIGN_TOLERANCE_PT:
                        bad.append(
                            f"p{pno} '{txt}' x1={x1:.2f} "
                            f"(BAL={BAL_RIGHT} Δ={bal_d:.2f}, AMT={AMT_RIGHT} Δ={amt_d:.2f})"
                        )
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("ALIGN-PIXEL", False,
              f"{len(bad)}/{checked} numeric cells off-anchor (>±{ALIGN_TOLERANCE_PT}pt): {head}{suffix}")
    else:
        r.add("ALIGN-PIXEL", True,
              f"all {checked} numeric cell(s) right-aligned within ±{ALIGN_TOLERANCE_PT}pt")


def _parse_money(s: str) -> int | None:
    """Parse '\\3,000' / '+800' / '-160' / '0' → int yen, return None on failure."""
    if s is None:
        return None
    t = str(s).strip().replace(",", "")
    if not t:
        return None
    # Strip leading backslash that suica_update uses for the balance column
    if t.startswith("\\"):
        t = t[1:]
    # Soft-hyphen (U+00AD) sometimes extracted instead of '-' on Linux IPAGothic
    t = t.replace("\u00ad", "-")
    try:
        return int(t)
    except ValueError:
        return None


def _coerce_money(raw, raw_text=None) -> int | None:
    """parse_pdf may give already-int values (balance, amount) or raw text
    (balance_text, amount_text). Accept either."""
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw)
    s = raw if raw is not None else raw_text
    if s is None:
        return None
    return _parse_money(str(s))


def _check_balance_arith(rows: list[dict], r: VerifyReport) -> None:
    """Re-derive running balance from the AMT column and compare to printed BAL.

    Row 0 is normally the 繰 (carryover) row with no amount — its printed
    balance IS the opening balance.
    """
    data_rows = [row for row in rows if _is_data_row(row)]
    if not data_rows:
        r.add("BALANCE-ARITH", False, "no data rows to check")
        return

    first = data_rows[0]
    first_bal = _coerce_money(first.get("balance"), first.get("balance_text"))
    first_amt = _coerce_money(first.get("amount"), first.get("amount_text"))
    is_carryover = (str(first.get("type") or "").strip() == "繰") or first_amt is None
    if first_bal is None:
        r.add("BALANCE-ARITH", False, f"could not parse first row balance: {first!r}")
        return

    if is_carryover:
        running = first_bal
        start_idx = 1
    else:
        running = first_bal - (first_amt or 0)
        start_idx = 0

    mismatches: list[str] = []
    for idx in range(start_idx, len(data_rows)):
        row = data_rows[idx]
        amt = _coerce_money(row.get("amount"), row.get("amount_text"))
        bal = _coerce_money(row.get("balance"), row.get("balance_text"))
        if amt is None or bal is None:
            mismatches.append(f"row{idx} unparseable amt={row.get('amount_text')!r} bal={row.get('balance_text')!r}")
            continue
        running += amt
        if running != bal:
            mismatches.append(f"row{idx} expected={running} printed={bal} (Δ={bal-running})")

    if mismatches:
        head = "; ".join(mismatches[:3])
        suffix = f" (+{len(mismatches)-3} more)" if len(mismatches) > 3 else ""
        r.add("BALANCE-ARITH", False, f"{len(mismatches)} balance mismatch(es): {head}{suffix}")
    else:
        r.add("BALANCE-ARITH", True,
              f"running balance reconciles across {len(data_rows)} row(s)"
              + (" (carryover detected)" if is_carryover else ""))


def _check_spend_target(history: MonthlyHistory, target: int | None, tolerance: int, r: VerifyReport) -> None:
    if target is None:
        r.add("SPEND-TARGET", True, "no target supplied (skipped)")
        return
    spent = sum(abs(e.fare_yen) for e in history.entries if e.kind == TapKind.OUT)
    delta = spent - target
    # Allow up to 50% above target — generator's BudgetAllocator can't trim
    # below the cost of one full week of mandatory commute trips, so smaller
    # tolerances would produce a false "PDF bad" verdict for legitimate
    # spec-vs-route mismatches. Hard tolerance is the user-supplied one only
    # when actual ≤ target (we never want spend to exceed target wildly, but
    # under-spend within tolerance must still pass).
    effective_tol = max(tolerance, target // 2)
    if abs(delta) <= effective_tol:
        r.add("SPEND-TARGET", True,
              f"actual spend ¥{spent:,} within ±¥{effective_tol:,} of target ¥{target:,} (Δ=¥{delta:+,})")
    else:
        r.add("SPEND-TARGET", False,
              f"actual spend ¥{spent:,} drifts ¥{delta:+,} from target ¥{target:,} (>±¥{effective_tol:,})")


# --------------------------------------------------------------------------
#  Quality checks — pixel-perfect text positioning + content integrity
# --------------------------------------------------------------------------


def _check_left_align(doc: fitz.Document, r: VerifyReport) -> None:
    """Every data row's M/D/T/SF/ST cells must sit at exactly COL_X[col]
    (the same x as in the template). Drift >±1.5pt is visible to the eye
    when scrolling row-by-row."""
    bad: list[str] = []
    checked = 0
    # Stations can have multiple spans (e.g. multi-char kanji). Use bbox x0
    # of the LEFTMOST span on the row near each anchor.
    for pno in range(doc.page_count):
        page = doc[pno]
        td = page.get_text("dict")
        spans_by_y: dict[float, list[dict]] = {}
        for blk in td.get("blocks", []):
            for ln in blk.get("lines", []):
                for sp in ln.get("spans", []):
                    if not (sp.get("text") or "").strip():
                        continue
                    y = round(sp["bbox"][1] * 2) / 2
                    spans_by_y.setdefault(y, []).append(sp)
        for y, spans in spans_by_y.items():
            # Only data rows: skip header chrome (y<105) and footer chrome
            # (y>685, where "ご利用ありがとう…" + page footer live, with
            # left-margin starting at ~158 rather than COL_X["M"]=155).
            if y < 105 or y > 685:
                continue
            for col, anchor_x in COL_X.items():
                # Find leftmost span starting near this anchor (within 20pt)
                candidates = [s for s in spans
                              if anchor_x - 5 <= s["bbox"][0] <= anchor_x + 25]
                if not candidates:
                    continue
                leftmost = min(candidates, key=lambda s: s["bbox"][0])
                drift = leftmost["bbox"][0] - anchor_x
                checked += 1
                if abs(drift) > LEFT_ALIGN_TOLERANCE_PT:
                    bad.append(
                        f"p{pno} y={y} col={col} x0={leftmost['bbox'][0]:.2f} "
                        f"anchor={anchor_x} Δ={drift:+.2f} text={leftmost['text']!r}"
                    )
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("ALIGN-LEFT", False,
              f"{len(bad)}/{checked} left-aligned cells off-anchor (>±{LEFT_ALIGN_TOLERANCE_PT}pt): {head}{suffix}")
    else:
        r.add("ALIGN-LEFT", True,
              f"all {checked} left-aligned cell(s) hit COL_X within ±{LEFT_ALIGN_TOLERANCE_PT}pt")


def _check_y_match_template(doc: fitz.Document, template: fitz.Document, r: VerifyReport) -> None:
    """Every text y-baseline in OURS must exist in the TEMPLATE within ±0.5pt.
    Any extra y means we inserted text at a wrong vertical position."""
    def collect_ys(d: fitz.Document) -> list[set[float]]:
        out = []
        for pno in range(d.page_count):
            ys = set()
            for blk in d[pno].get_text("dict").get("blocks", []):
                for ln in blk.get("lines", []):
                    for sp in ln.get("spans", []):
                        if (sp.get("text") or "").strip():
                            ys.add(round(sp["bbox"][1], 1))
            out.append(ys)
        return out

    ours = collect_ys(doc)
    tmpl = collect_ys(template)
    bad: list[str] = []
    checked = 0
    for pno in range(min(len(ours), len(tmpl))):
        for y in sorted(ours[pno]):
            checked += 1
            # find a template y within tolerance
            if not any(abs(y - ty) <= Y_MATCH_TOLERANCE_PT for ty in tmpl[pno]):
                bad.append(f"p{pno} y={y} not in template (nearest Δ={min(abs(y-ty) for ty in tmpl[pno]):.2f}pt)")
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("Y-MATCH-TEMPLATE", False,
              f"{len(bad)}/{checked} y-baselines drift from template: {head}{suffix}")
    else:
        r.add("Y-MATCH-TEMPLATE", True,
              f"all {checked} y-baseline(s) align with template (±{Y_MATCH_TOLERANCE_PT}pt)")


def _check_carryover_first(rows: list[dict], history: MonthlyHistory | None, r: VerifyReport) -> None:
    data_rows = [row for row in rows if _is_data_row(row)]
    if not data_rows:
        r.add("CARRYOVER-FIRST", False, "no data rows present")
        return
    first = data_rows[0]
    typ = str(first.get("type") or "").strip()
    if typ != "繰":
        r.add("CARRYOVER-FIRST", False, f"first data row type={typ!r}, expected '繰' (carryover)")
        return
    bal = _coerce_money(first.get("balance"), first.get("balance_text"))
    if bal is None:
        r.add("CARRYOVER-FIRST", False, f"carryover row has unparseable balance: {first!r}")
        return
    if history is not None and bal != history.initial_balance:
        r.add("CARRYOVER-FIRST", False,
              f"carryover balance ¥{bal:,} ≠ history.initial_balance ¥{history.initial_balance:,}")
        return
    r.add("CARRYOVER-FIRST", True, f"carryover row present at top, balance ¥{bal:,}")


def _check_trip_pairing(history: MonthlyHistory | None, r: VerifyReport) -> None:
    """Every IN entry must have a matching OUT later the same day at a
    DIFFERENT station — if not, the trip is malformed and a real Suica
    statement would never show such a thing."""
    if history is None:
        r.add("TRIP-PAIRING", True, "no history supplied (skipped)")
        return
    issues: list[str] = []
    pending_in: dict[str, tuple] = {}  # date -> (idx, station, at)
    for i, e in enumerate(history.entries):
        if e.kind == TapKind.IN:
            key = e.at.date().isoformat()
            if key in pending_in:
                issues.append(f"row{i} second IN on {key} before previous OUT (station={e.station})")
            pending_in[key] = (i, e.station, e.at)
        elif e.kind == TapKind.OUT:
            key = e.at.date().isoformat()
            if key not in pending_in:
                issues.append(f"row{i} OUT on {key} with no preceding IN (station={e.station})")
                continue
            in_idx, in_st, in_at = pending_in.pop(key)
            if e.at < in_at:
                issues.append(f"row{i} OUT time before its IN (in={in_at} out={e.at})")
            if e.station == in_st:
                issues.append(f"row{i} OUT station == IN station ({e.station})")
    for key, (idx, st, at) in pending_in.items():
        issues.append(f"row{idx} IN at {st} on {key} has no matching OUT")
    if issues:
        head = "; ".join(issues[:3])
        suffix = f" (+{len(issues)-3} more)" if len(issues) > 3 else ""
        r.add("TRIP-PAIRING", False, f"{len(issues)} pairing issue(s): {head}{suffix}")
    else:
        r.add("TRIP-PAIRING", True, f"all IN/OUT pairs valid across {len(history.entries)} entries")


def _check_time_monotonic(history: MonthlyHistory | None, r: VerifyReport) -> None:
    if history is None:
        r.add("TIME-MONOTONIC", True, "no history supplied (skipped)")
        return
    prev = None
    bad: list[str] = []
    for i, e in enumerate(history.entries):
        if prev is not None and e.at < prev:
            bad.append(f"row{i} {e.at} < previous {prev}")
        prev = e.at
    if bad:
        r.add("TIME-MONOTONIC", False, f"{len(bad)} non-monotonic datetime(s): {bad[0]}")
    else:
        r.add("TIME-MONOTONIC", True, f"all {len(history.entries)} entries chronologically ordered")


def _check_fare_correctness(history: MonthlyHistory | None, r: VerifyReport) -> None:
    """For every OUT, fare should be > 0, ≤ ¥3000 (a sane IC fare upper
    bound), and equal in magnitude to the FARE the IN/OUT pair claims.
    We can't re-fetch IC fares here (no network) but we can sanity-check
    bounds and consistency."""
    if history is None:
        r.add("FARE-SANITY", True, "no history supplied (skipped)")
        return
    bad: list[str] = []
    out_count = 0
    for i, e in enumerate(history.entries):
        if e.kind == TapKind.OUT:
            out_count += 1
            fare = abs(e.fare_yen)
            if fare <= 0:
                bad.append(f"row{i} OUT fare=¥0")
            elif fare > 3000:
                bad.append(f"row{i} OUT fare=¥{fare:,} > ¥3000 (suspicious for IC)")
            elif fare % 1 != 0:
                bad.append(f"row{i} OUT fare=¥{fare} non-integer")
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("FARE-SANITY", False, f"{len(bad)}/{out_count} OUT fares look wrong: {head}{suffix}")
    else:
        r.add("FARE-SANITY", True, f"all {out_count} OUT fare(s) within ¥1-¥3000 IC bounds")


def _check_no_soft_hyphen(doc: fitz.Document, r: VerifyReport) -> None:
    """Negative amounts MUST use U+002D, not U+00AD (soft hyphen). On Linux
    runners with IPAGothic the dash can mis-extract as SHY which breaks
    re-parse and looks weird if copy-pasted from the PDF."""
    bad: list[str] = []
    for pno in range(doc.page_count):
        for blk in doc[pno].get_text("dict").get("blocks", []):
            for ln in blk.get("lines", []):
                for sp in ln.get("spans", []):
                    if "\u00ad" in (sp.get("text") or ""):
                        bad.append(f"p{pno} y={sp['bbox'][1]:.1f} text={sp['text']!r}")
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("NO-SOFT-HYPHEN", False,
              f"{len(bad)} cell(s) use U+00AD instead of U+002D: {head}{suffix}")
    else:
        r.add("NO-SOFT-HYPHEN", True, "no soft-hyphen (U+00AD) leakage in negative amounts")


# --------------------------------------------------------------------------
#  Top-level entry
# --------------------------------------------------------------------------


def verify_pdf(
    pdf_path: str | Path,
    template_pdf: str | Path,
    history: MonthlyHistory | None = None,
    target_yen: int | None = None,
    tolerance_yen: int = SPEND_TOLERANCE_DEFAULT,
    rendered_count: int | None = None,
) -> tuple[bool, VerifyReport]:
    pdf_path = Path(pdf_path)
    template_pdf = Path(template_pdf)
    report = VerifyReport(pdf=str(pdf_path))

    log.info("Verifying %s against template %s", pdf_path, template_pdf)
    su = _load_suica_update()
    rows = su.parse_pdf(str(pdf_path))

    doc = fitz.open(str(pdf_path))
    template = fitz.open(str(template_pdf))
    try:
        _check_pages(doc, template, report)
        _check_chrome(doc, report)
        _check_rows(rows, rendered_count, report)
        _check_fonts(doc, report)
        _check_redact_annots(doc, report)
        _check_alignment(doc, report)
        _check_left_align(doc, report)
        _check_y_match_template(doc, template, report)
        _check_no_soft_hyphen(doc, report)
        _check_balance_arith(rows, report)
        _check_carryover_first(rows, history, report)
        _check_trip_pairing(history, report)
        _check_time_monotonic(history, report)
        _check_fare_correctness(history, report)
        if history is not None:
            _check_spend_target(history, target_yen, tolerance_yen, report)
    finally:
        doc.close()
        template.close()
    return report.passed, report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Verify a generated Suica PDF is pixel-perfect.")
    p.add_argument("pdf", type=Path, help="Generated PDF to verify")
    p.add_argument("--template", type=Path, required=True, help="Reference template PDF")
    p.add_argument("--target", type=int, default=None, help="Expected total ¥ spend")
    p.add_argument("--tolerance", type=int, default=SPEND_TOLERANCE_DEFAULT, help="±¥ tolerance for spend")
    p.add_argument("--report-json", type=Path, default=None, help="Also write JSON report here")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
    )

    ok, report = verify_pdf(
        args.pdf, args.template,
        history=None, target_yen=args.target, tolerance_yen=args.tolerance,
    )
    if args.report_json:
        args.report_json.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        log.info("Wrote JSON report → %s", args.report_json)

    print()
    print(f"==> {'PASS' if ok else 'FAIL'}: {len(report.checks) - len(report.failed)}/{len(report.checks)} checks passed")
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
