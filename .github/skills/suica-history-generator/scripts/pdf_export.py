"""Phase 3.2 — PDF export.

Renders a MonthlyHistory to a Mobile Suica-style PDF using a template
PDF as the visual shell. Approach:

  1. Load template PDF (real Suica statement)
  2. Parse it to find existing transaction rows (positions & columns)
  3. For each row 0..min(M, N):
       - Redact the original M/D/T/SF/ST/B/A cells
       - Insert new text using MSGothic at the same positions
  4. Excess template rows (if M < N) are redacted to blank
  5. Excess generated entries (if M > N) are silently truncated with a warning

The output is *visually* identical to a real Suica PDF and parses correctly
with `suica_update.py analyze`, but is NOT byte-identical (PyMuPDF rewrites
the file and embeds a font subset). Forensic byte-identity is left for
a future iteration via `suica_update.py` content-stream patching.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import re
import sys
from pathlib import Path

import fitz

from .models import MonthlyHistory, TapEntry, TapKind

log = logging.getLogger(__name__)


# --- Layout constants (must match suica_update.py COL_RANGES) ---
# Font path is overridable via SUICA_FONT_FILE env var so Linux CI runners
# (which use fonts-ipafont-gothic at /usr/share/fonts/...) can supply their
# own gothic font without code changes.
def _default_font_path() -> str:
    env = os.environ.get("SUICA_FONT_FILE")
    if env and Path(env).exists():
        return env
    win = r"C:\Windows\Fonts\msgothic.ttc"
    if Path(win).exists():
        return win
    # Common Linux fallbacks (fonts-ipafont-gothic, fonts-noto-cjk)
    for candidate in (
        "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
        "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansJP-Regular.otf",
    ):
        if Path(candidate).exists():
            return candidate
    return win  # report Windows path even if missing — error msg stays familiar

FONT_FILE_DEFAULT = _default_font_path()
FONT_NAME = "msgo"
FONT_SIZE = 9
GLYPH_W = 4.5

COL_X = {
    "M":  155.0,
    "D":  180.0,
    "T":  205.0,
    "SF": 265.0,
    "ST": 380.0,
}
BAL_RIGHT = 467.0
AMT_RIGHT = 536.036

# Mobile Suica truncates station-name cells at ~6 full-width chars before they
# would overflow into the balance column. Longer names get cut without ellipsis
# in the real statement (e.g., "スポーツセンター" → "スポーツセン"). We apply the
# same rule so long-named stations don't visually collide with the ¥ balance.
ST_MAX_CHARS = 6


def _truncate_station(name: str, max_chars: int = ST_MAX_CHARS) -> str:
    """Truncate a station name to fit the ST column. Strips trailing 出 marker
    only after truncation so the suffix is preserved when possible."""
    if not name:
        return name
    suffix = ""
    if name.endswith("出"):
        suffix = "出"
        name = name[:-1]
    if len(name) > max_chars:
        name = name[:max_chars]
    return name + suffix


def _is_data_row(row: dict) -> bool:
    """A template row is a real data slot iff its month cell is a 2-digit number
    or the carryover marker 繰. Header (`月`), page footer (`(1/2)`, dates,
    `ご利用ありがとう…`, `東日本旅客鉄道株式会社`) all fail this check and are
    preserved untouched. Without this filter, `_rewrite_row`/`_clear_row` would
    redact the visual chrome of the template and the output PDF would lose its
    header row, footer block, and page numbers — a regression vs the real
    Mobile Suica statement.
    """
    month = str(row.get("month") or "").strip()
    return bool(re.fullmatch(r"\d{2}", month))


# ----------------------------------------------------------------------
# Template loader — bridges to suica_update.py parse_pdf()
# ----------------------------------------------------------------------


def _load_suica_update():
    """Dynamically import suica_update.py from sibling skill."""
    here = Path(__file__).resolve()
    candidate = here.parents[2] / "suica-pdf-editor" / "scripts" / "suica_update.py"
    if not candidate.exists():
        raise FileNotFoundError(
            f"suica_update.py not found at {candidate}. "
            "Phase 3 export requires the suica-pdf-editor skill."
        )
    spec = importlib.util.spec_from_file_location("suica_update", candidate)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ----------------------------------------------------------------------
# Formatting helpers
# ----------------------------------------------------------------------


def _format_balance(value: int) -> str:
    """Balance column: '\\1,234'."""
    return "\\" + f"{value:,}"


def _format_amount(value: int, kind: TapKind) -> str:
    """Amount column: '-341' for OUT, '+1,000' for AUTO, '0' for free transfers."""
    if value == 0:
        return "0"
    # OUT / SHOPPING / BUS deduct → negative
    if kind in (TapKind.OUT, TapKind.SHOPPING, TapKind.BUS):
        return "-" + f"{value:,}"
    # AUTO charges → positive
    if kind == TapKind.AUTO:
        return "+" + f"{value:,}"
    # IN should always be 0
    return "0"


def _format_type_and_stations(entry: TapEntry, in_stack: list[TapEntry]) -> tuple[str, str, str]:
    """Return (type, st_from, st_to) for the entry — Suica statement convention.

    For tap-in:  type='入', st_from=<station>+'出', st_to='' (blank, filled at OUT)
    For tap-out: type='入', st_from=<in_station>+'出', st_to=<out_station>
    For オートチャージ: type='ｵｰﾄﾁｬｰｼﾞ', st_from='ﾓﾊﾞｲﾙ', st_to=''
    For 物販: type='物販', st_from='', st_to=''
    Real Suica merges IN+OUT into ONE row, but our model emits them separately.
    We collapse them at render time.
    """
    if entry.kind == TapKind.IN:
        # Held in stack until matched OUT
        return ("入", f"{entry.station}出", "")
    if entry.kind == TapKind.OUT:
        last_in = in_stack[-1] if in_stack else None
        st_from = f"{last_in.station}出" if last_in else ""
        return ("入", st_from, entry.station)
    if entry.kind == TapKind.AUTO:
        return ("ｵｰﾄﾁｬｰｼﾞ", "ﾓﾊﾞｲﾙ", "")
    if entry.kind == TapKind.SHOPPING:
        return ("物販", "", "")
    if entry.kind == TapKind.BUS:
        return ("ﾊﾞｽ等", entry.station, "")
    return ("?", entry.station, "")


def _collapse_in_out(entries: list[TapEntry], initial_balance: int) -> list[dict]:
    """Real Suica statement merges IN+OUT into one row. Collapse them.
    Also prepends an opening-balance carryover row (繰).
    """
    rows: list[dict] = []
    # Row 0: opening balance carryover (繰)
    first_at = entries[0].at if entries else None
    rows.append({
        "at": first_at,
        "kind": None,
        "month": f"{first_at.month:02d}" if first_at else "",
        "day":   f"{first_at.day:02d}" if first_at else "",
        "type": "繰",
        "st_from": "",
        "st_to": "",
        "amount": None,
        "balance": initial_balance,
    })

    pending_in: TapEntry | None = None
    for e in entries:
        if e.kind == TapKind.IN:
            pending_in = e
            continue
        if e.kind == TapKind.OUT and pending_in is not None:
            rows.append({
                "at": pending_in.at,
                "kind": TapKind.OUT,
                "month": f"{pending_in.at.month:02d}",
                "day":   f"{pending_in.at.day:02d}",
                "type": "入",
                "st_from": f"{pending_in.station}出",
                "st_to": e.station,
                "amount": -e.fare_yen if e.fare_yen > 0 else 0,
                "balance": e.balance_yen,
            })
            pending_in = None
            continue
        # Standalone (no matching IN) — render alone
        if e.kind == TapKind.AUTO:
            rows.append({
                "at": e.at,
                "kind": TapKind.AUTO,
                "month": f"{e.at.month:02d}",
                "day":   f"{e.at.day:02d}",
                "type": "ｶｰﾄﾞ",  # Suica top-up: half-width "card"
                "st_from": "モバイル",  # full-width "mobile"
                "st_to": "",
                "amount": +e.fare_yen,
                "balance": e.balance_yen,
            })
        elif e.kind == TapKind.SHOPPING:
            rows.append({
                "at": e.at,
                "kind": TapKind.SHOPPING,
                "month": f"{e.at.month:02d}",
                "day":   f"{e.at.day:02d}",
                "type": "物販",
                "st_from": e.station,
                "st_to": "",
                "amount": -e.fare_yen,
                "balance": e.balance_yen,
            })
    return rows


# ----------------------------------------------------------------------
# Renderer
# ----------------------------------------------------------------------


class PdfExporter:
    def __init__(self, template_pdf: str, font_file: str = FONT_FILE_DEFAULT):
        if not Path(template_pdf).exists():
            raise FileNotFoundError(f"Template PDF not found: {template_pdf}")
        if not Path(font_file).exists():
            raise FileNotFoundError(f"Font file not found: {font_file}")
        self.template_pdf = template_pdf
        self.font_file = font_file

    def render(self, history: MonthlyHistory, output_pdf: str) -> dict:
        """Render and save PDF. Returns stats dict."""
        # 1. Parse template to discover row positions, then drop chrome rows
        #    (header, footer, page numbers) so we never redact them.
        su = _load_suica_update()
        all_rows = su.parse_pdf(self.template_pdf)
        template_rows = [r for r in all_rows if _is_data_row(r)]
        dropped = len(all_rows) - len(template_rows)
        log.info("Template has %d parsed rows; kept %d data rows (dropped %d chrome rows)",
                 len(all_rows), len(template_rows), dropped)

        # 2. Collapse IN+OUT pairs from history into single rows
        collapsed = _collapse_in_out(history.entries, history.initial_balance)
        log.info("History collapsed to %d rows", len(collapsed))

        # 3. Map: render min(M, N) rows
        n_render = min(len(template_rows), len(collapsed))
        n_clear  = max(0, len(template_rows) - n_render)
        truncated = max(0, len(collapsed) - n_render)
        if truncated:
            log.warning("Generated %d rows but template only fits %d — %d rows truncated",
                        len(collapsed), len(template_rows), truncated)

        # 4. Open template with PyMuPDF, redact + insert new text
        doc = fitz.open(self.template_pdf)
        try:
            for pg in range(len(doc)):
                doc[pg].insert_font(fontname=FONT_NAME, fontfile=self.font_file)

            # Group template rows by page for efficient processing
            rows_by_page: dict[int, list] = {}
            for r in template_rows:
                rows_by_page.setdefault(r["page"], []).append(r)

            flat_idx = 0
            for pg in range(len(doc)):
                page = doc[pg]
                page_rows = rows_by_page.get(pg, [])
                for tr in page_rows:
                    if flat_idx < n_render:
                        new = collapsed[flat_idx]
                        self._rewrite_row(page, tr, new)
                    else:
                        self._clear_row(page, tr)
                    flat_idx += 1
                # Apply all redactions for this page
                page.apply_redactions()

                # Second pass: insert text AFTER redactions (PyMuPDF removes
                # underlying text under redact rects).
                flat_idx2 = flat_idx - len(page_rows)
                for tr in page_rows:
                    if flat_idx2 < n_render:
                        new = collapsed[flat_idx2]
                        self._insert_row_text(page, tr, new)
                    flat_idx2 += 1

            # Subset embedded fonts to only glyphs actually used. Without this,
            # PyMuPDF embeds the full IPA Gothic (~5 MB) into the PDF on every
            # `insert_text` call, ballooning the output from ~150 KB to 4-5 MB.
            # Real Mobile Suica PDFs ship with subsetted fonts so the user
            # noticed the size mismatch immediately.
            try:
                doc.subset_fonts()
            except Exception as e:
                log.warning("subset_fonts() failed (continuing without subset): %s", e)
            doc.save(
                output_pdf,
                deflate=True,
                deflate_fonts=True,
                garbage=4,
                clean=True,
                use_objstms=1,
            )
        finally:
            doc.close()

        return {
            "template_rows": len(template_rows),
            "history_rows":  len(collapsed),
            "rendered":      n_render,
            "cleared":       n_clear,
            "truncated":     truncated,
            "output":        output_pdf,
        }

    # ------------------------------------------------------------------

    def _rewrite_row(self, page: fitz.Page, template_row: dict, new: dict) -> None:
        """Stage 1: add redactions for all columns of one row."""
        y = template_row["y"]
        h = FONT_SIZE + 2
        # Wide redact strips per column (clears old glyphs):
        spans_to_redact = [
            ("M",  COL_X["M"] - 2, COL_X["M"] + 20),
            ("D",  COL_X["D"] - 2, COL_X["D"] + 20),
            ("T",  COL_X["T"] - 2, COL_X["T"] + 55),
            ("SF", COL_X["SF"] - 2, COL_X["SF"] + 110),
            ("ST", COL_X["ST"] - 2, COL_X["ST"] + 58),
            ("B",  BAL_RIGHT - 30, BAL_RIGHT + 2),
            ("A",  AMT_RIGHT - 65, AMT_RIGHT + 2),
        ]
        for _, x0, x1 in spans_to_redact:
            rect = fitz.Rect(x0, y - 1, x1, y + h)
            page.add_redact_annot(rect, fill=(1, 1, 1))

    def _clear_row(self, page: fitz.Page, template_row: dict) -> None:
        """Empty an unused template row (just redact, no re-insert)."""
        y = template_row["y"]
        h = FONT_SIZE + 2
        rect = fitz.Rect(COL_X["M"] - 2, y - 1, AMT_RIGHT + 2, y + h)
        page.add_redact_annot(rect, fill=(1, 1, 1))

    def _insert_row_text(self, page: fitz.Page, template_row: dict, new: dict) -> None:
        """Stage 2: insert new text after redactions are applied."""
        y = template_row["y"]
        baseline = y + FONT_SIZE * 0.85
        fp = dict(fontname=FONT_NAME, fontfile=self.font_file, fontsize=FONT_SIZE)

        page.insert_text((COL_X["M"], baseline), new["month"], **fp)
        page.insert_text((COL_X["D"], baseline), new["day"], **fp)
        page.insert_text((COL_X["T"], baseline), new["type"], **fp)
        if new["st_from"]:
            page.insert_text((COL_X["SF"], baseline), _truncate_station(new["st_from"]), **fp)
        if new["st_to"]:
            page.insert_text((COL_X["ST"], baseline), _truncate_station(new["st_to"]), **fp)

        bal_text = _format_balance(new["balance"])
        bal_w = len(bal_text) * GLYPH_W
        page.insert_text((BAL_RIGHT - bal_w, baseline), bal_text, **fp)

        # Amount column — opening row (kind=None) leaves blank
        if new["amount"] is None:
            return
        if new["amount"] < 0:
            amt_text = "-" + f"{abs(new['amount']):,}"
        elif new["amount"] > 0:
            amt_text = "+" + f"{new['amount']:,}"
        else:
            amt_text = "0"
        amt_w = len(amt_text) * GLYPH_W
        page.insert_text((AMT_RIGHT - amt_w, baseline), amt_text, **fp)


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main() -> None:
    import argparse, json
    import datetime as dt

    p = argparse.ArgumentParser(description="Render Suica history JSON to PDF")
    p.add_argument("history_json", help="Input MonthlyHistory JSON")
    p.add_argument("--template", required=True, help="Template Suica PDF (real)")
    p.add_argument("--out",       required=True, help="Output PDF path")
    p.add_argument("--font",      default=FONT_FILE_DEFAULT)
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")

    raw = json.load(open(args.history_json, encoding="utf-8"))
    for e in raw.get("entries", []):
        if isinstance(e.get("at"), str):
            e["at"] = dt.datetime.fromisoformat(e["at"])
    hist = MonthlyHistory(**raw)

    exporter = PdfExporter(args.template, args.font)
    stats = exporter.render(hist, args.out)

    print(f"=== PDF export ===")
    for k, v in stats.items():
        print(f"  {k:14s}: {v}")


if __name__ == "__main__":
    main()
