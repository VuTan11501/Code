import fitz, json
GEN="_gen.pdf"
REAL="C:/Users/Admin/Downloads/JE80FE24040823015_20260124_20260523000550.pdf"

def metadata(path):
    d=fitz.open(path)
    return {
        "pages": d.page_count,
        "metadata": d.metadata,
        "page_size": [d[0].rect.width, d[0].rect.height],
        "fonts_p1": [f for f in d[0].get_fonts()],
        "images_p1": len(d[0].get_images()),
        "drawings_p1": len(d[0].get_drawings()),
        "annots_p1": len(list(d[0].annots())),
    }

with open("_meta.txt","w",encoding="utf-8") as f:
    f.write("=== GENERATED ===\n")
    f.write(json.dumps(metadata(GEN), indent=2, ensure_ascii=False, default=str))
    f.write("\n\n=== REAL ===\n")
    f.write(json.dumps(metadata(REAL), indent=2, ensure_ascii=False, default=str))
