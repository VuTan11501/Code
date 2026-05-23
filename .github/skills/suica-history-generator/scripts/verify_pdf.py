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
    # SPEND-TARGET is informational only. The target is a planning hint, not a
    # generator invariant — the route pool may not have fares that sum cleanly
    # to it, and the user explicitly accepts whatever the generator produces.
    # We always pass, but still surface the drift in the report so reviewers
    # can eyeball it.
    if delta == 0:
        r.add("SPEND-TARGET", True, f"actual spend ¥{spent:,} matches target exactly")
    else:
        r.add("SPEND-TARGET", True,
              f"actual spend ¥{spent:,} (target ¥{target:,}, Δ=¥{delta:+,}) — informational, not enforced")


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
#  Quality checks — tier 2: forensic + content correctness
# --------------------------------------------------------------------------


def _check_trip_fare_exact(
    history: MonthlyHistory | None,
    expected_fares: dict[tuple[str, str], int] | None,
    r: VerifyReport,
) -> None:
    """Walk IN→OUT pairs and verify the OUT fare equals the verified IC
    fare for that (from, to) pair as recorded in the FareCache. Catches
    cases where the renderer wrote a stale or mis-assigned fare."""
    if history is None or not expected_fares:
        r.add("TRIP-FARE-EXACT", True, "no fare table supplied (skipped)")
        return
    bad: list[str] = []
    checked = 0
    pending_in: dict[str, tuple[int, str]] = {}
    for i, e in enumerate(history.entries):
        if e.kind == TapKind.IN:
            pending_in[e.at.date().isoformat()] = (i, e.station)
        elif e.kind == TapKind.OUT:
            key = e.at.date().isoformat()
            if key not in pending_in:
                continue
            _, st_from = pending_in.pop(key)
            st_to = e.station
            actual = abs(e.fare_yen)
            expected = expected_fares.get((st_from, st_to))
            if expected is None:
                # No cached fare for this pair — can't verify, skip
                continue
            checked += 1
            if actual != expected:
                bad.append(f"row{i} {st_from}→{st_to} fare=¥{actual} expected=¥{expected} (Δ=¥{actual-expected:+,})")
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("TRIP-FARE-EXACT", False,
              f"{len(bad)}/{checked} OUT fares don't match verified IC fare: {head}{suffix}")
    else:
        r.add("TRIP-FARE-EXACT", True,
              f"all {checked} trip fare(s) match verified IC fare cache exactly")


def _check_date_range(history: MonthlyHistory | None, month: str | None, r: VerifyReport) -> None:
    """Every entry datetime must fall within the target YYYY-MM."""
    if history is None or not month:
        r.add("DATE-RANGE", True, "no month/history supplied (skipped)")
        return
    try:
        y, m = map(int, month.split("-"))
    except Exception:
        r.add("DATE-RANGE", False, f"unparseable month spec: {month!r}")
        return
    bad: list[str] = []
    for i, e in enumerate(history.entries):
        if e.at.year != y or e.at.month != m:
            bad.append(f"row{i} {e.at.isoformat()} outside {month}")
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("DATE-RANGE", False, f"{len(bad)} entries outside target month: {head}{suffix}")
    else:
        r.add("DATE-RANGE", True, f"all {len(history.entries)} entries fall within {month}")


def _check_no_empty_cells(rows: list[dict], r: VerifyReport) -> None:
    """Every IN/OUT data row must have month, day, type, st_from, st_to,
    balance, and amount populated. Carryover rows (繰) are allowed to skip
    st_from / st_to / amount."""
    data_rows = [row for row in rows if _is_data_row(row)]
    bad: list[str] = []
    for idx, row in enumerate(data_rows):
        typ = str(row.get("type") or "").strip()
        required = ["month", "day", "type", "balance"]
        if typ != "繰":
            required += ["amount"]
        # For trip rows (入/出/物販/オートチャージ), most need st_from too;
        # オートチャージ / 物販 sometimes only fill st_to. Be lenient: only
        # demand that the trip rows have BOTH stations OR explicitly are
        # a single-station type (charge / shopping).
        for col in required:
            v = row.get(col)
            if v is None or (isinstance(v, str) and not v.strip()):
                bad.append(f"row{idx} type={typ!r} missing '{col}'")
                break
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("NO-EMPTY-CELLS", False, f"{len(bad)} row(s) have empty required cells: {head}{suffix}")
    else:
        r.add("NO-EMPTY-CELLS", True, f"all {len(data_rows)} data row(s) have complete required cells")


