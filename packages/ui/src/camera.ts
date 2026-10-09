/**
 * Camera controller — the only place that touches `getUserMedia` / `MediaRecorder`.
 *
 * Three jobs, one per section of 要求.txt:
 *   启动配置 : enumerate devices and read the *available* recording specs out of
 *              `MediaTrackCapabilities` (resolution, frame rate, and a best-effort colour
 *              gamut guess), then apply a chosen spec.
 *   应用使用 : hold the live stream, take stills, record video, and zoom — including while a
 *              recording is running, which 要求.txt calls out explicitly.
 *   通用     : fall back to a synthetic test pattern when no camera exists, so the Stage
 *              handshake, the preview pipe and CI smoke tests all work headless.
 */
import { Emitter, buildSpecs, makeSpec, type ColorSpace, type RecordingSpec } from '@podiumcast/core';

export interface CameraDevice {
  deviceId: string;
  label: string;
  kind: 'camera' | 'test-pattern';
}

export interface CameraEvents {
  /** The device list changed (camera plugged in / unplugged). */
  devices: CameraDevice[];
  /** The active stream ended (camera removed, permission revoked). */
  lost: string;
  error: { message: string };
  /** Digital zoom changed; preview and still capture must re-crop. */
  zoom: { value: number; max: number; hardware: boolean };
}

export interface CapturedPhoto {
  blob: Blob;
  width: number;
  height: number;
}

/** Colour gamut guess: Chromium exposes no gamut capability, so we infer from the platform. */
function guessColorSpaces(): ColorSpace[] {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return ['srgb', 'rec709'];
  if (/Macintosh|Mac OS X/i.test(ua)) return ['p3', 'srgb', 'rec709'];
  return ['srgb', 'rec709'];
}

/** Digital zoom range used when the camera exposes no hardware `zoom` capability. */
export const DIGITAL_ZOOM_MAX = 6;

export class CameraController {
  readonly events = new Emitter<CameraEvents>();

  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private activeDeviceId = '';
  private devices: CameraDevice[] = [];
  private zoomValue = 1;
  private zoomMax = 1;
  private hardwareZoom = false;
  private currentSpec: RecordingSpec | null = null;
  private synthetic: { canvas: HTMLCanvasElement; raf: number; start: number } | null = null;

  getStream(): MediaStream | null { return this.stream }
  getTrack(): MediaStreamTrack | null { return this.track }
  getZoom(): { value: number; max: number; hardware: boolean } {
    return { value: this.zoomValue, max: this.zoomMax, hardware: this.hardwareZoom };
  }
  getSpec(): RecordingSpec | null { return this.currentSpec }
  isSynthetic(): boolean { return this.synthetic !== null }

