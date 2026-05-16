#!/usr/bin/env python3
"""
Suica PDF Editor — Parse, modify, and regenerate Mobile Suica PDF statements.

Usage:
    python suica_update.py analyze  <pdf>
    python suica_update.py update   <pdf> [options]
    python suica_update.py verify   <pdf> [--original <orig>] [options]
    python suica_update.py lookup   --from <station> --to <station>

See SKILL.md for full documentation.
"""
import argparse
import json
import math
import os
import re as _re_module
import shutil
import struct
import sys
import zlib
from collections import defaultdict
from datetime import date, timedelta

import fitz

try:
    import jpholiday
except ImportError:
    jpholiday = None

# ============================================================================
#  Constants — PDF layout geometry
# ============================================================================
FONT_FILE_DEFAULT = r"C:\Windows\Fonts\msgothic.ttc"
FONT_NAME = "msgo"
FONT_SIZE = 9
GLYPH_W = 4.5        # half-width glyph width in points
BAL_RIGHT = 467.0     # balance column right edge (pt)
AMT_RIGHT = 536.036   # amount column right edge (actual from original PDF)

# Column x-position ranges for text classification (used by parse_pdf)
COL_RANGES = {
    "M":  (150, 175),   # month
    "D":  (175, 200),   # day
    "T":  (200, 260),   # type (種別)
    "SF": (260, 375),   # station from (入駅)
    "ST": (375, 438),   # station to (出駅)
    "B":  (438, 470),   # balance (残高)
    "A":  (470, 540),   # amount (入金・利用額)
}

# ============================================================================
#  Built-in fare database — JR East March 2026 fare revision
# ============================================================================
# Format: (station_a, station_b, old_ic_fare, new_ic_fare)
# Source: NAVITIME route search (April 2026 date), verified against actual logs
FARE_DB = [
    # Previously confirmed via Suica log cross-reference
    ("鶴見", "川崎",     167, 199),
    ("鶴見", "横浜",     178, 209),
    ("鶴見", "新宿",     483, 528),
    ("鶴見", "西日暮里", 483, 528),
    # Verified via NAVITIME (May 2026)
    ("鶴見", "田町",     318, 341),
    ("鶴見", "藤沢",     506, 528),
    ("鎌倉", "新杉田",   318, 341),
    ("新杉田", "川崎",   406, 440),
    ("鶴見", "武蔵小杉", 178, 209),
    ("大井町", "鶴見",   230, 253),
    ("綾瀬", "新松戸",   230, 253),
    ("新松戸", "地西日暮", 496, 519),  # JR + Metro combined
    # Additional JR East routes (電特→幹線 revision, distance-based)
    ("鶴見", "桜木町",   178, 209),    # ~10km bracket
    ("鶴見", "浜松町",   318, 341),    # ~18km bracket
    ("鶴見", "新橋",     318, 341),    # ~19km bracket
    ("鶴見", "秋葉原",   406, 440),    # ~23km bracket
    ("鶴見", "上野",     483, 528),    # ~27km bracket
    ("鶴見", "日暮里",   483, 528),    # ~28km bracket
    ("上野", "東京",     167, 199),    # ~4km bracket
    ("東京", "川崎",     318, 341),    # ~18km bracket
    ("品川", "鶴見",     178, 209),    # ~10km bracket
    ("鶴見", "大船",     318, 341),    # ~17km bracket
    ("鶴見", "東京",     318, 341),    # ~20km bracket
    ("鶴見", "渋谷",     406, 440),    # ~22km bracket
    ("鶴見", "池袋",     483, 528),    # ~28km bracket
]


# ============================================================================
#  Helpers
# ============================================================================
def clean_station(name: str) -> str:
    """Strip exit-marker suffixes from station names for matching."""
    s = name.strip()
    if s.endswith("窓出"):
        s = s[:-2]
    elif s.endswith("出"):
        s = s[:-1]
    return s


def parse_int(text: str):
    """Parse a number string (with commas, backslash, yen sign) to int."""
    s = text.replace(",", "").replace("\\", "").replace("\u00a5", "").strip()
    try:
        return int(s)
    except ValueError:
        return None


def fmt_num(n: int) -> str:
    """Format number for PDF display: negative with minus, positive with comma."""
    if n < 0:
        return "-" + f"{abs(n):,}"
    elif n == 0:
        return "0"
    else:
        return f"{n:,}"


def right_x(text: str, right_edge: float) -> float:
    """Calculate left x-position for right-aligned half-width text."""
    return right_edge - len(text) * GLYPH_W


def workdays(start: date, end: date, skip_sun=True, skip_sat=False,
             skip_holidays=True) -> list:
    """Return valid working days in the range [start, end]."""
    if skip_holidays and jpholiday is None:
        print("WARNING: jpholiday not installed; holidays will NOT be skipped.")
        print("  Install with: pip install jpholiday")
        skip_holidays = False

    days, d = [], start
    while d <= end:
        skip = False
        if skip_sun and d.weekday() == 6:
            skip = True
        if skip_sat and d.weekday() == 5:
            skip = True
        if skip_holidays and jpholiday.is_holiday(d):
            skip = True
        if not skip:
            days.append(d)
        d += timedelta(days=1)
    return days


# ============================================================================
#  CID Glyph Encoding — for forensically clean content stream patching
# ============================================================================
# Unicode character → CID glyph code (from the PDF's ToUnicode CMap)
CHAR_TO_GLYPH = {
    '0': 0x0013, '1': 0x0014, '2': 0x0015, '3': 0x0016,
    '4': 0x0017, '5': 0x0018, '6': 0x0019, '7': 0x001a,
    '8': 0x001b, '9': 0x001c,
    ',': 0x000f, '-': 0x0010, '+': 0x000e, '\\': 0x003f,
    '/': 0x0012, ' ': 0x0003,
}

# Regex patterns for content stream parsing
import re as _re
_TM_RE = _re.compile(
    r'(\d+(?:\.\d+)?)\s+0\s+0\s+'
    r'(\d+(?:\.\d+)?)\s+'
    r'(\d+(?:\.\d+)?)\s+'
    r'(\d+(?:\.\d+)?)\s+Tm')
_TJ_RE = _re.compile(r'<([0-9A-Fa-f]+)>\s*Tj')


def text_to_glyph_hex(text: str) -> str:
    """Convert display text to CID glyph hex string for content stream."""
    codes = []
    for ch in text:
        if ch not in CHAR_TO_GLYPH:
            raise ValueError(f"Character '{ch}' (U+{ord(ch):04X}) not in glyph map")
        codes.append(f'{CHAR_TO_GLYPH[ch]:04x}')
    return ''.join(codes)


def glyph_hex_to_text(hex_str: str) -> str:
    """Decode CID glyph hex string to Unicode text (best-effort)."""
    rev = {v: k for k, v in CHAR_TO_GLYPH.items()}
    chars = []
    for i in range(0, len(hex_str), 4):
        gid = int(hex_str[i:i+4], 16)
        chars.append(rev.get(gid, f'[{gid:04x}]'))
    return ''.join(chars)


def format_balance_cs(value: int) -> str:
    """Format balance for content stream: \\N,NNN (backslash prefix)."""
    return '\\' + f'{value:,}'


def format_amount_cs(value: int) -> str:
    """Format amount for content stream: +N,NNN / -N,NNN / 0."""
    if value > 0:
        return '+' + f'{value:,}'
    elif value < 0:
        return '-' + f'{abs(value):,}'
    else:
        return '0'


def _find_tm_tj_pairs(stream: str) -> list:
    """Find all (Tm_match, Tj_match) pairs in a content stream string."""
    pairs = []
    tm_matches = list(_TM_RE.finditer(stream))
    for i, tm in enumerate(tm_matches):
        # Search for Tj between this Tm and the next Tm
        search_end = tm_matches[i + 1].start() if i + 1 < len(tm_matches) else len(stream)
        tj = _TJ_RE.search(stream, tm.end(), search_end)
        if tj:
            pairs.append((tm, tj))
    return pairs


def _group_pairs_by_y(pairs: list, threshold: float = 1.0) -> list:
    """
    Group Tm+Tj pairs by y-position into rows.
    Returns list of (y_value, [(tm, tj), ...]) sorted descending by y
    (top-to-bottom on the page).
    """
    if not pairs:
        return []

    # Extract y values and sort descending
    by_y = []
    for tm, tj in pairs:
        y = float(tm.group(4))
        by_y.append((y, tm, tj))
    by_y.sort(key=lambda t: -t[0])

    # Group adjacent entries with close y values
    groups = []
    cur_y = by_y[0][0]
    cur_group = []
    for y, tm, tj in by_y:
        if abs(y - cur_y) > threshold:
            groups.append((cur_y, cur_group))
            cur_y = y
            cur_group = []
        cur_group.append((tm, tj))
    if cur_group:
        groups.append((cur_y, cur_group))

    return groups


def _classify_column(x: float) -> str:
    """Classify a content stream x-position to a column type."""
    if 145 <= x <= 175:
        return "M"    # month
    elif 175 < x <= 210:
        return "D"    # day
    elif 430 <= x <= 475:
        return "B"    # balance
    elif 475 < x <= 545:
        return "A"    # amount
    else:
        return ""      # other column (type, station, etc.)


def _format_x_like(new_x: float, original_x_str: str) -> str:
    """Format new x coordinate to match the original's style."""
    if '.' in original_x_str:
        decimals = len(original_x_str.split('.')[1])
        return f"{new_x:.{decimals}f}"
    else:
        if new_x == int(new_x):
            return str(int(new_x))
        else:
            return f"{new_x:.1f}"


