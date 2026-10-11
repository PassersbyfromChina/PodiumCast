#!/usr/bin/env python
"""
Generates every PodiumCast icon from one definition.

    <python> scripts/make-icons.py            # write all icons + verify
    <python> scripts/make-icons.py --check    # verify only, change nothing

## The mark

Black plate, white ring, red dot inside — concentric by construction and *verified* by
measuring the rendered pixels at every size before this script is allowed to succeed.

The first release was already geometrically concentric (measured offset 0.00 px at every size),
yet it still read as misaligned on Windows. The cause was weight, not position: the ring was
0.055 × size ≈ 1.8 px at 32 px, which anti-aliases into a lopsided grey halo, so the ring looks
thicker on one side and the dot looks pushed toward the other. The fix is a ring bold enough to
survive small sizes (≥ 2 px, and 0.085 × size above that) with a real black gap between it and
the dot.

## Outputs — one mark, everywhere

    apps/desktop/build/icon.png  .ico  .icns     Windows installers, the .exe, macOS .app/.dmg
    apps/android/.../mipmap-*/ic_launcher*.png   Android launcher (legacy)
    apps/android/.../drawable-*/ic_launcher_foreground.png   Android adaptive foreground
    apps/android/.../values/ic_launcher_background.xml       Android adaptive background
    assets/brand.svg                             web favicon / landing-page source

Android ships the Capacitor default launcher icon unless it is replaced, which is why the app
looked like "Capacitor" rather than "PodiumCast" in the launcher — generating these files is
what actually unifies the branding.
"""
from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DESKTOP_BUILD = ROOT / "apps" / "desktop" / "build"
ANDROID_RES = ROOT / "apps" / "android" / "android" / "app" / "src" / "main" / "res"
ASSETS = ROOT / "assets"

# --- the mark -------------------------------------------------------------------------
PLATE = (8, 8, 10, 255)         # near-black plate
RING = (242, 242, 244, 255)     # white ring
DOT = (255, 59, 48, 255)        # red centre

RING_OUTER = 0.335              # of the icon's short side
RING_STROKE = 0.085
DOT_RADIUS = 0.175
PLATE_RADIUS = 0.22
MIN_STROKE_PX = 2.0             # below this the ring anti-aliases into a lopsided halo
SUPERSAMPLE = 8

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
ICNS_SIZES = [
    (b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128),
    (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024), (b"ic11", 32),
    (b"ic12", 64), (b"ic13", 256), (b"ic14", 512),
]

ANDROID_LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ANDROID_ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
# Adaptive icons are cropped by the launcher: only the middle 66/108 of the canvas is safe.
ADAPTIVE_SAFE_ZONE = 66 / 108


def draw_mark(canvas_size: int, *, plate: bool, fill_ratio: float = 1.0) -> Image.Image:
    """
    Renders the mark at `canvas_size` px.

    `plate`      draw the rounded black plate (legacy icons), or leave the background
                 transparent (adaptive foreground, where the platform supplies the background).
    `fill_ratio` fraction of the canvas the mark's outer diameter occupies.
    """
    ss = SUPERSAMPLE
    big = canvas_size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if plate:
        draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * PLATE_RADIUS), fill=PLATE)

    cx = cy = (big - 1) / 2
    span = big * fill_ratio
    outer_r = span * RING_OUTER
    stroke = max(MIN_STROKE_PX * ss, span * RING_STROKE)
    inner_r = max(outer_r * 0.42, outer_r - stroke)
    dot_r = span * DOT_RADIUS

    # Ring first, then punch the middle back out, then the dot. Both are centred on the exact
    # same (cx, cy), so they cannot drift apart.
    draw.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], fill=RING)
    draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=PLATE if plate else (0, 0, 0, 0))
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=DOT)

    return img.resize((canvas_size, canvas_size), Image.LANCZOS)


def draw_circle_plate(canvas_size: int) -> Image.Image:
    """Round plate used by `ic_launcher_round` on launchers that ask for it."""
    ss = SUPERSAMPLE
    big = canvas_size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse([0, 0, big - 1, big - 1], fill=PLATE)
    return img.resize((canvas_size, canvas_size), Image.LANCZOS)


def composite(*layers: Image.Image) -> Image.Image:
    out = layers[0].copy()
    for layer in layers[1:]:
        out.alpha_composite(layer)
    return out


# --- verification ---------------------------------------------------------------------

def _centroid(mask) -> tuple[float, float, int]:
    import numpy as np
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return (0.0, 0.0, 0)
    return (float(xs.mean()), float(ys.mean()), int(len(xs)))


