import fitz
GEN="_gen.pdf"
REAL="C:/Users/Admin/Downloads/JE80FE24040823015_20260124_20260523000550.pdf"
for label, path in [("REAL",REAL),("GEN",GEN)]:
    d=fitz.open(path)
    p=d[0]
    drs=p.get_drawings()
    print(f"--- {label} drawings count={len(drs)} ---")
    for i,dr in enumerate(drs[:5]):
        print(f"  [{i}] type={dr.get('type')} fill={dr.get('fill')} rect={dr.get('rect')}")
