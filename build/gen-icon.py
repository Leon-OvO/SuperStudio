"""Generate app icons matching the login page Sparkles design.

The login page shows: rounded-xl square with primary color background +
white Sparkles (lucide-react) icon. We approximate the Sparkles shape with
a 4-point star polygon plus two small + marks (matching the lucide layout).

Primary color = hsl(243 75% 59%) ≈ (80, 72, 229).
"""
from PIL import Image, ImageDraw
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
PRIMARY = (80, 72, 229)      # hsl(243, 75%, 59%) → indigo
WHITE = (255, 255, 255)

def render(size: int) -> Image.Image:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square background (Tailwind rounded-xl ≈ 0.75rem on 12rem
    # square → ~18% corner radius for visual parity)
    radius = int(size * 0.20)
    d.rounded_rectangle([0, 0, size, size], radius=radius, fill=PRIMARY)

    cx = size / 2
    cy = size / 2

    # Main 4-point sparkle, centered. Outer reach ~30% of canvas, sharp
    # concave inner radius ≈ 7% gives the slim "sparkle" silhouette.
    outer = size * 0.30
    inner = size * 0.07
    star = [
        (cx,         cy - outer),
        (cx + inner, cy - inner),
        (cx + outer, cy),
        (cx + inner, cy + inner),
        (cx,         cy + outer),
        (cx - inner, cy + inner),
        (cx - outer, cy),
        (cx - inner, cy - inner),
    ]
    d.polygon(star, fill=WHITE)

    # Two small "+" marks (lucide Sparkles has them at top-right (20,5)
    # and bottom-left (4,18) on the 24-unit grid)
    def plus(px: float, py: float, arm: float, thick: float):
        d.rectangle([px - arm, py - thick / 2, px + arm, py + thick / 2], fill=WHITE)
        d.rectangle([px - thick / 2, py - arm, px + thick / 2, py + arm], fill=WHITE)

    arm = size * 0.045
    thick = max(2.0, size * 0.022)
    # top-right and bottom-left, slightly outside the star tips
    plus(cx + outer * 0.95, cy - outer * 0.95, arm, thick)
    plus(cx - outer * 0.95, cy + outer * 0.95, arm, thick)

    return img


# Master PNG at 1024 (used by Linux + general purpose; electron-builder
# can downscale where needed)
master = render(1024)
master.save(os.path.join(OUT_DIR, 'icon.png'))

# Windows ICO: render once at the largest size and let Pillow downscale.
# Pillow's ICO writer derives each requested size from this one image — the
# vector-style sparkle scales cleanly, so a single 256px render is enough.
sizes = [16, 24, 32, 48, 64, 128, 256]
ico_master = render(256)
ico_master.save(
    os.path.join(OUT_DIR, 'icon.ico'),
    format='ICO',
    sizes=[(s, s) for s in sizes],
)

print(f'wrote icon.png ({master.size[0]}x{master.size[1]}) and icon.ico (sizes={sizes})')

# Tray icon: small PNG, base64 emitted to a sidecar file so tray.ts can embed
# it inline (no runtime filesystem lookup — works equally in dev and packaged).
import base64, io
tray = render(32)
tray.save(os.path.join(OUT_DIR, 'tray.png'))
buf = io.BytesIO(); tray.save(buf, format='PNG')
b64 = base64.b64encode(buf.getvalue()).decode('ascii')
with open(os.path.join(OUT_DIR, 'tray.b64.txt'), 'w', encoding='ascii') as f:
    f.write(b64)
print(f'wrote tray.png (32x32) and tray.b64.txt ({len(b64)} chars)')