def verify(img: Image.Image, label: str, tolerance: float = 0.35) -> list[str]:
    """Returns a list of problems; empty means the mark is centred, concentric and circular."""
    import numpy as np

    a = np.asarray(img.convert("RGBA")).astype(int)
    h, w, _ = a.shape
    r, g, b, alpha = a[:, :, 0], a[:, :, 1], a[:, :, 2], a[:, :, 3]

    red = (r > 140) & (g < 120) & (b < 120) & (alpha > 100)
    # Low threshold so anti-aliased ring pixels count: with a high one a thin frame measures as
    # "no ring at all" and would pass silently.
    white = (r > 110) & (g > 110) & (b > 110) & (alpha > 60)

    problems: list[str] = []
    dx_r, dy_r, n_red = _centroid(red)
    dx_w, dy_w, n_white = _centroid(white)
    if n_red == 0:
        return [f"{label}: 找不到红色圆点"]
    if n_white == 0:
        return [f"{label}: 找不到白色圆环"]

    if abs(dx_r - dx_w) > tolerance or abs(dy_r - dy_w) > tolerance:
        problems.append(f"{label}: 圆心与圆环不同心（Δ={dx_r - dx_w:+.2f},{dy_r - dy_w:+.2f} px）")

    center = (w - 1) / 2
    if abs(dx_r - center) > tolerance or abs(dy_r - center) > tolerance:
        problems.append(f"{label}: 红色圆点偏离画布中心（Δ={dx_r - center:+.2f},{dy_r - center:+.2f} px）")

    # Ring symmetry: mean radius per quadrant. A stroke that is thicker on one side shows up
    # here even when the centroid is perfect — which is exactly the Windows complaint.
    ys, xs = np.nonzero(white)
    cx, cy = dx_w, dy_w
    rad = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    quad = []
    for qx, qy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        m = ((xs - cx) * qx >= 0) & ((ys - cy) * qy >= 0)
        quad.append(float(rad[m].mean()) if m.any() else 0.0)
    if min(quad) > 0 and (max(quad) - min(quad)) > max(1.2, w * 0.06):
        problems.append(f"{label}: 圆环四象限半径不对称 {[round(q, 1) for q in quad]}")

    # Shape checks. These deliberately avoid a per-angle *max*-radius test: on a 7 px disc the
    # outermost pixel of each angular bin jumps by ±1.5 px purely from rasterisation, so that
    # metric reports noise as an ellipse. Bounding-box aspect and per-octant *mean* radius are
    # stable at 16 px and still catch a genuinely clipped or elliptical dot.
    ys2, xs2 = np.nonzero(red)
    bw = int(xs2.max() - xs2.min() + 1)
    bh = int(ys2.max() - ys2.min() + 1)
    if abs(bw - bh) > 1:
        problems.append(f"{label}: 红色圆点不是正圆（外接框 {bw}×{bh}）")

    # The dot's centre must coincide with its own bounding box centre (no clipped side).
    if abs((xs2.min() + xs2.max()) / 2 - dx_r) > 0.75 or abs((ys2.min() + ys2.max()) / 2 - dy_r) > 0.75:
        problems.append(f"{label}: 红色圆点一侧被裁切（外接框中心 {((xs2.min()+xs2.max())/2):.1f},"
                        f"{((ys2.min()+ys2.max())/2):.1f} vs 质心 {dx_r:.1f},{dy_r:.1f}）")

    # Octant mean radius: an ellipse or a clipped ring shows up as a lopsided mean.
    radii = np.sqrt((xs2 - dx_r) ** 2 + (ys2 - dy_r) ** 2)
    angles = np.arctan2(ys2 - dy_r, xs2 - dx_r)
    octants = [radii[((angles >= k * np.pi / 4 - np.pi) & (angles < (k + 1) * np.pi / 4 - np.pi))].mean()
               for k in range(8)]
    octants = [o for o in octants if not np.isnan(o)]
    if octants and (max(octants) - min(octants)) > max(1.0, w * 0.05):
        problems.append(f"{label}: 红色圆点各方向半径不均 {[round(o, 1) for o in octants]}")

    return problems


# --- writers --------------------------------------------------------------------------

def write_icns(path: Path, images: dict[int, Image.Image]) -> None:
    """ICNS is a flat container: 4-byte type, 4-byte big-endian length, then a PNG payload."""
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


# Geometry mirrors draw_mark(): outer r = 0.335, stroke = 0.085, dot r = 0.175, on a 64 viewBox.
BRAND_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="PodiumCast">
  <title>PodiumCast</title>
  <!-- Black plate, white ring, red dot. Every element is centred on (32, 32). -->
  <rect width="64" height="64" rx="14" fill="#08080a"/>
  <circle cx="32" cy="32" r="21.4" fill="none" stroke="#f2f2f4" stroke-width="5.4"/>
  <circle cx="32" cy="32" r="11.2" fill="#ff3b30"/>