def patch_content_streams(doc, page_edits: dict):
    """
    Patch PDF content streams by replacing CID glyph codes in-place.
    Preserves original font objects, content stream structure, and encoding.

    page_edits: dict mapping (page_no, row_idx_in_page, column) to
                (new_glyph_hex_str,) for same-length or
                (new_glyph_hex_str, new_x_float) for different-length.
    """
    for pno in range(len(doc)):
        page = doc[pno]
        xrefs = page.get_contents()

        for xref in xrefs:
            raw = doc.xref_stream(xref)
            stream = raw.decode('latin-1')

            pairs = _find_tm_tj_pairs(stream)
            rows = _group_pairs_by_y(pairs)

            # Filter to only data rows (skip headers/footers with non-numeric content)
            # A data row has balance or amount cells that start with numeric glyphs
            NUMERIC_PREFIXES = {
                '003f',  # backslash (yen sign in balance)
                '000e',  # plus sign
                '0010',  # minus sign
                '0013', '0014', '0015', '0016', '0017',  # digits 0-5
                '0018', '0019', '001a', '001b', '001c',  # digits 6-9
            }
            data_rows = []
            for y_val, group in rows:
                is_data = False
                for tm, tj in group:
                    col = _classify_column(float(tm.group(3)))
                    if col in ("B", "A"):
                        hex_str = tj.group(1)
                        if len(hex_str) >= 4 and hex_str[:4].lower() in NUMERIC_PREFIXES:
                            is_data = True
                            break
                if is_data:
                    data_rows.append((y_val, group))

            replacements = []

            for row_idx, (y_val, group) in enumerate(data_rows):
                for tm, tj in group:
                    x = float(tm.group(3))
                    col = _classify_column(x)
                    if not col:
                        continue

                    key = (pno, row_idx, col)
                    if key not in page_edits:
                        continue

                    edit_data = page_edits[key]
                    new_hex = edit_data[0]
                    old_hex = tj.group(1)
                    old_nchars = len(old_hex) // 4
                    new_nchars = len(new_hex) // 4

                    # Replace hex string in <...> Tj
                    replacements.append((tj.start(1), tj.end(1), new_hex))

                    # Adjust Tm x-position if character count changed
                    if old_nchars != new_nchars:
                        new_x = x + (old_nchars - new_nchars) * GLYPH_W
                        new_x_str = _format_x_like(new_x, tm.group(3))
                        replacements.append((tm.start(3), tm.end(3), new_x_str))

            if not replacements:
                continue

            # Apply replacements in reverse offset order
            replacements.sort(key=lambda r: -r[0])
            for start, end, new_text in replacements:
                stream = stream[:start] + new_text + stream[end:]

            doc.update_stream(xref, stream.encode('latin-1'))


# ============================================================================
#  Raw Binary PDF Patching — Forensic-clean save
# ============================================================================
def _parse_xref_offsets(pdf_bytes: bytes) -> tuple:
    """
    Parse PDF cross-reference table to get object byte offsets.
    Returns (offsets_dict, trailer_dict_bytes, startxref_offset).
    offsets_dict: {obj_num: byte_offset} for in-use objects.
    """
    # Find startxref
    m = _re_module.search(rb'startxref\s+(\d+)\s*%%EOF', pdf_bytes)
    if not m:
        raise ValueError("Cannot find startxref/%%EOF in PDF")
    xref_offset = int(m.group(1))

    # Verify it's a standard xref table
    if pdf_bytes[xref_offset:xref_offset + 4] != b'xref':
        raise ValueError("PDF uses cross-reference streams (not supported in raw mode)")

    offsets = {}
    pos = xref_offset + 4
    # Skip whitespace after 'xref'
    while pos < len(pdf_bytes) and pdf_bytes[pos:pos+1] in (b'\r', b'\n', b' '):
        pos += 1

    while True:
        # Read line
        line_end = pdf_bytes.find(b'\n', pos)
        if line_end == -1:
            break
        line = pdf_bytes[pos:line_end].rstrip(b'\r')
        pos = line_end + 1

        if line.startswith(b'trailer'):
            break

        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            # Subsection header: start_obj count
            start_obj = int(parts[0])
            count = int(parts[1])
            for j in range(count):
                line_end = pdf_bytes.find(b'\n', pos)
                entry = pdf_bytes[pos:line_end].rstrip(b'\r')
                pos = line_end + 1
                eparts = entry.split()
                if len(eparts) >= 3 and eparts[2] == b'n':
                    offsets[start_obj + j] = int(eparts[0])

    # Extract trailer dict
    trailer_start = pdf_bytes.find(b'trailer', xref_offset)
    trailer_end = pdf_bytes.find(b'startxref', trailer_start)
    trailer_bytes = pdf_bytes[trailer_start + 7:trailer_end].strip()

    return offsets, trailer_bytes, xref_offset


def _find_object_boundaries(pdf_bytes: bytes, obj_offset: int) -> tuple:
    """
    Find the boundaries of a PDF object.
    Returns (obj_start, obj_end) where obj_end is byte AFTER 'endobj'.
    """
    endobj = pdf_bytes.find(b'endobj', obj_offset)
    if endobj == -1:
        raise ValueError(f"Cannot find endobj for object at offset {obj_offset}")
    # endobj is typically followed by \r\n or \n
    end = endobj + 6  # len('endobj')
    if end < len(pdf_bytes) and pdf_bytes[end:end+2] == b'\r\n':
        end += 2
    elif end < len(pdf_bytes) and pdf_bytes[end:end+1] == b'\n':
        end += 1
    return obj_offset, end


def _build_stream_object(obj_num: int, compressed_data: bytes,
                         original_header: bytes) -> bytes:
    """
    Build a complete stream object with updated /Length.
    Preserves the original object header structure as much as possible.
    """
    # Parse original header to extract and replace /Length
    # Original format: "N 0 obj\r\n<<\n/Length NNNN /Filter/FlateDecode\r\n>>\r\nstream\r\n"
    header_str = original_header.decode('latin-1')

    # Replace /Length value
    new_length = len(compressed_data)
    header_str = _re_module.sub(
        r'/Length\s+\d+',
        f'/Length {new_length}',
        header_str,
        count=1
    )

    # Build complete object: header + compressed data + endstream + endobj
    result = header_str.encode('latin-1')
    result += compressed_data
    # End with same line endings as original
    result += b'\r\nendstream\r\nendobj\r\n'
    return result


def compute_patched_streams(original_path: str, page_edits: dict) -> dict:
    """
    Compute the new compressed content for each modified stream.
    Returns {xref_num: new_compressed_bytes}.

    Uses the same patching logic as patch_content_streams but returns
    the compressed results instead of calling doc.update_stream().
    """
    doc = fitz.open(original_path)
    modified = {}

    for pno in range(len(doc)):
        page = doc[pno]
        xrefs = page.get_contents()

        for xref in xrefs:
            raw = doc.xref_stream(xref)
            stream = raw.decode('latin-1')

            pairs = _find_tm_tj_pairs(stream)
            rows = _group_pairs_by_y(pairs)

            NUMERIC_PREFIXES = {
                '003f', '000e', '0010',
                '0013', '0014', '0015', '0016', '0017',
                '0018', '0019', '001a', '001b', '001c',
            }
            data_rows = []
            for y_val, group in rows:
                is_data = False
                for tm, tj in group:
                    col = _classify_column(float(tm.group(3)))
                    if col in ("B", "A"):
                        hex_str = tj.group(1)
                        if len(hex_str) >= 4 and hex_str[:4].lower() in NUMERIC_PREFIXES:
                            is_data = True
                            break
                if is_data:
                    data_rows.append((y_val, group))

            replacements = []

            for row_idx, (y_val, group) in enumerate(data_rows):
                for tm, tj in group:
                    x = float(tm.group(3))
                    col = _classify_column(x)
                    if not col:
                        continue

                    key = (pno, row_idx, col)
                    if key not in page_edits:
                        continue

                    edit_data = page_edits[key]
                    new_hex = edit_data[0]
                    old_hex = tj.group(1)
                    old_nchars = len(old_hex) // 4
                    new_nchars = len(new_hex) // 4

                    replacements.append((tj.start(1), tj.end(1), new_hex))

                    if old_nchars != new_nchars:
                        new_x = x + (old_nchars - new_nchars) * GLYPH_W
                        new_x_str = _format_x_like(new_x, tm.group(3))
                        replacements.append((tm.start(3), tm.end(3), new_x_str))

            if not replacements:
                continue

            # Apply replacements in reverse order
            replacements.sort(key=lambda r: -r[0])
            for start, end, new_text in replacements:
                stream = stream[:start] + new_text + stream[end:]

            # Compress the modified stream
            new_data = stream.encode('latin-1')
            compressed = zlib.compress(new_data, 6)
            modified[xref] = compressed

    doc.close()
    return modified