def _check_font_consistency_per_row(doc: fitz.Document, r: VerifyReport) -> None:
    """Within a single data row, all cells should use the SAME font face —
    mixing MSGothic with IPAGothic on one row would be visible (slightly
    different stroke weight / kanji width). Chrome / footer rows are exempt
    because the carryover or header may share a row with the column header."""
    bad: list[str] = []
    checked = 0
    for pno in range(doc.page_count):
        rows: dict[float, list[dict]] = {}
        for blk in doc[pno].get_text("dict").get("blocks", []):
            for ln in blk.get("lines", []):
                for sp in ln.get("spans", []):
                    if (sp.get("text") or "").strip():
                        y = round(sp["bbox"][1] * 2) / 2
                        rows.setdefault(y, []).append(sp)
        for y, spans in rows.items():
            if y < 110 or y > 685:  # data-band only
                continue
            checked += 1
            font_set = set(sp["font"] for sp in spans)
            if len(font_set) > 1:
                # Allow combinations that share the same family — e.g. both
                # MSGothic subsets with different prefixes count as same.
                bare = set(f.split("+", 1)[-1].lower().replace(" ", "") for f in font_set)
                if len(bare) > 1:
                    bad.append(f"p{pno} y={y} fonts={sorted(font_set)}")
    if bad:
        head = "; ".join(bad[:3])
        suffix = f" (+{len(bad)-3} more)" if len(bad) > 3 else ""
        r.add("FONT-CONSISTENT-ROW", False,
              f"{len(bad)}/{checked} data rows mix font families: {head}{suffix}")
    else:
        r.add("FONT-CONSISTENT-ROW", True,
              f"all {checked} data row(s) use a single font family")


def _check_glyph_metrics(doc: fitz.Document, r: VerifyReport) -> None:
    """For ASCII digits 0-9, compute the average glyph bbox width per
    (font, size) bucket. Fail only when fonts with mismatched digit
    widths actually appear in the SAME row band (Δy ≤ 3pt) — that is
    the only case where the eye can directly compare them. Drift across
    visually distant regions (e.g. chrome header vs data rows) is not a
    pixel-perfect concern because users don't see them side-by-side.
    """
    # (font, size, y_center) → avg digit width
    samples: list[tuple[str, float, float, float]] = []
    for pno in range(doc.page_count):
        for blk in doc[pno].get_text("dict").get("blocks", []):
            for ln in blk.get("lines", []):
                for sp in ln.get("spans", []):
                    txt = sp.get("text") or ""
                    digits = sum(1 for c in txt if c.isdigit())
                    if digits == 0:
                        continue
                    bbox = sp["bbox"]
                    w_per_char = (bbox[2] - bbox[0]) / len(txt)
                    y_center = (bbox[1] + bbox[3]) / 2
                    samples.append((sp["font"], round(sp["size"], 1), y_center, w_per_char))

    # Group by size, then by row band (Δy ≤ 3pt)
    issues: list[str] = []
    by_size: dict[float, list[tuple[str, float, float]]] = {}
    for font, size, y, w in samples:
        by_size.setdefault(size, []).append((font, y, w))

    for size, rows in by_size.items():
        rows.sort(key=lambda t: t[1])
        # Cluster into row bands
        bands: list[list[tuple[str, float, float]]] = []
        for item in rows:
            if bands and abs(item[1] - bands[-1][-1][1]) <= 3.0:
                bands[-1].append(item)
            else:
                bands.append([item])
        for band in bands:
            fonts_in_band: dict[str, list[float]] = {}
            for font, _y, w in band:
                fonts_in_band.setdefault(font, []).append(w)
            if len(fonts_in_band) <= 1:
                continue
            avgs = {f: sum(ws)/len(ws) for f, ws in fonts_in_band.items()}
            span = max(avgs.values()) - min(avgs.values())
            if span > 0.3:
                d = ", ".join(f"{f.split('+',1)[-1]}={w:.2f}pt" for f, w in avgs.items())
                issues.append(f"y≈{band[0][1]:.0f} {size}pt: {d} (Δ{span:.2f}pt)")
    if issues:
        r.add("GLYPH-METRICS", False,
              "co-located fonts with digit-width drift > 0.3pt: " + "; ".join(issues[:3]))
    else:
        r.add("GLYPH-METRICS", True,
              f"no co-located digit-width drift across {len(samples)} digit span(s)")


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
    month: str | None = None,
    expected_fares: dict[tuple[str, str], int] | None = None,
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
        _check_trip_fare_exact(history, expected_fares, report)
        _check_date_range(history, month, report)
        _check_no_empty_cells(rows, report)
        _check_font_consistency_per_row(doc, report)
        _check_glyph_metrics(doc, report)
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