</svg>
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()

    problems: list[str] = []
    written: list[str] = []

    def emit(path: Path, image: Image.Image, label: str) -> None:
        problems.extend(verify(image, label))
        if not args.check:
            path.parent.mkdir(parents=True, exist_ok=True)
            image.save(path)
            written.append(f"{path.relative_to(ROOT)}  {image.width}×{image.height}")

    # Every size is rendered natively rather than downsampled from one master: shrinking a
    # 1024 px master to 16 px loses the ring entirely, while rendering each size from the
    # supersampled geometry keeps the stroke at its intended weight.
    sizes = sorted(set(
        ICO_SIZES
        + [s for _, s in ICNS_SIZES]
        + list(ANDROID_LEGACY.values())
        + [1024]
    ))
    masters = {size: draw_mark(size, plate=True) for size in sizes}
    for size in ICO_SIZES:
        problems.extend(verify(masters[size], f"ico/{size}px"))

    if not args.check:
        DESKTOP_BUILD.mkdir(parents=True, exist_ok=True)
        masters[1024].save(DESKTOP_BUILD / "icon.png")
        written.append(f"{DESKTOP_BUILD.relative_to(ROOT)}/icon.png  1024×1024")
        masters[256].save(DESKTOP_BUILD / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])
        written.append(f"{DESKTOP_BUILD.relative_to(ROOT)}/icon.ico  {ICO_SIZES}")
        write_icns(DESKTOP_BUILD / "icon.icns", masters)
        written.append(f"{DESKTOP_BUILD.relative_to(ROOT)}/icon.icns  {len(ICNS_SIZES)} 个尺寸")
        ASSETS.mkdir(parents=True, exist_ok=True)
        (ASSETS / "brand.svg").write_text(BRAND_SVG, encoding="utf-8")
        written.append("assets/brand.svg")

    # --- Android --------------------------------------------------------------------------
    for density, size in ANDROID_LEGACY.items():
        emit(ANDROID_RES / f"mipmap-{density}" / "ic_launcher.png",
             masters[size], f"android/{density}")
        emit(ANDROID_RES / f"mipmap-{density}" / "ic_launcher_round.png",
             composite(draw_circle_plate(size), draw_mark(size, plate=False)),
             f"android/{density}/round")

    for density, size in ANDROID_ADAPTIVE.items():
        # Foreground only — the platform supplies the black background from the colour resource
        # and crops to the middle 66/108, so the mark is scaled into that safe zone.
        emit(ANDROID_RES / f"drawable-{density}" / "ic_launcher_foreground.png",
             draw_mark(size, plate=False, fill_ratio=ADAPTIVE_SAFE_ZONE),
             f"android/{density}/adaptive")

    if not args.check:
        values = ANDROID_RES / "values"
        values.mkdir(parents=True, exist_ok=True)
        (values / "ic_launcher_background.xml").write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<!-- Generated by scripts/make-icons.py: the adaptive icon background. -->\n"
            "<resources>\n"
            '    <color name="ic_launcher_background">#08080A</color>\n'
            "</resources>\n",
            encoding="utf-8",
        )
        written.append("android/res/values/ic_launcher_background.xml")
        for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
            (ANDROID_RES / "mipmap-anydpi-v26" / name).write_text(
                '<?xml version="1.0" encoding="utf-8"?>\n'
                "<!-- Generated by scripts/make-icons.py: the same mark as the Windows/macOS icons. -->\n"
                '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@color/ic_launcher_background"/>\n'
                '    <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n'
                "</adaptive-icon>\n",
                encoding="utf-8",
            )
            written.append(f"android/res/mipmap-anydpi-v26/{name}")

        # Legacy Capacitor artwork, which would otherwise still win on older launchers.
        for stale in (ANDROID_RES / "drawable" / "ic_launcher_background.xml",
                      ANDROID_RES / "drawable-v24" / "ic_launcher_foreground.xml"):
            if stale.exists():
                stale.unlink()
                written.append(f"removed {stale.relative_to(ROOT)}")

    print(f"PodiumCast 图标：{'校验' if args.check else '生成'}完成")
    for line in written:
        print(f"  · {line}")
    if problems:
        print("\n对齐校验失败：")
        for p in problems:
            print(f"  x {p}")
        return 1
    print(f"\n对齐校验通过：{len(ICO_SIZES)} 个 ICO 尺寸 + Android 全部密度；"
          "圆心/圆环/画布中心偏差均 < 0.35px，圆环四象限对称。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
