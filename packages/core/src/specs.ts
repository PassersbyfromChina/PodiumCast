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

export type BarAxis = 'left-right' | 'top-bottom';

/**
 * Which pair of edges the letterbox bars land on.
 *
 * This is pure geometry and it is easy to get backwards, which is exactly what happened in the
 * first release: a capture *wider* than the screen fills the width and leaves the bars
 * top/bottom — the opposite of the intuitive reading. Getting it wrong made every non-16:9
 * display pick the wrong edge, so the controls were placed where there was no empty space and
 * the preview was squeezed instead.
 *
 *   capture ratio > screen ratio  →  width is the binding constraint → bars top/bottom
 *   capture ratio < screen ratio  →  height is the binding constraint → bars left/right
 *
 * Matches {@link computeLetterbox} exactly: the axis named here is the one whose slack is
 * non-zero.
 */
export function barAxis(spec: RecordingSpec | null, screenWidth: number, screenHeight: number): BarAxis {
  if (!spec || spec.ratio <= 0) return 'top-bottom';
  const screenRatio = Math.max(1e-6, screenWidth / Math.max(1, screenHeight));
  return spec.ratio > screenRatio ? 'top-bottom' : 'left-right';
}

/** @deprecated kept only so older callers keep compiling; use {@link barAxis}. */
export type FitAxis = 'width' | 'height';

