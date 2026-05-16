---
name: japanese-ocr
description: 'OCR Japanese text from images, PDFs, or clipboard using Tesseract (offline). USE WHEN: vision/image-understanding tools are disabled by enterprise policy, you need to read 日本語 text from screenshots, scanned PDFs (図面/帳票/仕様書), 画面キャプチャ, or clipboard images. Supports horizontal (jpn) and vertical (jpn_vert / 縦書き) Japanese, with image preprocessing (grayscale, binarize, deskew) for better accuracy. Returns extracted text as plain string. DO NOT USE FOR: handwriting (low accuracy), already-digital text (read the source file), translation (OCR only — translate separately).'
argument-hint: '<image-or-pdf-path> | --clipboard'
---

# Japanese OCR (Tesseract)

Offline OCR cho 日本語 dùng khi vision tools bị disable bởi enterprise.

## When to Use

- User dán/tham chiếu screenshot có chữ Nhật và bạn không đọc được bằng vision
- Cần trích text từ scanned PDF (帳票, 仕様書, 図面, 操作説明書, ...)
- Cần đọc clipboard image (Win+Shift+S → paste)
- Cần xử lý batch nhiều file ảnh / PDF

## Prerequisites (đã setup trên máy này)

- **Tesseract 5.4** tại `C:\Program Files\Tesseract-OCR\tesseract.exe`
- **Traineddata** (`tessdata_best`): `jpn`, `jpn_vert`, `eng`, `osd` tại `C:\Users\fpt-cao-tan\tessdata\`
- Env `TESSDATA_PREFIX` đã set ở User scope
- Python với deps trong `./scripts/requirements.txt` (dùng venv của workspace hiện tại hoặc venv riêng)

Nếu thiếu deps:
```powershell
pip install -r ./scripts/requirements.txt
```

## Procedure

### 1. Single image / screenshot
```powershell
python ./scripts/ocr.py <path-to-image>
```
Output: text in stdout.

### 2. Clipboard image (Win+Shift+S → run này)
```powershell
python ./scripts/ocr.py --clipboard
```

### 3. PDF (single file)
```powershell
python ./scripts/ocr.py <path-to-pdf> --dpi 300
```
Tự render từng trang → OCR → ghép.

### 4. Batch folder (recursive)
```powershell
python ./scripts/ocr.py <folder> --batch --out ./ocr_out --workers 4
```

### Common flags

| Flag | Default | Mô tả |
|---|---|---|
| `--lang` | `auto` | `auto` = tự thử jpn + jpn_vert, chọn confidence cao hơn. Có thể ép `jpn`, `jpn_vert`, `jpn+eng` |
| `--dpi` | `300` | DPI khi render PDF. Tăng lên `400` cho fax/scan mờ |
| `--psm` | `6` | Page Segmentation Mode. `3` = auto layout, `11` = sparse text |
| `--no-preprocess` | off | Tắt grayscale/binarize/deskew (bật mặc định để tăng accuracy) |
| `--skip-text` | off | (PDF) bỏ qua trang đã có text nhúng — chỉ OCR trang scan |
| `--json` | off | Output JSON kèm confidence score thay vì plain text |

## How the Skill Decides Vertical vs Horizontal

`--lang auto` (default):
1. Chạy Tesseract OSD (`--psm 0`) để detect rotation/script
2. Thử OCR với `jpn` → đo mean confidence
3. Thử với `jpn_vert` → đo mean confidence
4. Trả kết quả của lang có confidence cao hơn

Nếu OSD báo orientation ≠ 0, ảnh được rotate trước khi OCR.

## Preprocessing (mặc định bật)

Pipeline trong [ocr.py](./scripts/ocr.py):
1. Convert grayscale
2. Adaptive threshold (Otsu) → binarize
3. Deskew bằng moments của binary image
4. Upscale ×2 nếu chiều ngắn < 1000px (giúp với screenshot nhỏ)

Tắt bằng `--no-preprocess` nếu ảnh đã sạch (vd: PDF render).

## Output Conventions

- **Plain text** (default): in ra stdout. Khi dùng làm context, capture vào file rồi `read_file`.
- **JSON** (`--json`): `{"text": "...", "lang": "jpn", "confidence": 87.3, "rotation": 0}`
- **Batch**: 1 file `.txt` per input file, mirror cây thư mục dưới `--out`.

## Troubleshooting

| Triệu chứng | Fix |
|---|---|
| `TesseractNotFoundError` | Set `TESSERACT_CMD` env var hoặc sửa path đầu `ocr.py` |
| Text loạn / sai nhiều | Thử `--dpi 400`, `--psm 3` hoặc `--psm 11`, hoặc ép `--lang jpn_vert` |
| PDF không có chữ | Đó là PDF scan thuần — OK, script tự OCR. Nếu muốn output PDF searchable thì dùng `ocrmypdf` riêng |
| Chữ Latin/số bị nhầm sang kanji | Ép `--lang jpn+eng` thay vì `jpn` thuần |
| Không đọc được clipboard | Dùng Win+Shift+S chụp vào clipboard, sau đó mới chạy `--clipboard` |

## Anti-patterns

- ❌ Dùng skill này cho text **đã có sẵn dạng số** (Word/Excel/text PDF) — đọc trực tiếp file
- ❌ Dịch trong skill — OCR chỉ trích text, dịch là bước riêng
- ❌ OCR ảnh handwriting kỳ vọng accuracy cao — Tesseract yếu mảng này, đề xuất Cloud Vision

## See Also

- [scripts/ocr.py](./scripts/ocr.py) — main script
- [scripts/requirements.txt](./scripts/requirements.txt) — Python deps
