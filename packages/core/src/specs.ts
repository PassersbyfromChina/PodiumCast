/**
 * Recording-spec enumeration and display matching.
 *
 * 要求.txt (一：启动配置) asks for two things this module owns:
 *
 *   1. The Cast reads out the *available* recording spec combinations on startup
 *      (colour gamut / resolution / aspect / frame rate).
 *   2. On the first connection to a big screen, pick the recording aspect that is identical
 *      to — or closest to — that screen's aspect.
 *
 * Matching is deliberately deterministic and explainable: the Stage UI shows the same note
 * that {@link matchSpec} produces, so the user can see *why* a mode was chosen.
 */
import type { ColorSpace, DisplaySpec, RecordingSpec } from './protocol';

export const COLOR_SPACES: readonly ColorSpace[] = ['srgb', 'rec709', 'p3', 'rec2020'] as const;

export const COLOR_SPACE_LABEL: Record<ColorSpace, string> = {
  srgb: 'sRGB',
  rec709: 'Rec.709',
  p3: 'Display P3',
  rec2020: 'Rec.2020',
};

/** Aspect ratios we normalise to, widest first. Anything else keeps its reduced w:h. */
const KNOWN_ASPECTS: ReadonlyArray<readonly [number, number]> = [
  [21, 9], [2, 1], [16, 9], [16, 10], [3, 2], [4, 3], [5, 4], [1, 1],
  [4, 5], [3, 4], [2, 3], [10, 16], [9, 16], [9, 21],
];

/** Relative tolerance when deciding "the recording aspect exactly matches the screen". */
export const ASPECT_MATCH_TOLERANCE = 0.005;

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { const t = b; b = a % b; a = t }
  return a || 1;
}

/** Reduces `w:h` and snaps it to a well-known label when it is close enough. */
export function aspectLabel(width: number, height: number): string {
  const ratio = width / height;
  for (const [w, h] of KNOWN_ASPECTS) {
    if (Math.abs(ratio - w / h) <= ASPECT_MATCH_TOLERANCE * Math.max(1, w / h)) {
      return `${w}:${h}`;
    }
  }
  const d = gcd(width, height);
  return `${Math.round(width / d)}:${Math.round(height / d)}`;
}

/** `true` when the two ratios are the same to within {@link ASPECT_MATCH_TOLERANCE}. */
export function aspectEquals(a: number, b: number): boolean {
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= ASPECT_MATCH_TOLERANCE;
}

export function specId(width: number, height: number, fps: number, colorSpace: ColorSpace): string {
  return `${width}x${height}@${fps}|${colorSpace}`;
}

export function makeSpec(
  width: number,
  height: number,
  fps: number,
  colorSpace: ColorSpace,
  extra: Partial<RecordingSpec> = {},
): RecordingSpec {
  return {
    id: specId(width, height, fps, colorSpace),
    width,
    height,
    aspect: aspectLabel(width, height),
    ratio: width / height,
    fps,
    colorSpace,
    label: `${width}×${height} · ${fps}fps · ${aspectLabel(width, height)} · ${COLOR_SPACE_LABEL[colorSpace]}`,
    ...extra,
  };
}

/** Raw shape we get back from `MediaTrackCapabilities` before it becomes a RecordingSpec. */
export interface RawMode {
  width: number;
  height: number;
  fps: number;
  colorSpace?: ColorSpace;
  native?: boolean;
}

/**
 * Expands a camera's advertised sizes/rates into concrete specs.
 *
 * Cameras report `width` and `height` as independent ranges, so the cartesian product is not
 * meaningful — instead every advertised resolution is paired with every advertised rate,
 * capped to a sane list so the settings panel stays usable.
 */