  /** Lists real cameras; never includes the synthetic fallback. */
  async listDevices(): Promise<CameraDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `摄像头 ${i + 1}`, kind: 'camera' as const }));
  }

  /**
   * Enumerates devices including labels.
   *
   * Labels are only populated after permission has been granted at least once, so the first
   * call opens a throwaway stream. This is the standard Chromium dance and it is why the app
   * asks for the camera immediately at startup rather than on first shutter press.
   */
  async refreshDevices(prime = true): Promise<CameraDevice[]> {
    if (prime && !this.stream) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        probe.getTracks().forEach((t) => t.stop());
      } catch { /* denied or no camera: labels stay generic */ }
    }
    const real = await this.listDevices();
    this.devices = real;
    this.events.emit('devices', real);
    return real;
  }

  /**
   * Opens a camera (or the synthetic pattern) and reads out its recording specs.
   * Returns the spec list the settings panel and the Cast handshake advertise.
   *
   * `forceSynthetic` skips the hardware entirely. It exists for two reasons: the demo/testing
   * path (a build agent's webcam is either absent or staring at a dark room, and "is the
   * preview actually rendering?" has to be answerable), and the podium case where the operator
   * wants to verify the signal chain before the camera is connected.
   */
  async open(
    deviceId?: string,
    preferred?: { width: number; height: number; fps: number },
    options: { forceSynthetic?: boolean } = {},
  ): Promise<RecordingSpec[]> {
    this.close();
    if (options.forceSynthetic) return this.openSynthetic();

    const real = this.devices.length ? this.devices : await this.listDevices();
    const target = deviceId ?? real[0]?.deviceId;

    if (!target) return this.openSynthetic();

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: target ? { exact: target } : undefined,
        width: preferred ? { ideal: preferred.width } : { ideal: 1920 },
        height: preferred ? { ideal: preferred.height } : { ideal: 1080 },
        frameRate: preferred ? { ideal: preferred.fps } : { ideal: 30 },
      },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.adoptStream(stream, target);
      return this.readSpecs();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A missing/failing camera must not brick the app: 要求.txt needs the Stage link up
      // regardless, and the test pattern keeps the whole pipeline demonstrable.
      this.events.emit('error', { message: `打开摄像头失败（${message}），已切换到测试画面` });
      return this.openSynthetic();
    }
  }

  private adoptStream(stream: MediaStream, deviceId: string): void {
    this.stream = stream;
    this.activeDeviceId = deviceId;
    this.track = stream.getVideoTracks()[0] ?? null;
    if (this.track) {
      this.track.addEventListener('ended', () => this.events.emit('lost', '摄像头已断开'));
      const caps = (this.track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
      this.hardwareZoom = Boolean(caps.zoom && caps.zoom.max > caps.zoom.min);
      this.zoomMax = this.hardwareZoom ? caps.zoom!.max : DIGITAL_ZOOM_MAX;
      this.zoomValue = 1;
      if (this.hardwareZoom) {
        try { void this.track.applyConstraints({ advanced: [{ zoom: caps.zoom!.min } as MediaTrackConstraintSet] }) } catch { /* unsupported */ }
      }
    }
    this.events.emit('zoom', { value: this.zoomValue, max: this.zoomMax, hardware: this.hardwareZoom });
  }

  /** Headless mode: a moving test pattern standing in for the camera. */
  private openSynthetic(): RecordingSpec[] {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d')!;
    const start = performance.now();
    const draw = () => {
      const t = (performance.now() - start) / 1000;
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, w, h);
      // Colour bars: makes colour-space and aspect mismatches obvious at a glance.
      const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0', '#101010'];
      const bw = w / bars.length;
      for (let i = 0; i < bars.length; i++) { ctx.fillStyle = bars[i]; ctx.fillRect(i * bw, 0, bw + 1, h * 0.62) }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(w / 2 + Math.cos(t * 0.9) * w * 0.28, h / 2 + Math.sin(t * 1.3) * h * 0.18, Math.min(w, h) * 0.12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = `${Math.round(h * 0.06)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('PODIUMCAST TEST PATTERN', w / 2, h * 0.78);
      ctx.font = `${Math.round(h * 0.035)}px monospace`;
      ctx.fillText(`${w}×${h} · ${t.toFixed(1)}s · 未检测到摄像头`, w / 2, h * 0.88);
      ctx.textAlign = 'left';
      const raf = requestAnimationFrame(draw);
      if (this.synthetic) this.synthetic.raf = raf;
    };
    this.synthetic = { canvas, raf: 0, start };
    const stream = canvas.captureStream(30);
    this.synthetic.raf = requestAnimationFrame(draw);
    this.adoptStream(stream, 'synthetic');
    this.hardwareZoom = false;
    this.zoomMax = DIGITAL_ZOOM_MAX;
    return this.readSpecs();
  }

  /**
   * Reads the available recording specs from the active track.
   *
   * `getCapabilities()` reports width/height/frameRate as *independent* ranges, so the
   * cartesian product is meaningless — {@link buildSpecs} pairs every advertised resolution
   * with every advertised rate and drops implausible combinations.
   */
  readSpecs(): RecordingSpec[] {
    const track = this.track;
    const settings = (track?.getSettings?.() ?? {}) as MediaTrackSettings;
    const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
      width?: { min: number; max: number };
      height?: { min: number; max: number };
      frameRate?: { min: number; max: number };
    };
    const colorSpaces = guessColorSpaces();

    const naturalWidth = settings.width ?? 1280;
    const naturalHeight = settings.height ?? 720;
    const naturalFps = Math.round(settings.frameRate ?? 30);

    const widths = caps.width ? [caps.width.max] : [];
    const heights = caps.height ? [caps.height.max] : [];
    // Common ladder, always offered so the user has something to pick even on a fixed-mode
    // camera. Modes the hardware refuses are reported back by applySpec().
    const ladder: Array<[number, number]> = [
      [naturalWidth, naturalHeight], [3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [854, 480], [640, 360],
    ];
    for (const [w, h] of ladder) { widths.push(w); heights.push(h) }

    const rates: number[] = [];
    if (caps.frameRate) {
      for (const r of [60, 50, 30, 25, 24, 15]) if (r <= caps.frameRate.max) rates.push(r);
      rates.push(Math.round(caps.frameRate.max));
    }
    for (const r of [naturalFps, 60, 30, 15]) rates.push(r);

    const specs = buildSpecs(widths, heights, rates, colorSpaces);
    const native = makeSpec(naturalWidth, naturalHeight, naturalFps, colorSpaces[0], { native: true });
    const withNative = specs.some((s) => s.id === native.id) ? specs : [native, ...specs];
    // Cap the list: a 40-entry settings panel is not usable on a phone.
    const trimmed = withNative.slice(0, 28);
    this.currentSpec = trimmed.find((s) => s.native) ?? trimmed[0] ?? null;
    return trimmed;
  }

  /** Applies a recording spec. Returns the spec that was actually achieved. */
  async applySpec(spec: RecordingSpec): Promise<RecordingSpec> {
    // The synthetic source is a canvas: `applyConstraints` on a canvas-capture track makes
    // Chromium emit blank frames instead of scaling, so the canvas itself is resized. As a
    // bonus the test pattern then genuinely reflects the chosen spec, which makes the spec
    // picker demonstrable on a machine with no camera.
    if (this.synthetic) {
      const width = Math.max(160, Math.min(4096, Math.round(spec.width)));
      const height = Math.max(90, Math.min(2304, Math.round(spec.height)));
      if (this.synthetic.canvas.width !== width || this.synthetic.canvas.height !== height) {
        this.synthetic.canvas.width = width;
        this.synthetic.canvas.height = height;
      }
      this.currentSpec = { ...spec, width, height, ratio: width / height, aspect: spec.aspect };
      return this.currentSpec;
    }

    const track = this.track;
    if (!track) return spec;
    try {
      await track.applyConstraints({
        width: { ideal: spec.width },
        height: { ideal: spec.height },
        frameRate: { ideal: spec.fps },
      });
    } catch { /* the camera refused; we fall through and report what we got */ }
    const settings = (track.getSettings?.() ?? {}) as MediaTrackSettings;
    const achieved = makeSpec(
      settings.width ?? spec.width,
      settings.height ?? spec.height,
      Math.round(settings.frameRate ?? spec.fps),
      spec.colorSpace,
      { id: spec.id, label: spec.label, native: spec.native, zoomable: spec.zoomable, maxZoom: spec.maxZoom },
    );
    this.currentSpec = achieved;
    return achieved;
  }

  /**
   * Sets zoom. Uses the hardware control when the camera has one, otherwise falls back to a
   * digital crop that is applied identically to the preview and to still capture, so WYSIWYG
   * holds in both cases.
   */
  async setZoom(value: number): Promise<{ value: number; max: number; hardware: boolean }> {
    const clamped = Math.max(1, Math.min(this.zoomMax, value));
    if (this.hardwareZoom && this.track) {
      const caps = (this.track.getCapabilities?.() ?? {}) as { zoom?: { min: number; max: number } };
      const min = caps.zoom?.min ?? 1;
      const max = caps.zoom?.max ?? 1;
      const target = min + (max - min) * ((clamped - 1) / Math.max(0.0001, this.zoomMax - 1));
      try { await this.track.applyConstraints({ advanced: [{ zoom: target } as MediaTrackConstraintSet] }) } catch { /* ignore */ }
    }
    this.zoomValue = clamped;
    const state = { value: this.zoomValue, max: this.zoomMax, hardware: this.hardwareZoom };
    this.events.emit('zoom', state);
    return state;
  }

  /** Source rectangle implementing the digital crop for the current zoom. */
  cropRect(width: number, height: number): { sx: number; sy: number; sw: number; sh: number } {
    const z = this.hardwareZoom ? 1 : this.zoomValue;
    const sw = width / z;
    const sh = height / z;
    return { sx: (width - sw) / 2, sy: (height - sh) / 2, sw, sh };
  }

  /** Grabs a still at the current spec, including the digital crop. */
  async capturePhoto(quality = 0.95): Promise<CapturedPhoto> {
    const spec = this.currentSpec;
    const width = spec?.width ?? 1920;
    const height = spec?.height ?? 1080;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    this.drawFrame(ctx, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('生成照片失败');
    return { blob, width, height };
  }

  /** Draws the current video frame (cropped for digital zoom) into a 2D context. */
  drawFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const source = this.videoSource();
    if (!source) return;
    const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!srcW || !srcH) return;
    const { sx, sy, sw, sh } = this.cropRect(srcW, srcH);
    ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, width, height);
  }

  private videoSource(): HTMLVideoElement | HTMLCanvasElement | null {
    return this.synthetic?.canvas ?? this.attachedVideo;
  }

  private attachedVideo: HTMLVideoElement | null = null;

  /** Binds the `<video>` element that renders the preview; needed for still capture. */
  attachVideo(video: HTMLVideoElement): void {
    this.attachedVideo = video;
    if (this.stream && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      void video.play().catch(() => undefined);
    }
  }

  /** Creates a `MediaRecorder` for the live stream. The caller owns the data handler. */
  createRecorder(mimeType: string, bitsPerSecond = 12_000_000): MediaRecorder {
    if (!this.stream) throw new Error('尚未打开摄像头');
    const options: MediaRecorderOptions = { mimeType };
    if (!mimeType.includes('png')) options.videoBitsPerSecond = bitsPerSecond;
    try {
      return new MediaRecorder(this.stream, options);
    } catch {
      return new MediaRecorder(this.stream);
    }
  }

  close(): void {
    if (this.synthetic) {
      cancelAnimationFrame(this.synthetic.raf);
      this.synthetic.canvas.width = 0;
      this.synthetic = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    if (this.attachedVideo) this.attachedVideo.srcObject = null;
    this.currentSpec = null;
    this.hardwareZoom = false;
    this.zoomValue = 1;
    this.zoomMax = 1;
  }

  get activeDevice(): string { return this.activeDeviceId }
}