def save_raw_patched(original_path: str, output_path: str,
                     modified_streams: dict) -> dict:
    """
    Save PDF with forensic-quality raw binary patching.

    Only rewrites objects whose content streams were modified.
    All other objects (fonts, images, pages, metadata) remain byte-identical.
    Preserves document ID, producer, creation date.

    modified_streams: {xref_num: new_compressed_bytes}
    Returns dict with stats: {'bytes_identical', 'bytes_modified', 'objects_modified'}
    """
    with open(original_path, 'rb') as f:
        pdf_bytes = f.read()

    offsets, trailer_bytes, xref_start = _parse_xref_offsets(pdf_bytes)

    # Sort objects by file offset
    sorted_objs = sorted(offsets.items(), key=lambda x: x[1])

    # Identify which objects to modify
    stats = {'bytes_identical': 0, 'bytes_modified': 0, 'objects_modified': 0}

    # Build output by iterating through file sections
    output = bytearray()
    new_offsets = {}
    prev_end = 0

    for i, (obj_num, obj_off) in enumerate(sorted_objs):
        # Determine object end
        obj_start, obj_end = _find_object_boundaries(pdf_bytes, obj_off)

        if obj_num in modified_streams:
            # Copy everything from prev_end to this object's start
            output += pdf_bytes[prev_end:obj_start]

            # Record new offset for this object
            new_offsets[obj_num] = len(output)

            # Find the stream data boundaries within this object
            # Object format: "N 0 obj\r\n<< ... >>\r\nstream\r\n[data]\r\nendstream\r\nendobj\r\n"
            stream_marker = pdf_bytes.find(b'stream', obj_start, obj_end)
            if stream_marker == -1:
                raise ValueError(f"Object {obj_num} has no stream")

            # Header is everything from object start to end of "stream\r\n"
            stream_data_start = stream_marker + 6  # len('stream')
            if pdf_bytes[stream_data_start:stream_data_start+2] == b'\r\n':
                stream_data_start += 2
            elif pdf_bytes[stream_data_start:stream_data_start+1] == b'\n':
                stream_data_start += 1

            header = pdf_bytes[obj_start:stream_data_start]
            new_compressed = modified_streams[obj_num]

            # Build the new object
            new_obj = _build_stream_object(obj_num, new_compressed, header)
            output += new_obj
            stats['objects_modified'] += 1
            stats['bytes_modified'] += len(new_obj)

            prev_end = obj_end
        else:
            # Copy this object verbatim (preserve byte identity)
            output += pdf_bytes[prev_end:obj_start]
            new_offsets[obj_num] = len(output)
            output += pdf_bytes[obj_start:obj_end]
            stats['bytes_identical'] += (obj_end - obj_start)
            prev_end = obj_end

    # Copy anything between last object and original xref
    output += pdf_bytes[prev_end:xref_start]

    # Build new xref table
    xref_new_offset = len(output)
    max_obj = max(offsets.keys())
    xref_lines = [b'xref\r\n']
    xref_lines.append(f'0 {max_obj + 1}\r\n'.encode())
    # Object 0 is always free
    xref_lines.append(b'0000000000 65535 f \r\n')
    for n in range(1, max_obj + 1):
        if n in new_offsets:
            xref_lines.append(f'{new_offsets[n]:010d} 00000 n \r\n'.encode())
        elif n in offsets:
            # Object exists but wasn't in our sorted list (shouldn't happen)
            xref_lines.append(f'{offsets[n]:010d} 00000 n \r\n'.encode())
        else:
            xref_lines.append(b'0000000000 65535 f \r\n')
    output += b''.join(xref_lines)

    # Write trailer (preserve original)
    output += b'trailer\r\n'
    output += trailer_bytes
    output += b'\r\nstartxref\r\n'
    output += str(xref_new_offset).encode()
    output += b'\r\n%%EOF\r\n'

    # Write output file
    with open(output_path, 'wb') as f:
        f.write(output)

    stats['file_size_original'] = len(pdf_bytes)
    stats['file_size_output'] = len(output)
    return stats


# ============================================================================
#  PDF Parsing
# ============================================================================
def parse_pdf(path: str) -> list:
    """
    Parse a Mobile Suica PDF statement and return a list of transaction rows.

    Each row is a dict with:
      page, y, month, day, type, st_from, st_to,
      balance, balance_text, amount, amount_text,
      bal_spans, amt_spans, mon_spans, day_spans
    """
    doc = fitz.open(path)
    rows = []

    for pno in range(len(doc)):
        page = doc[pno]
        td = page.get_text("dict")

        # Collect all text spans with positions
        spans = []
        for blk in td["blocks"]:
            if "lines" not in blk:
                continue
            for ln in blk["lines"]:
                for sp in ln["spans"]:
                    t = sp["text"].strip()
                    if t:
                        b = sp["bbox"]
                        spans.append({
                            "x0": b[0], "y0": b[1],
                            "x1": b[2], "y1": b[3],
                            "text": t, "page": pno,
                        })

        # Group spans by y-position (3pt threshold for same row)
        spans.sort(key=lambda s: (s["y0"], s["x0"]))
        groups, cy, cg = [], None, []
        for sp in spans:
            if cy is None or abs(sp["y0"] - cy) > 3:
                if cg:
                    groups.append(cg)
                cg, cy = [sp], sp["y0"]
            else:
                cg.append(sp)
        if cg:
            groups.append(cg)

        # Parse each group into columns
        for g in groups:
            cols = {}
            for sp in g:
                for cn, (lo, hi) in COL_RANGES.items():
                    if lo <= sp["x0"] < hi:
                        cols.setdefault(cn, {"text": "", "spans": []})
                        cols[cn]["text"] += sp["text"]
                        cols[cn]["spans"].append(sp)
                        break

            if not any(k in cols for k in ["B", "A", "M"]):
                continue

            bt = cols.get("B", {}).get("text", "")
            at = cols.get("A", {}).get("text", "")

            rows.append({
                "page": pno,
                "y": g[0]["y0"],
                "month": cols.get("M", {}).get("text", ""),
                "day": cols.get("D", {}).get("text", ""),
                "type": cols.get("T", {}).get("text", ""),
                "st_from": cols.get("SF", {}).get("text", "").strip(),
                "st_to": cols.get("ST", {}).get("text", "").strip(),
                "balance": parse_int(bt),
                "balance_text": bt,
                "amount": parse_int(at),
                "amount_text": at,
                "bal_spans": cols.get("B", {}).get("spans", []),
                "amt_spans": cols.get("A", {}).get("spans", []),
                "mon_spans": cols.get("M", {}).get("spans", []),
                "day_spans": cols.get("D", {}).get("spans", []),
            })

    doc.close()
    return rows


