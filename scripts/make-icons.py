#!/usr/bin/env python
"""
Generates the PodiumCast application icons.

Run with the bundled Python (Pillow is available there):

    <python> scripts/make-icons.py

Outputs into apps/desktop/build/:
    icon.png   1024x1024  — Linux, and the source electron-builder uses for macOS
    icon.ico   multi-size — Windows installers, shortcuts and the .exe itself
    icon.icns  multi-size — macOS, generated here so the CI runner needs no iconutil

The mark is deliberately simple and matches the in-app favicon and the landing page: a
near-black rounded square holding the red "record" dot inside a white ring. No gradients, no
text — it has to stay legible at 16 px in a taskbar.
"""
from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - only hit outside the bundled runtime
    sys.exit("Pillow is required: use the bundled Python from load_workspace_dependencies")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "desktop" / "build"

BACKGROUND = (8, 8, 10, 255)
RING = (242, 242, 244, 255)
ACCENT = (255, 59, 48, 255)

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# ICNS type codes, per Apple's Icon File Format documentation.
ICNS_SIZES = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"icp6", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic13", 256),
    (b"ic14", 512),
]


def render(size: int) -> Image.Image:
    """Draws the mark at `size` px with 4x supersampling for clean edges."""
    ss = 4
    big = size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded square plate. Radius ~22% keeps the silhouette close to the platform norm.
    radius = int(big * 0.22)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BACKGROUND)

    cx = cy = big / 2
    # White ring: the "cast" target.
    ring_r = big * 0.30
    ring_w = max(ss, int(big * 0.055))
    draw.ellipse(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        outline=RING,
        width=ring_w,
    )
    # Red record dot.
    dot_r = big * 0.155
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


def write_icns(path: Path, images: dict[int, Image.Image]) -> None:
    """ICNS is a flat container: 4-byte type, 4-byte big-endian length, then PNG payload."""
    chunks: list[bytes] = []
    for code, size in ICNS_SIZES:
        img = images.get(size)
        if img is None:
            continue
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        payload = buf.getvalue()
        chunks.append(code + struct.pack(">I", len(payload) + 8) + payload)
    body = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    base = render(1024)
    base.save(OUT / "icon.png", format="PNG")
    print(f"  icon.png   1024x1024  { (OUT / 'icon.png').stat().st_size / 1024:.1f} KB")

    images = {size: render(size) for size in sorted(set(ICO_SIZES) | {s for _, s in ICNS_SIZES})}
    images[256].save(OUT / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"  icon.ico   {ICO_SIZES}  { (OUT / 'icon.ico').stat().st_size / 1024:.1f} KB")

    write_icns(OUT / "icon.icns", images)
    print(f"  icon.icns  {len(ICNS_SIZES)} entries  { (OUT / 'icon.icns').stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
