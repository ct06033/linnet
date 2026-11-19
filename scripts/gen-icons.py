#!/usr/bin/env python3
"""Generate Linnet app icons (512 PNG + 256/128/64/48/32/16 sizes) — W9."""
from PIL import Image, ImageDraw
import os

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded-square background: indigo -> deep navy vertical blend
top, bot = (79, 107, 237), (30, 36, 90)
for y in range(S):
    t = y / S
    col = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
    d.line([(0, y), (S, y)], fill=col)
# punch rounded corners via mask
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=255)
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bg.paste(img, (0, 0), mask)
img = bg
d = ImageDraw.Draw(img)

# stylized goldfinch/linnet head facing right: circle + cheek + beak + eye
cx, cy, r = 236, 268, 138
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(246, 247, 252, 255))          # head (white)
d.ellipse([cx - 40, cy - 20, cx + 96, cy + 116], fill=(224, 83, 61, 255))       # red face patch
d.polygon([(cx + r - 8, cy - 18), (cx + r + 78, cy + 22), (cx + r - 4, cy + 58)], fill=(217, 142, 4, 255))  # beak
d.ellipse([cx + 34, cy - 64, cx + 92, cy - 6], fill=(16, 16, 20, 255))          # eye
d.ellipse([cx + 52, cy - 48, cx + 76, cy - 24], fill=(246, 247, 252, 255))      # glint
# wing swoosh
d.arc([cx - r - 26, cy - r + 6, cx + 60, cy + r + 60], start=110, end=250, fill=(16, 16, 20, 90), width=26)

out = os.path.dirname(os.path.abspath(__file__)) + "/../apps/desktop/build"
os.makedirs(out, exist_ok=True)
img.save(out + "/icon.png")
for n in (256, 128, 64, 48, 32, 16):
    img.resize((n, n), Image.Resampling.LANCZOS).save(f"{out}/icon-{n}.png")
img.resize((256, 256), Image.Resampling.LANCZOS).save(out + "/icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("icons written to", out)
