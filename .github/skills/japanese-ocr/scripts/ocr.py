"""Japanese OCR via Tesseract.

Usage:
    python ocr.py <image-or-pdf>
    python ocr.py --clipboard
    python ocr.py <folder> --batch --out ./ocr_out

See SKILL.md for full flag reference.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import pytesseract
from PIL import Image

# --- Config ----------------------------------------------------------------
TESSERACT_CMD = os.environ.get(
    "TESSERACT_CMD", r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)
if Path(TESSERACT_CMD).exists():
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

# Auto-detect TESSDATA_PREFIX if not set (common on Windows when env was set
# after the current terminal session started).
if not os.environ.get("TESSDATA_PREFIX"):
    for candidate in (
        Path.home() / "tessdata",
        Path(r"C:\Program Files\Tesseract-OCR\tessdata"),
    ):
        if (candidate / "jpn.traineddata").exists():
            os.environ["TESSDATA_PREFIX"] = str(candidate)
            break

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
PDF_EXTS = {".pdf"}


# --- Image preprocessing ---------------------------------------------------
def preprocess(pil_img: Image.Image) -> Image.Image:
    """Grayscale → upscale small images → Otsu binarize → deskew."""
    img = np.array(pil_img.convert("RGB"))
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)

    h, w = gray.shape
    if min(h, w) < 1000:
        scale = 1000 / min(h, w)
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    # Otsu binarize (white background, black text)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Deskew using min-area-rect of dark pixels
    coords = np.column_stack(np.where(bw < 128))
    if coords.size > 100:
        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45:
            angle = -(90 + angle)
        else:
            angle = -angle
        if abs(angle) > 0.5 and abs(angle) < 15:
            h2, w2 = bw.shape
            M = cv2.getRotationMatrix2D((w2 // 2, h2 // 2), angle, 1.0)
            bw = cv2.warpAffine(
                bw, M, (w2, h2),
                flags=cv2.INTER_CUBIC,
                borderMode=cv2.BORDER_REPLICATE,
            )

    return Image.fromarray(bw)


# --- Orientation detection -------------------------------------------------
def detect_rotation(pil_img: Image.Image) -> int:
    """Return rotation angle (0/90/180/270) suggested by Tesseract OSD."""
    try:
        osd = pytesseract.image_to_osd(pil_img)
        m = re.search(r"Rotate: (\d+)", osd)
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return 0


# --- OCR core --------------------------------------------------------------
def _ocr_with_lang(pil_img: Image.Image, lang: str, psm: int) -> tuple[str, float]:
    """OCR and return (text, mean_confidence)."""
    config = f"--psm {psm}"
    data = pytesseract.image_to_data(
        pil_img, lang=lang, config=config, output_type=pytesseract.Output.DICT
    )
    confs = [int(c) for c in data["conf"] if str(c).lstrip("-").isdigit() and int(c) >= 0]
    mean_conf = sum(confs) / len(confs) if confs else 0.0
    text = pytesseract.image_to_string(pil_img, lang=lang, config=config)
    return text.strip(), mean_conf


def ocr_image(
    pil_img: Image.Image,
    lang: str = "auto",
    psm: int = 6,
    do_preprocess: bool = True,
) -> dict:
    """Run OCR on a PIL image. Returns {text, lang, confidence, rotation}."""
    rotation = detect_rotation(pil_img)
    if rotation in (90, 180, 270):
        pil_img = pil_img.rotate(-rotation, expand=True)

    if do_preprocess:
        pil_img = preprocess(pil_img)

    if lang == "auto":
        candidates = ["jpn", "jpn+eng", "jpn_vert"]
        best = ("", 0.0, "")
        for cand in candidates:
            try:
                text, conf = _ocr_with_lang(pil_img, cand, psm)
            except pytesseract.TesseractError:
                continue
            if conf > best[1]:
                best = (text, conf, cand)
        return {
            "text": best[0],
            "lang": best[2] or "jpn+eng",
            "confidence": round(best[1], 2),
            "rotation": rotation,
        }

    text, conf = _ocr_with_lang(pil_img, lang, psm)
    return {
        "text": text,
        "lang": lang,
        "confidence": round(conf, 2),
        "rotation": rotation,
    }


# --- PDF -------------------------------------------------------------------
def ocr_pdf(
    path: Path,
    lang: str = "auto",
    psm: int = 6,
    dpi: int = 300,
    do_preprocess: bool = True,
    skip_text: bool = False,
) -> dict:
    import fitz  # pymupdf

    doc = fitz.open(path)
    pages_text: list[str] = []
    confs: list[float] = []

    for i, page in enumerate(doc):
        if skip_text:
            embedded = page.get_text("text").strip()
            if len(embedded) > 20:
                pages_text.append(f"--- Page {i+1} (embedded) ---\n{embedded}")
                continue

        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        result = ocr_image(img, lang=lang, psm=psm, do_preprocess=do_preprocess)
        pages_text.append(f"--- Page {i+1} (ocr lang={result['lang']} conf={result['confidence']}) ---\n{result['text']}")
        confs.append(result["confidence"])

    doc.close()
    return {
        "text": "\n\n".join(pages_text),
        "lang": lang,
        "confidence": round(sum(confs) / len(confs), 2) if confs else 0.0,
        "rotation": 0,
        "pages": len(pages_text),
    }


# --- Clipboard -------------------------------------------------------------
def get_clipboard_image() -> Optional[Image.Image]:
    try:
        from PIL import ImageGrab
        img = ImageGrab.grabclipboard()
    except Exception as e:
        print(f"[ERROR] Cannot read clipboard: {e}", file=sys.stderr)
        return None
    if isinstance(img, Image.Image):
        return img
    if isinstance(img, list) and img:
        # list of file paths
        first = Path(str(img[0]))
        if first.exists() and first.suffix.lower() in IMAGE_EXTS:
            return Image.open(first)
    return None


# --- Dispatch --------------------------------------------------------------
def process_path(path: Path, args) -> dict:
    ext = path.suffix.lower()
    if ext in PDF_EXTS:
        return ocr_pdf(
            path,
            lang=args.lang,
            psm=args.psm,
            dpi=args.dpi,
            do_preprocess=not args.no_preprocess,
            skip_text=args.skip_text,
        )
    if ext in IMAGE_EXTS:
        img = Image.open(path)
        return ocr_image(
            img, lang=args.lang, psm=args.psm, do_preprocess=not args.no_preprocess
        )
    raise ValueError(f"Unsupported file type: {ext}")


def _batch_worker(path_str: str, args_dict: dict) -> tuple[str, dict | str]:
    args = argparse.Namespace(**args_dict)
    try:
        result = process_path(Path(path_str), args)
        return path_str, result
    except Exception as e:
        return path_str, f"ERROR: {e}"


def run_batch(folder: Path, args) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = [
        p for p in folder.rglob("*")
        if p.is_file() and p.suffix.lower() in (IMAGE_EXTS | PDF_EXTS)
    ]
    if not files:
        print("[WARN] No image/PDF files found.", file=sys.stderr)
        return 1

    args_dict = vars(args)
    workers = max(1, args.workers)

    print(f"[INFO] Processing {len(files)} files with {workers} workers → {out_dir}", file=sys.stderr)

    with ProcessPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_batch_worker, str(p), args_dict): p for p in files}
        for fut in as_completed(futures):
            src = futures[fut]
            _, result = fut.result()
            rel = src.relative_to(folder).with_suffix(".txt")
            dest = out_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(result, dict):
                dest.write_text(result["text"], encoding="utf-8")
                print(f"  OK  {src.name}  conf={result['confidence']}", file=sys.stderr)
            else:
                dest.write_text(result, encoding="utf-8")
                print(f"  ERR {src.name}  {result}", file=sys.stderr)
    return 0


# --- CLI -------------------------------------------------------------------
def main() -> int:
    p = argparse.ArgumentParser(description="Japanese OCR via Tesseract.")
    p.add_argument("input", nargs="?", help="Image / PDF / folder path")
    p.add_argument("--clipboard", action="store_true", help="Read image from clipboard")
    p.add_argument("--lang", default="auto", help="auto | jpn | jpn_vert | jpn+eng | ...")
    p.add_argument("--psm", type=int, default=6, help="Tesseract page seg mode")
    p.add_argument("--dpi", type=int, default=300, help="PDF render DPI")
    p.add_argument("--no-preprocess", action="store_true", help="Skip image preprocessing")
    p.add_argument("--skip-text", action="store_true", help="(PDF) skip pages with embedded text")
    p.add_argument("--batch", action="store_true", help="Treat input as folder, OCR recursively")
    p.add_argument("--out", default="./ocr_out", help="(batch) output folder")
    p.add_argument("--workers", type=int, default=4, help="(batch) parallel workers")
    p.add_argument("--json", action="store_true", help="Output JSON to stdout")
    args = p.parse_args()

    # Ensure stdout can handle Japanese on Windows
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if args.clipboard:
        img = get_clipboard_image()
        if img is None:
            print("[ERROR] No image in clipboard.", file=sys.stderr)
            return 2
        result = ocr_image(
            img, lang=args.lang, psm=args.psm, do_preprocess=not args.no_preprocess
        )
        _emit(result, args.json)
        return 0

    if not args.input:
        p.print_help()
        return 2

    path = Path(args.input)
    if not path.exists():
        print(f"[ERROR] Not found: {path}", file=sys.stderr)
        return 2

    if args.batch or path.is_dir():
        if not path.is_dir():
            print("[ERROR] --batch requires a folder.", file=sys.stderr)
            return 2
        return run_batch(path, args)

    result = process_path(path, args)
    _emit(result, args.json)
    return 0


def _emit(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["text"])


if __name__ == "__main__":
    sys.exit(main())