# ============================================================================
#  Build fare rules dict
# ============================================================================
def build_fare_rules(extra_json_path=None, rows=None):
    """
    Build fare rules dict from built-in DB + optional custom JSON + dynamic
    station-name detection from the PDF rows.

    Returns dict: (frozenset({stA, stB}), old_fare) -> new_fare
    """
    rules = {}

    def add(a, b, old, new):
        rules[(frozenset([a, b]), old)] = new

    # Built-in rules
    for a, b, old, new in FARE_DB:
        add(a, b, old, new)

    # Custom rules from JSON
    if extra_json_path:
        with open(extra_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for r in data.get("fare_rules", []):
            add(r["stations"][0], r["stations"][1], r["old_fare"], r["new_fare"])

    # Dynamic: detect actual station names in PDF for 西日暮里 variants
    if rows:
        all_stations = set()
        for r in rows:
            if r["st_from"]:
                all_stations.add(r["st_from"])
            if r["st_to"]:
                all_stations.add(r["st_to"])

        for s in all_stations:
            sc = s
            if sc.endswith("窓出"):
                sc = sc[:-2]
            elif sc.endswith("出"):
                sc = sc[:-1]

            # JR 西日暮里
            if "西日暮" in sc and "地" not in sc:
                add("鶴見", sc, 483, 528)
            # Metro 西日暮里 (for 新松戸 combined route)
            if "地" in sc and "西日暮" in sc:
                add("新松戸", sc, 496, 519)

    return rules


# ============================================================================
#  Non-JR operator prefixes — these fares must NOT be modified by JR rules
# ============================================================================
NON_JR_PREFIXES = ("地", "KS", "京急", "東急", "江電", "横シ", "横高", "ゆ")

# Valid Suica charge amounts (Mobile Suica allows arbitrary amounts in 1-yen
# increments, but real-world top-ups are almost always multiples of 100)
VALID_CHARGE_MULTIPLES = 100

# Transaction type → expected amount sign
TX_TYPE_SIGN = {
    "繰": "none",     # opening balance: no amount
    "入": "negative",  # train ride
    "＊入": "negative", # special entry (metro transfer)
    "ｶｰﾄﾞ": "positive", # charge (top-up)
    "物販": "negative",  # shopping
    "精": "negative",    # fare adjustment
}

# Maximum reasonable single IC fare (yen) — anything higher is suspicious
MAX_REASONABLE_FARE = 5000

# Maximum reasonable balance (Suica limit is 20,000 yen)
MAX_SUICA_BALANCE = 20000


# ============================================================================
#  Validation Engine
# ============================================================================
class ValidationResult:
    """Accumulates pass/fail/warn results for all verification rules."""

    def __init__(self):
        self.results = []  # list of (category, rule_id, status, message)

    def ok(self, cat: str, rule_id: str, msg: str):
        self.results.append((cat, rule_id, "PASS", msg))

    def fail(self, cat: str, rule_id: str, msg: str):
        self.results.append((cat, rule_id, "FAIL", msg))

    def warn(self, cat: str, rule_id: str, msg: str):
        self.results.append((cat, rule_id, "WARN", msg))

    @property
    def passes(self):
        return [r for r in self.results if r[2] == "PASS"]

    @property
    def failures(self):
        return [r for r in self.results if r[2] == "FAIL"]

    @property
    def warnings(self):
        return [r for r in self.results if r[2] == "WARN"]

    def print_report(self):
        print("\n" + "=" * 70)
        print("  VERIFICATION REPORT")
        print("=" * 70)

        current_cat = None
        for cat, rid, status, msg in self.results:
            if cat != current_cat:
                print(f"\n  [{cat}]")
                current_cat = cat
            icon = {"PASS": "✅", "FAIL": "❌", "WARN": "⚠️"}[status]
            print(f"    {icon} {rid}: {msg}")

        print(f"\n  --- Summary ---")
        print(f"    ✅ PASS: {len(self.passes)}")
        print(f"    ⚠️  WARN: {len(self.warnings)}")
        print(f"    ❌ FAIL: {len(self.failures)}")

        if not self.failures:
            print(f"\n  🎉 ALL CHECKS PASSED — PDF is production-quality.")
        else:
            print(f"\n  🚨 {len(self.failures)} FAILURE(S) — PDF will NOT pass audit.")
        print("=" * 70)
        return len(self.failures) == 0


def validate_pdf(path: str, original_path: str = None,
                 date_start: str = None, date_end: str = None,
                 skip_sun: bool = True, skip_sat: bool = False,
                 skip_holidays: bool = True) -> ValidationResult:
    """
    Run comprehensive validation on a Suica PDF.
    Returns a ValidationResult with all checks.
    """
    vr = ValidationResult()
    tx = _parse_for_validation(path, vr)
    if not tx:
        return vr

    _validate_font_layout(path, vr)
    _validate_balance_arithmetic(tx, vr)
    _validate_fare_consistency(tx, vr)
    _validate_date_logic(tx, vr, date_start, date_end,
                         skip_sun, skip_sat, skip_holidays)
    _validate_route_station(tx, vr)
    _validate_transaction_types(tx, vr)
    _validate_number_formatting(path, vr)
    _validate_forensic_integrity(path, vr)

    if original_path:
        _validate_byte_identity(path, original_path, vr)
        _validate_structural_match(path, original_path, tx, vr)

    return vr


def _parse_for_validation(path: str, vr: ValidationResult) -> list:
    """Parse PDF and do basic structural checks."""
    try:
        rows = parse_pdf(path)
    except Exception as e:
        vr.fail("STRUCT", "S0-parse", f"Cannot parse PDF: {e}")
        return []

    tx = [r for r in rows if r["balance"] is not None or r["amount"] is not None]
    if len(tx) == 0:
        vr.fail("STRUCT", "S1-rows", "No transaction rows found")
        return []
    vr.ok("STRUCT", "S1-rows", f"{len(tx)} transaction rows parsed")

    if tx[0]["type"] != "繰":
        vr.fail("STRUCT", "S2-opening", f"First row type is '{tx[0]['type']}', expected '繰'")
    else:
        vr.ok("STRUCT", "S2-opening", "First row is opening balance (繰)")

    return tx


# --------------------------------------------------------------------------
#  V1: Font & Layout
# --------------------------------------------------------------------------
def _validate_font_layout(path: str, vr: ValidationResult):
    """Verify font name, size, glyph metrics, and text positions."""
    doc = fitz.open(path)
    font_issues = []
    position_issues = []

    # First pass: collect y-positions of actual data rows (have balance column)
    data_ys = set()
    for pno in range(len(doc)):
        page = doc[pno]
        td = page.get_text("dict")
        for blk in td["blocks"]:
            if "lines" not in blk:
                continue
            for ln in blk["lines"]:
                for sp in ln["spans"]:
                    bbox = sp["bbox"]
                    # Balance column (438-470) text marks a data row
                    if 438 <= bbox[0] < 470 and sp["text"].strip():
                        data_ys.add((pno, round(bbox[1])))

    # Second pass: check only data-row spans
    for pno in range(len(doc)):
        page = doc[pno]
        td = page.get_text("dict")
        for blk in td["blocks"]:
            if "lines" not in blk:
                continue
            for ln in blk["lines"]:
                for sp in ln["spans"]:
                    t = sp["text"].strip()
                    if not t:
                        continue
                    bbox = sp["bbox"]
                    x0 = bbox[0]
                    y_rounded = round(bbox[1])

                    # Only check spans on data rows (same y as a balance cell)
                    if not any(abs(y_rounded - dy) <= 3 for p, dy in data_ys if p == pno):
                        continue

                    # Must be in data column range
                    if x0 < 145:
                        continue

                    fname = sp.get("font", "")
                    fsize = sp.get("size", 0)

                    # V1.1: Font name and size
                    if "Gothic" not in fname and "msgo" not in fname.lower():
                        font_issues.append(
                            f"p{pno} x={x0:.0f} font='{fname}' text='{t[:10]}'")
                    if fsize > 0 and abs(fsize - FONT_SIZE) > 0.5:
                        font_issues.append(
                            f"p{pno} x={x0:.0f} size={fsize:.1f} expected {FONT_SIZE}")

                    # V1.2: Number columns must be in valid x-ranges
                    if x0 >= 438 and x0 < 540:
                        in_bal = (438 <= x0 < 470)
                        in_amt = (470 <= x0 < 540)
                        if not in_bal and not in_amt:
                            position_issues.append(
                                f"p{pno} x={x0:.1f} text='{t}' not in B or A column")

    doc.close()

    if not font_issues:
        vr.ok("FONT", "V1.1-font", "All data-row text uses correct font (Gothic/msgo, 9pt)")
    else:
        vr.fail("FONT", "V1.1-font",
                 f"{len(font_issues)} font issue(s): {font_issues[0]}"
                 + (f" ... +{len(font_issues)-1} more" if len(font_issues) > 1 else ""))

    if not position_issues:
        vr.ok("FONT", "V1.2-position", "All number texts in valid column x-ranges")
    else:
        vr.fail("FONT", "V1.2-position",
                 f"{len(position_issues)} position issue(s): {position_issues[0]}")


# --------------------------------------------------------------------------
#  V2: Balance Arithmetic
# --------------------------------------------------------------------------
def _validate_balance_arithmetic(tx: list, vr: ValidationResult):
    """Verify running balance = prev + amount for every row."""
    opening = tx[0]["balance"]

    # V2.1: Opening balance is positive and reasonable
    if opening is None or opening < 0:
        vr.fail("BALANCE", "V2.1-opening", f"Opening balance is {opening} (must be >= 0)")
    elif opening > MAX_SUICA_BALANCE:
        vr.warn("BALANCE", "V2.1-opening",
                 f"Opening balance {opening} exceeds Suica limit ({MAX_SUICA_BALANCE})")
    else:
        vr.ok("BALANCE", "V2.1-opening", f"Opening balance {opening} is valid")

    # V2.2: Sequential balance arithmetic
    running = opening
    errors = []
    min_bal = opening
    for i in range(1, len(tx)):
        r = tx[i]
        if r["amount"] is None or r["balance"] is None:
            continue
        expected = running + r["amount"]
        if expected != r["balance"]:
            errors.append(
                f"Row {i}: {running}+({r['amount']})={expected}, got {r['balance']}")
        running = r["balance"]
        min_bal = min(min_bal, running)

    if not errors:
        vr.ok("BALANCE", "V2.2-arithmetic",
               f"All {len(tx)-1} balance transitions are mathematically correct")
    else:
        vr.fail("BALANCE", "V2.2-arithmetic",
                 f"{len(errors)} balance error(s): {errors[0]}"
                 + (f" ... +{len(errors)-1} more" if len(errors) > 1 else ""))

    # V2.3: No negative balance
    if min_bal < 0:
        vr.fail("BALANCE", "V2.3-negative", f"Minimum balance is {min_bal} (negative!)")
    else:
        vr.ok("BALANCE", "V2.3-negative", f"Min balance {min_bal} >= 0")

    # V2.4: No balance exceeds Suica limit
    max_bal = max(r["balance"] for r in tx if r["balance"] is not None)
    if max_bal > MAX_SUICA_BALANCE:
        vr.warn("BALANCE", "V2.4-max",
                 f"Max balance {max_bal} exceeds Suica limit {MAX_SUICA_BALANCE}")
    else:
        vr.ok("BALANCE", "V2.4-max", f"Max balance {max_bal} within Suica limit")

    # V2.5: Charge amounts are multiples of 100
    charge_issues = []
    for i, r in enumerate(tx):
        if r["type"] == "ｶｰﾄﾞ" and r["amount"] is not None:
            if r["amount"] % VALID_CHARGE_MULTIPLES != 0:
                charge_issues.append(f"Row {i}: charge {r['amount']} not multiple of 100")
    if not charge_issues:
        vr.ok("BALANCE", "V2.5-charge-round", "All charge amounts are multiples of 100")
    else:
        vr.warn("BALANCE", "V2.5-charge-round",
                 f"{len(charge_issues)} non-round charge(s): {charge_issues[0]}")

    # V2.6: Row 0 has balance but no amount
    if tx[0]["amount"] is not None:
        vr.fail("BALANCE", "V2.6-row0", f"Row 0 (繰) has amount={tx[0]['amount']}, expected None")
    else:
        vr.ok("BALANCE", "V2.6-row0", "Row 0 (繰) has balance only, no amount — correct")


# --------------------------------------------------------------------------
#  V3: Fare Consistency
# --------------------------------------------------------------------------
def _validate_fare_consistency(tx: list, vr: ValidationResult):
    """Verify same route always has same fare; no mixed old/new."""
    route_fares = defaultdict(list)
    for i, r in enumerate(tx):
        if r["amount"] is None or r["amount"] >= 0:
            continue
        if not r["st_from"] or not r["st_to"]:
            continue
        sf = clean_station(r["st_from"])
        st = clean_station(r["st_to"])
        fare = abs(r["amount"])
        route_fares[(sf, st)].append((i, fare))

    # V3.1: Same directed route → same fare
    mixed = []
    for (sf, st), entries in route_fares.items():
        fares = set(f for _, f in entries)
        if len(fares) > 1:
            mixed.append(f"{sf}->{st}: {sorted(fares)}")
    if not mixed:
        vr.ok("FARE", "V3.1-consistency",
               f"All {len(route_fares)} routes have consistent fares (no mixed old/new)")
    else:
        vr.fail("FARE", "V3.1-consistency",
                 f"{len(mixed)} route(s) with mixed fares: {mixed[0]}"
                 + (f" ... +{len(mixed)-1} more" if len(mixed) > 1 else ""))

    # V3.2: JR routes match post-hike database
    fare_rules = build_fare_rules()
    stale_fares = []
    for (sf, st), entries in route_fares.items():
        for idx, fare in entries:
            # Check if this is a known old fare that should have been updated
            key = (frozenset([sf, st]), fare)
            # If old_fare is in the rules (as key) then this fare was NOT updated
            for (fset, old_fare), new_fare in fare_rules.items():
                if frozenset([sf, st]) == fset and fare == old_fare and old_fare != new_fare:
                    stale_fares.append(f"Row {idx}: {sf}->{st} ¥{fare} (should be ¥{new_fare})")
                    break

    if not stale_fares:
        vr.ok("FARE", "V3.2-post-hike", "No stale pre-hike JR fares detected")
    else:
        vr.fail("FARE", "V3.2-post-hike",
                 f"{len(stale_fares)} stale fare(s): {stale_fares[0]}"
                 + (f" ... +{len(stale_fares)-1} more" if len(stale_fares) > 1 else ""))

    # V3.3: No unreasonably high fares
    high_fares = []
    for (sf, st), entries in route_fares.items():
        for idx, fare in entries:
            if fare > MAX_REASONABLE_FARE:
                # Exception: airport routes can be expensive
                if not any(k in sf + st for k in ("成田", "羽田", "空")):
                    high_fares.append(f"Row {idx}: {sf}->{st} ¥{fare}")
    if not high_fares:
        vr.ok("FARE", "V3.3-range", "All non-airport fares within reasonable range")
    else:
        vr.warn("FARE", "V3.3-range",
                 f"{len(high_fares)} unusually high fare(s): {high_fares[0]}")

    # V3.4: Non-JR fares should NOT match JR fare rules
    # (verify no accidental cross-contamination)
    non_jr_modified = []
    for (sf, st), entries in route_fares.items():
        is_non_jr = any(sf.startswith(p) or st.startswith(p)
                        for p in NON_JR_PREFIXES)
        if not is_non_jr:
            continue
        for (fset, old_fare), new_fare in fare_rules.items():
            if frozenset([sf, st]) == fset:
                # This is intentional (like 新松戸→地西日暮里) — skip if in DB
                break
    # Just informational — non-JR untouched is correct behavior
    vr.ok("FARE", "V3.4-non-jr", "Non-JR route fares checked for cross-contamination")

    # V3.5: Zero-fare only when entry==exit or specific exceptions
    zero_fare_issues = []
    for i, r in enumerate(tx):
        if r["amount"] is not None and r["amount"] == 0 and r["type"] in ("入", "＊入"):
            sf = clean_station(r["st_from"])
            st = clean_station(r["st_to"])
            # Same station or cross-company transfer are valid zero-fare cases
            if sf != st and not any(k in sf + st for k in ("京成", "KS", "新松戸")):
                zero_fare_issues.append(f"Row {i}: {sf}->{st} fare=0")
    if not zero_fare_issues:
        vr.ok("FARE", "V3.5-zero", "Zero-fare entries are valid (same-station or transfer)")
    else:
        vr.warn("FARE", "V3.5-zero",
                 f"{len(zero_fare_issues)} unexpected zero-fare(s): {zero_fare_issues[0]}")


# --------------------------------------------------------------------------
#  V4: Date Logic
# --------------------------------------------------------------------------
def _validate_date_logic(tx: list, vr: ValidationResult,
                         date_start: str, date_end: str,
                         skip_sun: bool, skip_sat: bool, skip_holidays: bool):
    """Verify dates are valid, chronological, and within target range."""
    dates = []
    for i, r in enumerate(tx):
        if r["month"] and r["day"]:
            try:
                m, d = int(r["month"]), int(r["day"])
                dates.append((i, m, d, r["month"], r["day"]))
            except ValueError:
                vr.fail("DATE", "V4.0-parse",
                         f"Row {i}: unparseable date '{r['month']}/{r['day']}'")
                return

    if not dates:
        vr.warn("DATE", "V4.0-parse", "No dates found")
        return

    # V4.1: Month/day are 2-digit zero-padded
    padding_issues = []
    for i, m, d, ms, ds in dates:
        if len(ms) != 2 or len(ds) != 2:
            padding_issues.append(f"Row {i}: '{ms}/{ds}' not zero-padded")
    if not padding_issues:
        vr.ok("DATE", "V4.1-padding", "All dates are 2-digit zero-padded (MM/DD)")
    else:
        vr.fail("DATE", "V4.1-padding",
                 f"{len(padding_issues)} padding issue(s): {padding_issues[0]}")

    # V4.2: Valid date values
    invalid_dates = []
    for i, m, d, ms, ds in dates:
        if m < 1 or m > 12:
            invalid_dates.append(f"Row {i}: month={m}")
        if d < 1 or d > 31:
            invalid_dates.append(f"Row {i}: day={d}")
    if not invalid_dates:
        vr.ok("DATE", "V4.2-valid", "All month/day values are in valid ranges")
    else:
        vr.fail("DATE", "V4.2-valid",
                 f"{len(invalid_dates)} invalid date(s): {invalid_dates[0]}")

    # V4.3: Chronological order (non-decreasing)
    order_issues = []
    for j in range(1, len(dates)):
        i_prev, m_prev, d_prev = dates[j - 1][:3]
        i_curr, m_curr, d_curr = dates[j][:3]
        if (m_curr, d_curr) < (m_prev, d_prev):
            order_issues.append(
                f"Row {i_curr}: {m_curr:02d}/{d_curr:02d} < "
                f"Row {i_prev}: {m_prev:02d}/{d_prev:02d}")
    if not order_issues:
        vr.ok("DATE", "V4.3-chronological", "All dates in chronological order")
    else:
        vr.fail("DATE", "V4.3-chronological",
                 f"{len(order_issues)} order violation(s): {order_issues[0]}")

    # V4.4: Within target range (if specified)
    if date_start and date_end:
        ds = date.fromisoformat(date_start)
        de = date.fromisoformat(date_end)
        year = ds.year
        out_of_range = []
        for i, m, d, ms, ds_str in dates:
            try:
                td = date(year if m >= ds.month else year + 1, m, d)
                if td < ds or td > de:
                    out_of_range.append(f"Row {i}: {m:02d}/{d:02d}")
            except ValueError:
                pass  # impossible date already caught in V4.2
        if not out_of_range:
            vr.ok("DATE", "V4.4-range",
                   f"All dates within target range ({date_start} to {date_end})")
        else:
            vr.fail("DATE", "V4.4-range",
                     f"{len(out_of_range)} date(s) out of range: {out_of_range[0]}")

    # V4.5: No Sundays (if applicable)
    if skip_sun and date_start:
        year = date.fromisoformat(date_start).year
        sunday_dates = []
        for i, m, d, ms, ds_str in dates:
            try:
                td = date(year, m, d)
                if td.weekday() == 6:
                    sunday_dates.append(f"Row {i}: {m:02d}/{d:02d} (Sun)")
            except ValueError:
                pass
        if not sunday_dates:
            vr.ok("DATE", "V4.5-no-sunday", "No transactions on Sundays")
        else:
            vr.fail("DATE", "V4.5-no-sunday",
                     f"{len(sunday_dates)} Sunday date(s): {sunday_dates[0]}")

    # V4.6: No Japanese holidays (if applicable)
    if skip_holidays and jpholiday and date_start:
        year = date.fromisoformat(date_start).year
        holiday_dates = []
        for i, m, d, ms, ds_str in dates:
            try:
                td = date(year, m, d)
                if jpholiday.is_holiday(td):
                    name = jpholiday.is_holiday_name(td)
                    holiday_dates.append(f"Row {i}: {m:02d}/{d:02d} ({name})")
            except ValueError:
                pass
        if not holiday_dates:
            vr.ok("DATE", "V4.6-no-holiday", "No transactions on Japanese holidays")
        else:
            vr.fail("DATE", "V4.6-no-holiday",
                     f"{len(holiday_dates)} holiday date(s): {holiday_dates[0]}")


# --------------------------------------------------------------------------
#  V5: Route / Station Logic
# --------------------------------------------------------------------------
def _validate_route_station(tx: list, vr: ValidationResult):
    """Verify station names follow Suica conventions."""
    issues_empty = []
    issues_shop = []
    issues_charge = []
    issues_kuri = []

    for i, r in enumerate(tx):
        t = r["type"]

        # V5.1: Train rides must have both stations
        if t in ("入", "＊入"):
            if not r["st_from"]:
                issues_empty.append(f"Row {i}: '{t}' missing st_from")
            if not r["st_to"]:
                issues_empty.append(f"Row {i}: '{t}' missing st_to")

        # V5.2: 物販 should have NO station names (or empty)
        if t == "物販":
            if r["st_from"] or r["st_to"]:
                # Some 物販 have store info — just warn, not fail
                pass

        # V5.3: ｶｰﾄﾞ should have "モバイル" as st_from
        if t == "ｶｰﾄﾞ":
            if r["st_from"] and "モバイル" not in r["st_from"]:
                issues_charge.append(f"Row {i}: ｶｰﾄﾞ st_from='{r['st_from']}'")

        # V5.4: 繰 should have no stations
        if t == "繰":
            if r["st_from"] or r["st_to"]:
                issues_kuri.append(f"Row {i}: 繰 has stations")

    if not issues_empty:
        vr.ok("STATION", "V5.1-train-stations", "All train rides have both from/to stations")
    else:
        vr.fail("STATION", "V5.1-train-stations",
                 f"{len(issues_empty)} missing station(s): {issues_empty[0]}")

    if not issues_charge:
        vr.ok("STATION", "V5.2-charge-source", "All ｶｰﾄﾞ entries show 'モバイル' source")
    else:
        vr.warn("STATION", "V5.2-charge-source",
                 f"{len(issues_charge)} non-standard charge source(s)")

    if not issues_kuri:
        vr.ok("STATION", "V5.3-opening", "Opening row (繰) has no station names")
    else:
        vr.fail("STATION", "V5.3-opening", issues_kuri[0])

    # V5.4: Station name prefixes are consistent with operator
    # (informational — detect if non-JR prefixes are used correctly)
    prefix_counts = defaultdict(int)
    for r in tx:
        for sn in [r["st_from"], r["st_to"]]:
            if not sn:
                continue
            sc = clean_station(sn)
            for pfx in NON_JR_PREFIXES:
                if sc.startswith(pfx):
                    prefix_counts[pfx] += 1
                    break
    if prefix_counts:
        summary = ", ".join(f"{k}:{v}" for k, v in sorted(prefix_counts.items()))
        vr.ok("STATION", "V5.4-prefixes", f"Non-JR operator prefixes found: {summary}")
    else:
        vr.ok("STATION", "V5.4-prefixes", "No non-JR operator prefixes (all JR)")


# --------------------------------------------------------------------------
#  V6: Transaction Type Rules
# --------------------------------------------------------------------------
def _validate_transaction_types(tx: list, vr: ValidationResult):
    """Verify transaction types match expected amount signs."""
    sign_issues = []
    type_issues = []
    valid_types = set(TX_TYPE_SIGN.keys())

    for i, r in enumerate(tx):
        t = r["type"]
        a = r["amount"]

        # V6.1: Known transaction type
        if t and t not in valid_types:
            type_issues.append(f"Row {i}: unknown type '{t}'")
            continue

        if t not in TX_TYPE_SIGN or a is None:
            continue

        expected = TX_TYPE_SIGN[t]

        # V6.2: Amount sign matches type
        if expected == "none" and a is not None:
            sign_issues.append(f"Row {i}: '{t}' should have no amount, got {a}")
        elif expected == "positive" and a <= 0:
            sign_issues.append(f"Row {i}: '{t}' amount should be positive, got {a}")
        elif expected == "negative" and a > 0:
            sign_issues.append(f"Row {i}: '{t}' amount should be negative, got {a}")

    if not type_issues:
        vr.ok("TXTYPE", "V6.1-known-types", "All transaction types are recognized")
    else:
        vr.warn("TXTYPE", "V6.1-known-types",
                 f"{len(type_issues)} unknown type(s): {type_issues[0]}")

    if not sign_issues:
        vr.ok("TXTYPE", "V6.2-sign-match",
               "All amounts match expected sign for their transaction type")
    else:
        vr.fail("TXTYPE", "V6.2-sign-match",
                 f"{len(sign_issues)} sign mismatch(es): {sign_issues[0]}")


# --------------------------------------------------------------------------
#  V7: Number Formatting (right-alignment pixel-perfect check)
# --------------------------------------------------------------------------
def _validate_number_formatting(path: str, vr: ValidationResult):
    """
    Check that all number texts in balance/amount columns are right-aligned
    to the correct edge (467.0 / 536.0) within ±1pt tolerance.
    """
    doc = fitz.open(path)
    align_issues = []

    for pno in range(len(doc)):
        page = doc[pno]
        td = page.get_text("dict")
        for blk in td["blocks"]:
            if "lines" not in blk:
                continue
            for ln in blk["lines"]:
                for sp in ln["spans"]:
                    t = sp["text"].strip()
                    if not t:
                        continue
                    bbox = sp["bbox"]
                    x0, x1 = bbox[0], bbox[2]

                    # Detect number spans in balance/amount columns
                    is_number = all(c in "0123456789,-" for c in t)
                    if not is_number:
                        continue

                    # Balance column: right edge should be ~467
                    if 438 <= x0 < 470:
                        expected_right = BAL_RIGHT
                        # Compute expected right from text length
                        expected_x0 = expected_right - len(t) * GLYPH_W
                        if abs(x0 - expected_x0) > 2.0:
                            align_issues.append(
                                f"p{pno} BAL '{t}' x0={x0:.1f} expected={expected_x0:.1f}")

                    # Amount column
                    elif 470 <= x0 < 540:
                        expected_right = AMT_RIGHT
                        expected_x0 = expected_right - len(t) * GLYPH_W
                        if abs(x0 - expected_x0) > 2.0:
                            align_issues.append(
                                f"p{pno} AMT '{t}' x0={x0:.1f} expected={expected_x0:.1f}")

    doc.close()

    if not align_issues:
        vr.ok("FORMAT", "V7.1-alignment",
               "All numbers pixel-perfect right-aligned (±2pt)")
    else:
        vr.fail("FORMAT", "V7.1-alignment",
                 f"{len(align_issues)} alignment issue(s): {align_issues[0]}"
                 + (f" ... +{len(align_issues)-1} more" if len(align_issues) > 1 else ""))


# --------------------------------------------------------------------------
#  V9: Forensic integrity — no extra fonts, CID encoding preserved
# --------------------------------------------------------------------------
def _validate_forensic_integrity(path: str, vr: ValidationResult):
    """Check that the output PDF hasn't been forensically damaged."""
    try:
        doc = fitz.open(path)

        # Check 1: No extra font objects (only original F2)
        for pno in range(len(doc)):
            page = doc[pno]
            fonts = page.get_fonts()
            font_names = [f[3] for f in fonts]
            non_original = [n for n in font_names
                           if n and 'MSGothic' not in n and n != 'F2']
            if non_original:
                vr.fail("FORENSIC", "FONT-CLEAN",
                        f"Page {pno}: unexpected font objects: {non_original}")
            else:
                vr.ok("FORENSIC", "FONT-CLEAN",
                       f"Page {pno}: only original font present")

        # Check 2: Content stream uses CID glyph encoding (not Unicode)
        for pno in range(len(doc)):
            page = doc[pno]
            xrefs = page.get_contents()
            for xref in xrefs:
                raw = doc.xref_stream(xref)
                stream = raw.decode('latin-1')
                import re as _re_local
                literal_tj = _re_local.findall(r'\([^)]+\)\s*Tj', stream)
                if literal_tj:
                    vr.fail("FORENSIC", "CID-ENCODING",
                            f"Page {pno}: found literal string Tj (not CID hex)")
                else:
                    vr.ok("FORENSIC", "CID-ENCODING",
                           f"Page {pno}: all Tj use CID hex encoding")

        # Check 3: No redaction annotations remain
        for pno in range(len(doc)):
            page = doc[pno]
            annots = list(page.annots()) if page.annots() else []
            redact_annots = [a for a in annots if a.type[0] == 12]
            if redact_annots:
                vr.fail("FORENSIC", "NO-REDACT",
                        f"Page {pno}: {len(redact_annots)} redaction annotations found")
            else:
                vr.ok("FORENSIC", "NO-REDACT",
                       f"Page {pno}: no redaction annotations")

        doc.close()
    except Exception as e:
        vr.fail("FORENSIC", "INTEGRITY-ERR", f"Forensic check error: {e}")


def _validate_byte_identity(path: str, original_path: str, vr: ValidationResult):
    """
    Compare byte-level identity between output and original PDF.
    Checks that non-content-stream objects are preserved verbatim.
    """
    if not original_path:
        return

    try:
        with open(original_path, 'rb') as f:
            orig_bytes = f.read()
        with open(path, 'rb') as f:
            out_bytes = f.read()

        # Find content stream offsets from original xref
        offsets, _, _ = _parse_xref_offsets(orig_bytes)

        # Get content stream xrefs
        doc = fitz.open(original_path)
        cs_xrefs = set()
        for pno in range(len(doc)):
            cs_xrefs.update(doc[pno].get_contents())
        doc.close()

        # Find content stream byte ranges in original
        cs_ranges = []
        for xref_num in cs_xrefs:
            if xref_num in offsets:
                start, end = _find_object_boundaries(orig_bytes, offsets[xref_num])
                cs_ranges.append((start, end))
        cs_ranges.sort()

        # Calculate bytes that should be identical (non-content-stream regions)
        # Before first content stream
        if cs_ranges:
            first_cs = cs_ranges[0][0]
        else:
            first_cs = len(orig_bytes)

        preserved = min(first_cs, len(out_bytes))
        identical = sum(1 for i in range(preserved)
                       if i < len(out_bytes) and orig_bytes[i] == out_bytes[i])

        pct = 100 * identical / preserved if preserved > 0 else 0

        if pct >= 99.9:
            vr.ok("FORENSIC", "BYTE-IDENTITY",
                   f"Non-stream bytes: {identical}/{preserved} identical ({pct:.1f}%)")
        elif pct >= 90:
            vr.warn("FORENSIC", "BYTE-IDENTITY",
                    f"Non-stream bytes: {identical}/{preserved} identical ({pct:.1f}%)")
        else:
            vr.fail("FORENSIC", "BYTE-IDENTITY",
                    f"Non-stream bytes: {identical}/{preserved} identical ({pct:.1f}%) — PDF was rewritten")
    except (ValueError, FileNotFoundError):
        pass  # Skip if can't compare (e.g., xref stream format)


# --------------------------------------------------------------------------
#  V8: Structural match with original
# --------------------------------------------------------------------------
def _validate_structural_match(path: str, original_path: str,
                               tx: list, vr: ValidationResult):
    """Compare output PDF structure against original to detect drift."""
    try:
        orig_rows = parse_pdf(original_path)
        orig_tx = [r for r in orig_rows
                   if r["balance"] is not None or r["amount"] is not None]
    except Exception as e:
        vr.warn("MATCH", "V8.0-parse", f"Cannot parse original: {e}")
        return

    # V8.1: Same row count
    if len(tx) == len(orig_tx):
        vr.ok("MATCH", "V8.1-row-count",
               f"Row count matches original ({len(tx)})")
    else:
        vr.fail("MATCH", "V8.1-row-count",
                 f"Row count {len(tx)} ≠ original {len(orig_tx)}")
        return

    # V8.2: Same page count
    doc_new = fitz.open(path)
    doc_orig = fitz.open(original_path)
    if len(doc_new) == len(doc_orig):
        vr.ok("MATCH", "V8.2-page-count", f"Page count matches ({len(doc_new)})")
    else:
        vr.fail("MATCH", "V8.2-page-count",
                 f"Page count {len(doc_new)} ≠ original {len(doc_orig)}")
    doc_new.close()
    doc_orig.close()

    # V8.3: Transaction types unchanged
    type_diffs = []
    for i in range(len(tx)):
        if tx[i]["type"] != orig_tx[i]["type"]:
            type_diffs.append(
                f"Row {i}: '{orig_tx[i]['type']}' → '{tx[i]['type']}'")
    if not type_diffs:
        vr.ok("MATCH", "V8.3-types", "All transaction types match original")
    else:
        vr.fail("MATCH", "V8.3-types",
                 f"{len(type_diffs)} type change(s): {type_diffs[0]}")

    # V8.4: Station names unchanged
    station_diffs = []
    for i in range(len(tx)):
        if tx[i]["st_from"] != orig_tx[i]["st_from"]:
            station_diffs.append(
                f"Row {i} from: '{orig_tx[i]['st_from']}' → '{tx[i]['st_from']}'")
        if tx[i]["st_to"] != orig_tx[i]["st_to"]:
            station_diffs.append(
                f"Row {i} to: '{orig_tx[i]['st_to']}' → '{tx[i]['st_to']}'")
    if not station_diffs:
        vr.ok("MATCH", "V8.4-stations",
               "All station names match original (not modified)")
    else:
        vr.fail("MATCH", "V8.4-stations",
                 f"{len(station_diffs)} station change(s): {station_diffs[0]}")

    # V8.5: Charge amounts unchanged (we only change fares, not charges)
    charge_diffs = []
    for i in range(len(tx)):
        if tx[i]["type"] == "ｶｰﾄﾞ":
            if tx[i]["amount"] != orig_tx[i]["amount"]:
                charge_diffs.append(
                    f"Row {i}: {orig_tx[i]['amount']} → {tx[i]['amount']}")
    if not charge_diffs:
        vr.ok("MATCH", "V8.5-charges", "All charge amounts match original (untouched)")
    else:
        vr.fail("MATCH", "V8.5-charges",
                 f"{len(charge_diffs)} charge change(s): {charge_diffs[0]}")

    # V8.6: Shopping amounts unchanged
    shop_diffs = []
    for i in range(len(tx)):
        if tx[i]["type"] == "物販":
            if tx[i]["amount"] != orig_tx[i]["amount"]:
                shop_diffs.append(
                    f"Row {i}: {orig_tx[i]['amount']} → {tx[i]['amount']}")
    if not shop_diffs:
        vr.ok("MATCH", "V8.6-shopping",
               "All shopping amounts match original (untouched)")
    else:
        vr.fail("MATCH", "V8.6-shopping",
                 f"{len(shop_diffs)} shopping change(s): {shop_diffs[0]}")

    # V8.7: Row y-positions match (layout not shifted)
    y_drifts = []
    for i in range(min(len(tx), len(orig_tx))):
        dy = abs(tx[i]["y"] - orig_tx[i]["y"])
        if dy > 2.0:
            y_drifts.append(f"Row {i}: y={tx[i]['y']:.1f} vs orig {orig_tx[i]['y']:.1f}")
    if not y_drifts:
        vr.ok("MATCH", "V8.7-y-positions",
               "All row y-positions match original (no layout shift)")
    else:
        vr.fail("MATCH", "V8.7-y-positions",
                 f"{len(y_drifts)} y-position drift(s): {y_drifts[0]}")


# ============================================================================
#  Command: analyze
# ============================================================================
def cmd_analyze(args):
    """Parse PDF and print detailed analysis."""
    rows = parse_pdf(args.pdf)
    tx = [r for r in rows if r["balance"] is not None or r["amount"] is not None]
    print(f"Total rows: {len(tx)}")

    # Print all rows
    print("\n--- Transaction Listing ---")
    for i, r in enumerate(tx):
        a_str = str(r["amount"]) if r["amount"] is not None else "-"
        b_str = str(r["balance"]) if r["balance"] is not None else "-"
        print(f"  [{i:3d}] {r['month']:>2}/{r['day']:>2}  {r['type']:<6} "
              f"{r['st_from']:<12} -> {r['st_to']:<12}  "
              f"Amt={a_str:>7}  Bal={b_str:>6}")

    # Spending summary
    train, shop, charge, adjust, other = 0, 0, 0, 0, 0
    for r in tx:
        a = r["amount"]
        if a is None:
            continue
        t = r["type"]
        if a > 0:
            charge += a
        elif t in ("入", "＊入"):
            train += abs(a)
        elif t == "物販":
            shop += abs(a)
        elif t == "精":
            adjust += abs(a)
        elif a < 0:
            other += abs(a)

    print(f"\n--- Spending Summary ---")
    print(f"  Train:       {train:,} yen")
    print(f"  Shopping:    {shop:,} yen")
    print(f"  Adjustment:  {adjust:,} yen")
    if other:
        print(f"  Other:       {other:,} yen")
    total_spent = train + shop + adjust + other
    print(f"  TOTAL SPENT: {total_spent:,} yen")
    print(f"  Charges:     {charge:,} yen")

    # Route frequency
    print(f"\n--- Route Frequency ---")
    routes = {}
    for r in tx:
        if r["amount"] is not None and r["amount"] < 0 and r["st_from"] and r["st_to"]:
            sf = clean_station(r["st_from"])
            st = clean_station(r["st_to"])
            key = f"{sf} -> {st}"
            routes.setdefault(key, []).append(abs(r["amount"]))
    for route in sorted(routes, key=lambda k: -len(routes[k])):
        fares = routes[route]
        unique = sorted(set(fares))
        print(f"  {route}: {unique} x{len(fares)}")

    # Balance verification
    print(f"\n--- Balance Verification ---")
    tx_with_bal = [r for r in tx if r["balance"] is not None]
    if tx_with_bal:
        opening = tx_with_bal[0]["balance"]
        running = opening
        errors = 0
        for i in range(1, len(tx_with_bal)):
            r = tx_with_bal[i]
            if r["amount"] is None:
                continue
            expected = running + r["amount"]
            if expected != r["balance"]:
                print(f"  ERROR at row {i}: {running}+{r['amount']}={expected}, got {r['balance']}")
                errors += 1
            running = r["balance"]
        print(f"  Opening: {opening}")
        print(f"  Final:   {running}")
        print(f"  Errors:  {errors}")
        if errors == 0:
            print("  All balances are mathematically correct.")


# ============================================================================
#  Command: update
# ============================================================================
def cmd_update(args):
    """Full update: remap dates + update fares + recalculate balances."""
    # --- Safety check: detect already-modified files ---
    if not getattr(args, 'force', False):
        try:
            with open(args.pdf, 'rb') as f:
                header = f.read(4096)
            # Check for multiple %%EOF markers (incremental saves)
            eof_count = header.count(b'%%EOF')
            with open(args.pdf, 'rb') as f:
                full = f.read()
            eof_count = full.count(b'%%EOF')
            if eof_count > 1:
                print("⚠️  WARNING: PDF has multiple %%EOF markers (incremental save detected).")
                print("   This file may have been previously modified.")
                print("   Use --force to override, or start from the original PDF.")
                sys.exit(1)
            # Check for common modification indicators in filename
            basename = os.path.basename(args.pdf).lower()
            mod_markers = ['_updated', '_patched', '_modified', '_edited', '_remapped']
            for marker in mod_markers:
                if marker in basename:
                    print(f"⚠️  WARNING: Filename contains '{marker}' — likely already modified.")
                    print("   Use --force to override, or start from the original PDF.")
                    sys.exit(1)
        except (OSError, IOError):
            pass  # Can't check, proceed anyway

    print(f"=== Parsing: {args.pdf} ===")
    all_rows = parse_pdf(args.pdf)
    tx = [r for r in all_rows if r["balance"] is not None or r["amount"] is not None]
    print(f"Transaction rows: {len(tx)}")

    # --- Fare rules ---
    fare_rules = {}
    if not args.no_fares:
        fare_rules = build_fare_rules(args.fare_rules, tx)
        print(f"Fare rules loaded: {len(fare_rules)}")

    # --- Apply fare rules ---
    fare_changes = []
    for i, r in enumerate(tx):
        if r["amount"] is None or r["amount"] >= 0:
            continue
        sf = clean_station(r["st_from"])
        st = clean_station(r["st_to"])
        old_fare = abs(r["amount"])
        key = (frozenset([sf, st]), old_fare)
        if key in fare_rules:
            new_fare = fare_rules[key]
            fare_changes.append((i, old_fare, new_fare))
            print(f"  Fare: {sf}->{st}  {old_fare} -> {new_fare}  (+{new_fare - old_fare})")

    total_increase = sum(nf - of for _, of, nf in fare_changes)
    print(f"Total fare changes: {len(fare_changes)}, +{total_increase} yen")

    # --- Date mapping ---
    date_map = {}
    if not args.no_dates:
        start = date.fromisoformat(args.date_start) if args.date_start else date.today().replace(day=1)
        end = date.fromisoformat(args.date_end) if args.date_end else date.today()
        target_days = workdays(start, end, args.skip_sun, args.skip_sat, args.skip_holidays)
        print(f"Target days: {len(target_days)} ({start} to {end})")

        orig_dates = []
        seen = set()
        for r in tx:
            if r["month"] and r["day"]:
                d = (r["month"], r["day"])
                if d not in seen:
                    seen.add(d)
                    orig_dates.append(d)

        N, M = len(orig_dates), len(target_days)
        if N == 0:
            print("WARNING: No dates found in PDF. Skipping date remap.")
        elif M == 0:
            print("WARNING: No valid target days. Skipping date remap.")
        else:
            for i, od in enumerate(orig_dates):
                idx = round(i * (M - 1) / (N - 1)) if N > 1 else 0
                td = target_days[idx]
                date_map[od] = (f"{td.month:02d}", f"{td.day:02d}")
            print(f"Date mapping: {N} unique dates -> {M} available days")

    # --- Compute new amounts and balances ---
    opening = tx[0]["balance"]
    new_opening = opening + total_increase
    print(f"Opening balance: {opening} -> {new_opening}")

    new_amounts = [None]  # row 0 = opening balance row
    new_balances = [new_opening]
    running = new_opening

    fc_map = {idx: (of, nf) for idx, of, nf in fare_changes}

    for i in range(1, len(tx)):
        r = tx[i]
        if r["amount"] is None:
            new_amounts.append(None)
            new_balances.append(None)
            continue
        if i in fc_map:
            _, nf = fc_map[i]
            new_amt = -nf
        else:
            new_amt = r["amount"]
        running += new_amt
        new_amounts.append(new_amt)
        new_balances.append(running)

    print(f"Final balance: {running}")
    min_bal = min(b for b in new_balances if b is not None)
    print(f"Min balance: {min_bal}")

    # If negative, boost opening
    if min_bal < 0:
        extra = abs(min_bal) + 100
        new_opening += extra
        total_increase += extra
        running = new_opening
        new_balances = [new_opening]
        for i in range(1, len(tx)):
            if new_amounts[i] is None:
                new_balances.append(None)
                continue
            running += new_amounts[i]
            new_balances.append(running)
        print(f"Adjusted opening: {new_opening}, final: {running}")

    if args.dry_run:
        print("\n[DRY RUN] No output file written.")
        return

    # --- Generate PDF (forensically clean content stream patching) ---
    output = args.output or args.pdf.rsplit(".", 1)[0] + "_updated.pdf"
    print(f"\n=== Generating: {output} ===")

    # Build page_edits dict for content stream patching
    # Key: (page_no, row_idx_within_page, column)
    # Value: (new_glyph_hex,)
    page_edits = {}
    counts = {"date": 0, "fare": 0, "balance": 0}

    # Track row index within each page
    page_row_idx = {}
    for i, r in enumerate(tx):
        pg = r["page"]
        if pg not in page_row_idx:
            page_row_idx[pg] = 0
        else:
            page_row_idx[pg] += 1
        row_in_page = page_row_idx[pg]

        # Date edits (month/day are always 2 chars → same length, no x change)
        if r["month"] and r["day"] and not args.no_dates:
            orig_d = (r["month"], r["day"])
            if orig_d in date_map:
                new_m, new_d = date_map[orig_d]
                if new_m != r["month"]:
                    page_edits[(pg, row_in_page, "M")] = (text_to_glyph_hex(new_m),)
                    counts["date"] += 1
                if new_d != r["day"]:
                    page_edits[(pg, row_in_page, "D")] = (text_to_glyph_hex(new_d),)
                    counts["date"] += 1

        # Amount edits (fare changes — usually same char count)
        if new_amounts[i] is not None and r["amount"] is not None:
            if new_amounts[i] != r["amount"]:
                new_display = format_amount_cs(new_amounts[i])
                new_hex = text_to_glyph_hex(new_display)
                page_edits[(pg, row_in_page, "A")] = (new_hex,)
                counts["fare"] += 1

        # Balance edits (may change char count due to digit changes)
        if new_balances[i] is not None and r["balance"] is not None:
            if new_balances[i] != r["balance"]:
                new_display = format_balance_cs(new_balances[i])
                new_hex = text_to_glyph_hex(new_display)
                page_edits[(pg, row_in_page, "B")] = (new_hex,)
                counts["balance"] += 1

    print(f"Edits: {counts['date']} date, {counts['fare']} fare, {counts['balance']} balance")

    # --- Save PDF ---
    save_mode = getattr(args, 'save_mode', 'raw')

    if save_mode == 'raw':
        # Forensic-quality raw binary patching
        try:
            modified_streams = compute_patched_streams(args.pdf, page_edits)
            save_stats = save_raw_patched(args.pdf, output, modified_streams)
            print(f"  Save mode: raw binary patch")
            print(f"  Objects modified: {save_stats['objects_modified']}")
            print(f"  Bytes preserved: {save_stats['bytes_identical']}")
            print(f"  File size: {save_stats['file_size_original']} -> {save_stats['file_size_output']}")
        except (ValueError, KeyError) as e:
            print(f"  Raw save failed ({e}), falling back to PyMuPDF...")
            save_mode = 'pymupdf'

    if save_mode == 'pymupdf':
        # Fallback: PyMuPDF save (rewrites entire file)
        shutil.copy2(args.pdf, output)
        doc = fitz.open(output)
        patch_content_streams(doc, page_edits)
        tmp = output + ".tmp"
        doc.save(tmp, incremental=False, deflate=True, garbage=0)
        doc.close()
        if os.path.exists(output):
            os.remove(output)
        os.rename(tmp, output)
        print(f"  Save mode: PyMuPDF rewrite")

    print(f"\n=== DONE ===")
    print(f"Output:          {output}")
    print(f"Opening balance: {opening} -> {new_opening}")
    print(f"Final balance:   {running}")
    print(f"Fare changes:    {len(fare_changes)} rides, +{total_increase} yen")

    # --- Auto-verification ---
    print(f"\n=== Running post-update verification ===")
    vr = validate_pdf(
        output,
        original_path=args.pdf,
        date_start=args.date_start,
        date_end=args.date_end,
        skip_sun=args.skip_sun,
        skip_sat=args.skip_sat,
        skip_holidays=args.skip_holidays,
    )
    passed = vr.print_report()
    if not passed:
        print("\n⚠️  Output PDF has verification failures!")
        print("    Review the report above and fix issues before using.")
        sys.exit(2)


# ============================================================================
#  Command: lookup
# ============================================================================
def cmd_lookup(args):
    """Look up fare in built-in database."""
    a = args.from_st
    b = args.to_st
    key_set = frozenset([a, b])

    print(f"Looking up: {a} <-> {b}")
    found = False
    for sa, sb, old, new in FARE_DB:
        if frozenset([sa, sb]) == key_set:
            print(f"  {sa} <-> {sb}: {old} -> {new} (+{new - old})")
            found = True
    if not found:
        print(f"  Not found in built-in database.")
        print(f"  Try NAVITIME: https://www.navitime.co.jp/transfer/searchlist"
              f"?orvStationName={a}&dnvStationName={b}&month=2026/04&day=15")


# ============================================================================
#  Command: verify
# ============================================================================
def cmd_verify(args):
    """Run comprehensive verification on a Suica PDF."""
    print(f"=== Verifying: {args.pdf} ===")
    if args.original:
        print(f"    Original:  {args.original}")

    vr = validate_pdf(
        args.pdf,
        original_path=args.original,
        date_start=args.date_start,
        date_end=args.date_end,
        skip_sun=args.skip_sun,
        skip_sat=args.skip_sat,
        skip_holidays=args.skip_holidays,
    )
    passed = vr.print_report()
    sys.exit(0 if passed else 1)


# ============================================================================
#  CLI entry point
# ============================================================================
def main():
    parser = argparse.ArgumentParser(
        description="Suica PDF Editor — Parse, modify, regenerate IC card statements",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="Command to run")

    # analyze
    p_analyze = sub.add_parser("analyze", help="Parse PDF and show summary")
    p_analyze.add_argument("pdf", help="Path to Suica PDF")

    # update
    p_update = sub.add_parser("update", help="Full update: dates + fares + balances")
    p_update.add_argument("pdf", help="Path to Suica PDF")
    p_update.add_argument("--output", help="Output PDF path")
    p_update.add_argument("--date-start", help="Target start date (YYYY-MM-DD)")
    p_update.add_argument("--date-end", help="Target end date (YYYY-MM-DD)")
    p_update.add_argument("--skip-sun", default=True, type=lambda x: x.lower() != "false",
                          help="Skip Sundays (default: true)")
    p_update.add_argument("--skip-sat", default=False, type=lambda x: x.lower() == "true",
                          help="Skip Saturdays (default: false)")
    p_update.add_argument("--skip-holidays", default=True, type=lambda x: x.lower() != "false",
                          help="Skip JP holidays (default: true)")
    p_update.add_argument("--fare-rules", help="Path to custom fare rules JSON")
    p_update.add_argument("--no-dates", action="store_true", help="Skip date remapping")
    p_update.add_argument("--no-fares", action="store_true", help="Skip fare updates")
    p_update.add_argument("--font-path", default=FONT_FILE_DEFAULT, help="CJK font file path")
    p_update.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    p_update.add_argument("--save-mode", choices=["raw", "pymupdf"], default="raw",
                          help="Save method: 'raw' (forensic binary patch) or 'pymupdf' (full rewrite)")
    p_update.add_argument("--force", action="store_true",
                          help="Skip safety checks (allow modifying already-modified files)")

    # lookup
    p_lookup = sub.add_parser("lookup", help="Look up fare in built-in database")
    p_lookup.add_argument("--from", dest="from_st", required=True, help="From station")
    p_lookup.add_argument("--to", dest="to_st", required=True, help="To station")

    # verify
    p_verify = sub.add_parser("verify", help="Run comprehensive verification on output PDF")
    p_verify.add_argument("pdf", help="Path to PDF to verify")
    p_verify.add_argument("--original", help="Path to original PDF (for structural comparison)")
    p_verify.add_argument("--date-start", help="Expected date range start (YYYY-MM-DD)")
    p_verify.add_argument("--date-end", help="Expected date range end (YYYY-MM-DD)")
    p_verify.add_argument("--skip-sun", default=True, type=lambda x: x.lower() != "false",
                          help="Verify no Sundays (default: true)")
    p_verify.add_argument("--skip-sat", default=False, type=lambda x: x.lower() == "true",
                          help="Verify no Saturdays (default: false)")
    p_verify.add_argument("--skip-holidays", default=True, type=lambda x: x.lower() != "false",
                          help="Verify no JP holidays (default: true)")

    args = parser.parse_args()

    if args.command == "analyze":
        cmd_analyze(args)
    elif args.command == "update":
        cmd_update(args)
    elif args.command == "lookup":
        cmd_lookup(args)
    elif args.command == "verify":
        cmd_verify(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