export function buildSpecs(widths: number[], heights: number[], rates: number[], colorSpaces: ColorSpace[] = ['srgb']): RecordingSpec[] {
  const sizes = new Map<string, { w: number; h: number }>();
  const sortedW = [...new Set(widths)].filter((n) => n > 0).sort((a, b) => b - a);
  const sortedH = [...new Set(heights)].filter((n) => n > 0).sort((a, b) => b - a);
  for (const w of sortedW) {
    for (const h of sortedH) {
      // Only keep sane landscape/portrait pairs; a 640×2160 mode is a driver artefact.
      const ratio = w / h;
      if (ratio > 3.2 || ratio < 0.31) continue;
      const key = `${w}x${h}`;
      if (!sizes.has(key)) sizes.set(key, { w, h });
    }
  }
  // If the camera reports a single width/height pair, keep just that one.
  if (sizes.size === 0 && sortedW.length && sortedH.length) {
    sizes.set(`${sortedW[0]}x${sortedH[0]}`, { w: sortedW[0], h: sortedH[0] });
  }
  const fps = [...new Set(rates)].filter((n) => n > 0 && n <= 240).sort((a, b) => b - a);

  const out: RecordingSpec[] = [];
  const seen = new Set<string>();
  for (const { w, h } of sizes.values()) {
    for (const f of fps.length ? fps : [30]) {
      for (const cs of colorSpaces) {
        const spec = makeSpec(w, h, f, cs);
        if (seen.has(spec.id)) continue;
        seen.add(spec.id);
        out.push(spec);
      }
    }
  }
  return sortSpecs(out);
}

/** Highest resolution first, then highest frame rate, then colour space preference. */
export function sortSpecs(specs: RecordingSpec[]): RecordingSpec[] {
  return [...specs].sort((a, b) => {
    const pa = a.width * a.height;
    const pb = b.width * b.height;
    if (pb !== pa) return pb - pa;
    if (b.fps !== a.fps) return b.fps - a.fps;
    return COLOR_SPACES.indexOf(a.colorSpace) - COLOR_SPACES.indexOf(b.colorSpace);
  });
}

export interface MatchResult {
  spec: RecordingSpec | null;
  /** Human readable justification, surfaced verbatim in both UIs. */
  note: string;
  /** Lower is better; exposed so callers can compare alternatives. */
  score: number;
}

/**
 * Picks the recording spec that best fits a display.
 *
 * Ordering of concerns, matching 要求.txt:
 *   1. aspect identical to the screen (a perfect match beats everything),
 *   2. then closest aspect,
 *   3. then smallest resolution that still covers the screen (no upscaling artifacts),
 *   4. then frame rate closest to the display refresh,
 *   5. then colour space preference.
 */
export function matchSpec(specs: RecordingSpec[], display: DisplaySpec | null | undefined): MatchResult {
  if (!specs.length) return { spec: null, note: '拍摄端没有可用的录制规格', score: Infinity };
  if (!display || !isFinite(display.ratio) || display.ratio <= 0) {
    const fallback = specs.find((s) => s.aspect === '16:9') ?? specs[0];
    return { spec: fallback, note: '未收到大屏规格，使用默认 16:9', score: Infinity };
  }

  let best: RecordingSpec | null = null;
  let bestScore = Infinity;
  let bestExact = false;
  let bestNote = '';

  for (const s of specs) {
    const exact = aspectEquals(s.ratio, display.ratio);
    // Aspect error dominates: 1% of aspect error costs as much as a 2.5x resolution miss.
    const aspectErr = Math.abs(s.ratio - display.ratio) / display.ratio;

    // Prefer the smallest mode that still covers the display vertically, to avoid
    // shipping pixels the panel cannot show.
    let resErr: number;
    if (s.height >= display.height) resErr = (s.height - display.height) / display.height;
    else resErr = 1.5 * ((display.height - s.height) / display.height); // under-covering hurts more

    const fpsErr = display.fps > 0 ? Math.abs(s.fps - display.fps) / display.fps : 0;
    const csErr = s.colorSpace === display.colorSpace ? 0 : 0.05;

    const score = aspectErr * 10 + resErr * 0.6 + fpsErr * 0.3 + csErr;
    if (score < bestScore - 1e-9 || (exact && !bestExact)) {
      best = s;
      bestScore = score;
      bestExact = exact;
      bestNote = exact
        ? `已匹配大屏比例 ${display.aspect}（${display.width}×${display.height}）`
        : `最接近大屏比例 ${display.aspect}：${s.aspect}（差 ${(aspectErr * 100).toFixed(1)}%）`;
    }
  }

  if (!best) {
    const fallback = specs.find((s) => s.aspect === '16:9') ?? specs[0];
    return { spec: fallback, note: '无匹配结果，回退到 16:9', score: Infinity };
  }
  if (bestExact && display.fps > 0 && best.fps < display.fps) {
    bestNote += `；帧率 ${best.fps} < 大屏 ${display.fps}Hz`;
  }
  return { spec: best, note: bestNote, score: bestScore };
}

