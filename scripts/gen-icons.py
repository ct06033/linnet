#!/usr/bin/env python3
"""Linnet app icons — rev 4 (final placeholder; brand mark is separate logo-design
work). Simple grammar: circles + one sharp asymmetric beak, no clipping."""
from PIL import Image, ImageDraw
import os

S = 512
base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(base)
top, bot = (79, 107, 237), (30, 36, 90)
for y in range(S):
    t = y / S
    d.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=255)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
img.paste(base, (0, 0), mask)
d = ImageDraw.Draw(img)

cx, cy, r = 230, 262, 142
# head + sharp tapered beak (longer upper mandible) — deep base inside head
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(246, 247, 252, 255))
d.polygon([(cx + r - 64, cy - 44), (cx + r + 56, cy + 12), (cx + r - 64, cy + 56)], fill=(246, 247, 252, 255))
# red throat bib: whole circle inside the head, near the front-lower edge
d.ellipse([cx - 6, cy + 16, cx + 116, cy + 138], fill=(224, 83, 61, 255))
# eye: solid + catchlight
d.ellipse([cx + 38, cy - 92, cx + 86, cy - 44], fill=(16, 16, 20, 255))
d.ellipse([cx + 66, cy - 82, cx + 78, cy - 70], fill=(246, 247, 252, 255))

out = os.path.dirname(os.path.abspath(__file__)) + "/../apps/desktop/build"
os.makedirs(out, exist_ok=True)
img.save(out + "/icon.png")
for n in (256, 128, 64, 48, 32, 16):
    img.resize((n, n), Image.Resampling.LANCZOS).save(f"{out}/icon-{n}.png")
img.resize((256, 256), Image.Resampling.LANCZOS).save(out + "/icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("icons rev4 written")