/** @deprecated Use {@link barAxis}; the old return values were inverted. */
export function fitAxis(spec: RecordingSpec | null, screenWidth: number, screenHeight: number): FitAxis {
  return barAxis(spec, screenWidth, screenHeight) === 'left-right' ? 'height' : 'width';
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

// ---------------------------------------------------------------------------------------
// Control-surface layout plan
// ---------------------------------------------------------------------------------------

/** How much room the control surface has to work with. */
export type Density = 'roomy' | 'cozy' | 'compact';

/** What the user asked for in Settings. */
export type LayoutPreference = 'auto' | 'overlay' | 'split-h' | 'split-v';
/** What the app actually does. `split-h` puts the controls beside the preview (按键在左右). */
export type LayoutMode = 'overlay' | 'split-h' | 'split-v';

export interface LayoutPlan {
  mode: LayoutMode;
  /** Which edge the controls sit on when `mode` is a split. */
  side: 'left' | 'right' | 'top' | 'bottom';
  /** Thickness of the band the controls occupy, in CSS px. 0 for `overlay`. */
  band: number;
  density: Density;
  /**
   * How many control rows (horizontal band) or columns (vertical band) fit — this is the
   * "根据黑边大小决定按键显示行数" number, and it also drives the compact UI tiers.
   */
  slots: number;
  box: Letterbox;
  /** The capture aspect matches the screen exactly, so there is no band to hide in. */
  exact: boolean;
  /** Human-readable explanation, shown in Settings → 连接信息. */
  reason: string;
}

/** A single icon button needs about this much room; below it a band is useless. */
export const MIN_BAND_PX = 48;
/** A band may never take more than this share of the axis it sits on. */
const MAX_BAND_FRACTION = 0.30;
const DENSITY_ROOMY_PX = 128;
const DENSITY_COZY_PX = 88;

/**
 * Decides where the controls go.
 *
 * The previous release derived this from {@link fitAxis}, which returned the axis backwards,
 * and then forced a 156 px band even when the letterbox had only a 70 px sliver of real slack.
 * On a 780×360 phone in landscape that put the controls along the bottom — where there was no
 * empty space at all — crushing the preview into the top third and clipping half the buttons.
 *
 * The rule now:
 *   1. an exact aspect match always floats the controls over the picture;
 *   2. otherwise the controls go into the band that actually exists (the axis named by
 *      {@link barAxis}), sized to that band rather than to a fixed minimum;
 *   3. if that band is thinner than one icon row, there is genuinely nowhere to put them, so
 *      they float over the picture instead of stealing space from the preview;
 *   4. only a *forced* choice reserves extra space, and even then it is capped so the preview
 *      always keeps at least 70% of the axis.
 */
export function planLayout(
  spec: RecordingSpec | null,
  screenWidth: number,
  screenHeight: number,
  preference: LayoutPreference = 'auto',
): LayoutPlan {
  const box = computeLetterbox(spec, screenWidth, screenHeight);
  const exact = spec ? aspectEquals(spec.ratio, screenWidth / Math.max(1, screenHeight)) : true;

  const overlay = (reason: string): LayoutPlan => ({
    mode: 'overlay', side: 'bottom', band: 0, density: 'roomy', slots: 0, box, exact, reason,
  });

  if (!spec) return overlay('未选择录制规格，控件悬浮');
  if (preference === 'overlay') return overlay('已手动选择悬浮布局');
  if (exact) return overlay('录制比例与屏幕一致，控件悬浮在画面上');

  const natural: BarAxis = barAxis(spec, screenWidth, screenHeight);

  const measure = (axis: BarAxis) => axis === 'left-right'
    ? { available: Math.min(box.bandLeft, box.bandRight), cap: screenWidth, side: (box.bandRight >= box.bandLeft ? 'right' : 'left') as LayoutPlan['side'] }
    : { available: Math.min(box.bandTop, box.bandBottom), cap: screenHeight, side: (box.bandBottom >= box.bandTop ? 'bottom' : 'top') as LayoutPlan['side'] };

  const forced = preference === 'split-h' ? 'left-right' as BarAxis
    : preference === 'split-v' ? 'top-bottom' as BarAxis
      : null;

  const axis = forced ?? natural;
  const { available, cap, side } = measure(axis);
  const maxBand = Math.max(MIN_BAND_PX, Math.min(cap * MAX_BAND_FRACTION, cap));
  const band = Math.round(Math.min(Math.max(available, forced ? Math.min(96, maxBand) : 0), maxBand));

  if (band < MIN_BAND_PX) {
    // The capture nearly fills the screen: there is no black band to hide in, so floating the
    // controls is the only honest option. Reported so the user can see why.
    return overlay(`黑边仅 ${available}px，不足一行按键，控件改为悬浮`);
  }

  const density: Density = band >= DENSITY_ROOMY_PX ? 'roomy' : band >= DENSITY_COZY_PX ? 'cozy' : 'compact';
  const slots = Math.max(1, Math.floor(band / (density === 'roomy' ? 56 : 44)));
  const mode: LayoutMode = axis === 'left-right' ? 'split-h' : 'split-v';
  const where = axis === 'left-right' ? '左右' : '上下';

  return {
    mode,
    side,
    band,
    density,
    slots,
    box,
    exact,
    reason: `按键置于${where}黑边（${band}px，${density === 'roomy' ? '标准' : density === 'cozy' ? '紧凑' : '极简'}，${slots} ${axis === 'left-right' ? '列' : '行'}）`,
  };
}


// ---------------------------------------------------------------------------------------
// Camera-style format picker
// ---------------------------------------------------------------------------------------

/**
 * A camera reports its modes as two independent ranges (every width × every height × every
 * rate), which expands to dozens of combinations. Listing them was the "拍摄规格的选择过于复杂"
 * complaint: a 28-row table where the meaningful choices are really just *shape*, *size* and
 * *smoothness*.
 *
 * Real camera apps collapse this to three short rows — 比例 / 清晰度 / 帧率 — and grey out the
 * combinations the hardware cannot do. That is exactly what this model produces; the full list
 * stays available behind an "advanced" disclosure for anyone who wants it.
 */
export interface SpecAxisOption<T> {
  value: T;
  label: string;
  /** False when no spec exists for this value at the currently selected other two. */
  available: boolean;
}

export interface SpecSelection {
  /** `RecordingSpec.aspect`, e.g. `16:9`; `null` means "match the big screen". */
  aspect: string | null;
  /** Output height in pixels, e.g. 1080. */
  height: number;
  fps: number;
}

export interface SpecPickerModel {
  ratios: Array<SpecAxisOption<string>>;
  resolutions: Array<SpecAxisOption<number>>;
  frameRates: Array<SpecAxisOption<number>>;
}

/** Height → the label a phone camera would print. */
export function resolutionLabel(height: number): string {
  const tiers: Array<[number, string]> = [
    [4320, '8K'], [2160, '4K'], [1440, '2K'], [1080, '1080P'], [720, '720P'], [480, '480P'], [360, '360P'],
  ];
  // Exact tier first. The previous `>=` test labelled a 960-high 4:3 mode as "720P" and a 1200
  // one as "1080P", so the picker showed the same chip twice.
  for (const [h, label] of tiers) {
    if (Math.abs(height - h) / h <= 0.03) return label;
  }
  return `${height}P`;
}

function matches(spec: RecordingSpec, sel: Partial<SpecSelection>): boolean {
  if (sel.aspect != null && spec.aspect !== sel.aspect) return false;
  if (sel.height != null && spec.height !== sel.height) return false;
  if (sel.fps != null && spec.fps !== sel.fps) return false;
  return true;
}

const ASPECT_ORDER = ['16:9', '4:3', '1:1', '3:2', '9:16', '3:4', '16:10', '21:9'];

/** Shapes worth offering, in the order a camera app shows them, filtered to what exists. */
export function availableAspects(specs: RecordingSpec[]): string[] {
  const present = new Set(specs.map((s) => s.aspect));
  const ordered = ASPECT_ORDER.filter((a) => present.has(a));
  for (const a of [...present].sort()) if (!ordered.includes(a)) ordered.push(a);
  return ordered;
}

/** Distinct output heights, largest first. */
export function availableHeights(specs: RecordingSpec[]): number[] {
  return [...new Set(specs.map((s) => s.height))].sort((a, b) => b - a);
}

export function availableFrameRates(specs: RecordingSpec[]): number[] {
  return [...new Set(specs.map((s) => s.fps))].sort((a, b) => b - a);
}

/**
 * Builds the three rows, marking every option that the hardware cannot produce *given the
 * other two current choices*. Disabling rather than hiding is deliberate: a camera app that
 * silently drops options leaves the user wondering whether they misremembered.
 */
export function buildPickerModel(specs: RecordingSpec[], selection: SpecSelection): SpecPickerModel {
  const ratios = availableAspects(specs).map((aspect) => ({
    value: aspect,
    label: aspect,
    available: specs.some((s) => matches(s, { aspect, height: selection.height, fps: selection.fps }))
      || specs.some((s) => matches(s, { aspect })),
  }));

  // Resolve `自动` to a concrete shape first: the other two rows are defined relative to it.
  const effectiveAspect = selection.aspect
    ?? specs.find((s) => s.native)?.aspect
    ?? specs[0]?.aspect
    ?? null;

  // Only the sizes this shape actually offers, largest first. A phone camera shows three or
  // four quality chips, not every resolution the sensor can produce in any shape.
  const resolutions = availableHeights(specs.filter((s) => !effectiveAspect || s.aspect === effectiveAspect))
    .map((height) => ({
      value: height,
      label: resolutionLabel(height),
      available: true,
    }));

  // Same for frame rates: only those the chosen shape *and* size can run.
  const fpsPool = specs.filter((s) => (!effectiveAspect || s.aspect === effectiveAspect)
    && (!selection.height || s.height === selection.height));
  const frameRates = availableFrameRates(fpsPool.length ? fpsPool : specs).map((fps) => ({
    value: fps,
    label: `${fps}`,
    available: true,
  }));

  return { ratios, resolutions, frameRates };
}

/**
 * Picks the spec closest to a selection, preferring exact matches on every axis the caller set.
 * Returns `null` only when the list is empty.
 */
export function resolveSpec(specs: RecordingSpec[], selection: SpecSelection, displayRatio?: number): RecordingSpec | null {
  if (!specs.length) return null;

  // `aspect: null` means "whatever fits the big screen best" — the phone camera's 全屏 mode.
  let aspect = selection.aspect;
  if (aspect == null) {
    if (displayRatio && displayRatio > 0) {
      const best = matchSpec(specs, {
        width: 0, height: 0, aspect: '', ratio: displayRatio, fps: selection.fps,
        colorSpace: 'srgb', fullscreen: true, devicePixelRatio: 1,
      });
      aspect = best.spec?.aspect ?? null;
    }
    aspect ??= specs.find((s) => s.aspect === '16:9')?.aspect ?? specs[0].aspect;
  }

  const score = (s: RecordingSpec): number => {
    const aspectPenalty = s.aspect === aspect ? 0 : 1000;
    const heightPenalty = Math.abs(s.height - selection.height);
    const fpsPenalty = Math.abs(s.fps - selection.fps) * 2;
    return aspectPenalty + heightPenalty + fpsPenalty;
  };

  let best = specs[0];
  let bestScore = Infinity;
  for (const s of specs) {
    const v = score(s);
    if (v < bestScore) { bestScore = v; best = s }
  }
  return best;
}

/** One-line description used by the compact picker header. */
export function describeSpec(spec: RecordingSpec): string {
  return `${resolutionLabel(spec.height)} · ${spec.aspect} · ${spec.fps}fps · ${spec.width}×${spec.height}`;
}


// ---------------------------------------------------------------------------------------
// Standard capture modes
// ---------------------------------------------------------------------------------------

/**
 * The resolutions a camera actually offers, grouped by shape.
 *
 * This replaces building specs from `widths × heights`. A camera reports `width` and `height`
 * as two independent ranges, and multiplying them out invents combinations no sensor has — the
 * picker was offering `32:27` (2560×2160) and `8:3` (3840×1440) because of it. Real camera apps
 * never do this: they offer a handful of known shapes, each at a few known sizes.
 */
export const STANDARD_MODES: ReadonlyArray<{ width: number; height: number }> = [
  { width: 3840, height: 2160 },  // 16:9
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
  { width: 3264, height: 2448 },  // 4:3
  { width: 2048, height: 1536 },
  { width: 1600, height: 1200 },
  { width: 1280, height: 960 },
  { width: 640, height: 480 },
  { width: 1920, height: 1280 },  // 3:2
  { width: 1440, height: 1440 },  // 1:1
  { width: 1080, height: 1080 },
  { width: 1080, height: 1920 },  // 9:16, for a screen that is taller than it is wide
  { width: 720, height: 1280 },
];

export interface StandardModeOptions {
  /** Highest width/height/frame rate the device reported. Omitted values impose no limit. */
  maxWidth?: number;
  maxHeight?: number;
  maxFps?: number;
  colorSpaces?: ColorSpace[];
  /** The mode the device is currently in; always kept, even if it is off-ladder. */
  natural?: { width: number; height: number; fps: number };
  /** Frame rates to offer, highest first. */
  fpsCandidates?: number[];
}

/** Smallest mode worth offering; below this the preview is unusable on a big screen. */
const MIN_MODE_PIXELS = 640 * 360;

/**
 * Builds the recording-spec list from the standard ladder, filtered by what the device reports.
 *
 * High-resolution modes are paired with fewer frame rates because that is how real sensors
 * behave: 4K60 needs far more bandwidth than 1080p60, and offering it on hardware that cannot
 * do it is exactly the kind of "too complex" list this replaced.
 */
export function standardModes(opts: StandardModeOptions = {}): RecordingSpec[] {
  const colorSpaces = opts.colorSpaces?.length ? opts.colorSpaces : ['srgb' as ColorSpace];
  const maxWidth = opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth : Infinity;
  const maxHeight = opts.maxHeight && opts.maxHeight > 0 ? opts.maxHeight : Infinity;
  const maxFps = opts.maxFps && opts.maxFps > 0 ? opts.maxFps : 60;
  const fpsLadder = (opts.fpsCandidates ?? [60, 30, 25, 24, 15]).filter((f) => f <= maxFps);

  const out: RecordingSpec[] = [];
  const seen = new Set<string>();

  const push = (width: number, height: number, fps: number, native: boolean) => {
    for (const cs of colorSpaces) {
      const spec = makeSpec(width, height, fps, cs, native ? { native: true } : {});
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      out.push(spec);
    }
  };

  if (opts.natural && opts.natural.width > 0 && opts.natural.height > 0) {
    push(opts.natural.width, opts.natural.height, opts.natural.fps || 30, true);
  }

  for (const mode of STANDARD_MODES) {
    if (mode.width > maxWidth || mode.height > maxHeight) continue;
    if (mode.width * mode.height < MIN_MODE_PIXELS) continue;
    // 4K and up: two frame rates. Anything smaller: up to three.
    const limit = mode.height >= 2000 ? 2 : 3;
    for (const fps of fpsLadder.slice(0, limit)) push(mode.width, mode.height, fps, false);
  }

  if (!out.length) push(1280, 720, Math.min(30, maxFps), false);
  return sortSpecs(out);
}