/** True when the capture aspect matches the screen aspect exactly (drives the UI layout). */
export function isPerfectFit(spec: RecordingSpec | null, screenWidth: number, screenHeight: number): boolean {
  if (!spec) return false;
  const screenRatio = screenWidth / screenHeight;
  return Math.abs(spec.ratio - screenRatio) / Math.max(spec.ratio, screenRatio) <= ASPECT_MATCH_TOLERANCE;
}

export type FitAxis = 'width' | 'height';

/**
 * Which axis of the preview is the constraint, i.e. where the letterbox bars land.
 *
 * - `width`  : the capture is *wider* than the screen → vertical bars left/right
 *              ("预览比例过宽" → controls beside the preview, left/right)
 * - `height` : the capture is *taller* than the screen → horizontal bars top/bottom
 *              ("预览比例过长" → controls above/below, top/bottom)
 */
export function fitAxis(spec: RecordingSpec | null, screenWidth: number, screenHeight: number): FitAxis {
  if (!spec) return 'width';
  return spec.ratio >= screenWidth / screenHeight ? 'width' : 'height';
}

export interface Letterbox {
  /** Pixels of unused screen on the left/top of the preview. */
  offsetX: number;
  offsetY: number;
  /** Rendered preview size that fits inside the screen without distortion. */
  width: number;
  height: number;
  /** Size of the largest empty band, in pixels — decides how many control rows fit. */
  bandLeft: number;
  bandRight: number;
  bandTop: number;
  bandBottom: number;
  /** How many stacked control rows the empty bands can hold. */
  rows: number;
  columns: number;
}

/**
 * Computes the letterbox a recording aspect produces inside a screen, assuming the preview
 * is scaled to be as large as possible (`contain`).
 */
export function computeLetterbox(spec: RecordingSpec | null, screenWidth: number, screenHeight: number, rowHeightPx = 56): Letterbox {
  const sw = Math.max(1, screenWidth);
  const sh = Math.max(1, screenHeight);
  if (!spec || spec.width <= 0 || spec.height <= 0) {
    return { offsetX: 0, offsetY: 0, width: sw, height: sh, bandLeft: 0, bandRight: 0, bandTop: 0, bandBottom: 0, rows: 0, columns: 1 };
  }
  const scale = Math.min(sw / spec.width, sh / spec.height);
  const width = Math.round(spec.width * scale);
  const height = Math.round(spec.height * scale);
  const slackX = sw - width;
  const slackY = sh - height;
  const bandLeft = Math.floor(slackX / 2);
  const bandRight = slackX - bandLeft;
  const bandTop = Math.floor(slackY / 2);
  const bandBottom = slackY - bandTop;
  return {
    offsetX: bandLeft,
    offsetY: bandTop,
    width,
    height,
    bandLeft,
    bandRight,
    bandTop,
    bandBottom,
    rows: Math.max(0, Math.floor(Math.max(bandTop, bandBottom) / rowHeightPx)),
    columns: Math.max(0, Math.floor(Math.max(bandLeft, bandRight) / rowHeightPx)),
  };
}
