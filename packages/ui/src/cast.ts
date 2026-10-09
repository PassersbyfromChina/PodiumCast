/**
 * PodiumCast Cast — the camera-owning app.
 *
 * Layout rules from 要求.txt (二：应用ui), implemented verbatim:
 *
 *   "1、若录制比例并非完全匹配手机屏幕，帧率和分辨率、操控按键、设置按钮放在预览外的黑边
 *      （根据黑边大小决定按键显示行数），并且用户自己决定预览界面和按键的左右关系
 *      （预览比例过宽）或上下关系（预览比例过长）。
 *    2、若完全匹配，按键等悬浮在预览画面上。（以上功能都基于横屏）"
 *
 * `applyLayout()` is the whole of that rule: it measures the letterbox the chosen recording
 * spec leaves on screen, puts the controls in the band when there is one, floats them over the
 * picture when there is not, derives the number of control rows/columns from the band
 * thickness, and honours the user's 左右/上下 preference from Settings.
 */
import {
  CastSession,
  DEFAULT_CAST_PORT,
  aspectLabel,
  computeLetterbox,
  fitAxis,
  formatBytes,
  formatDuration,
  matchSpec,
  mediaFileName,
  pickVideoMime,
  type DisplaySpec,
  type MediaFile,
  type RecordingSpec,
  type StorageTarget,
} from '@podiumcast/core';
import { CameraController, type CameraDevice } from './camera';
import { clear, h, icon, iconButton } from './dom';
import { LibraryPanel, Panel, Toaster, connectionChip } from './panels';
import { Player } from './playback';
import { HostMediaStore, IpcCastBridge } from './platform/bridges';
import { CapacitorHostChannel } from './platform/capacitor-channel';
import { ElectronHostChannel, hasElectronHost } from './platform/electron-channel';
import { WebHostChannel, type HostChannel, type HostInfo } from './platform/host';
import './styles.css';

type LayoutMode = 'auto' | 'split-h' | 'split-v' | 'overlay';

/**
 * What `auto` resolved to for the current spec and window size.
 *
 * Kept separate from `settings.layout` on purpose: `auto` is a standing instruction ("work it
 * out from the letterbox"), not a one-shot guess. Overwriting the stored preference with the
 * resolved value would silently turn the app into "always split-v" the first time the window
 * happened to be taller than the capture.
 */
let resolvedLayout: Exclude<LayoutMode, 'auto'> = 'overlay';

interface Settings {
  layout: LayoutMode;
  previewWidth: number;
  previewFps: number;
  previewQuality: number;
  storageTarget: StorageTarget;
  videoBitrate: number;
}

const SETTINGS_KEY = 'podiumcast.cast.settings';

/**
 * `?forceTestPattern=1` (set by the Electron shell when PODIUMCAST_FORCE_TEST_PATTERN=1)
 * makes the Cast ignore the hardware camera and render the synthetic pattern. Verification
 * and demos need a deterministic picture; a real webcam in a dark room is neither.
 */
const FORCE_TEST_PATTERN = new URLSearchParams(location.search).has('forceTestPattern');

function loadSettings(): Settings {
  const defaults: Settings = {
    layout: 'auto',
    previewWidth: 1280,
    previewFps: 20,
    previewQuality: 0.6,
    storageTarget: 'cast',
    videoBitrate: 12_000_000,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) } : defaults;
  } catch { return defaults }
}

function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* private mode */ }
}

function pickHost(): HostChannel {
  if (hasElectronHost()) return new ElectronHostChannel(window.podiumcast!);
  const cap = (globalThis as { Capacitor?: { Plugins?: Record<string, never> } }).Capacitor;
  if (cap?.Plugins?.PodiumCastLan) return new CapacitorHostChannel(cap.Plugins as never);
  return new WebHostChannel();
}

async function startCast(): Promise<void> {
  const host = pickHost();
  const info: HostInfo = await host.info();
  const settings = loadSettings();

  const root = document.getElementById('app') ?? h('div', { id: 'app' });
  root.className = 'cast';
  root.dataset.layout = 'overlay';
  document.body.appendChild(root);

  const store = new HostMediaStore(host, 'podiumcast://media');
  const bridge = new IpcCastBridge(host);
  const session = new CastSession({
    bridge,
    store,
    identity: {
      id: info.deviceId || `cast-${Math.random().toString(36).slice(2, 8)}`,
      name: info.deviceName || '拍摄端',
      role: 'cast',
      platform: info.platform,
      arch: info.arch,
      appVersion: info.appVersion,
    },
    state: { storageTarget: settings.storageTarget },
  });

  const camera = new CameraController();
  const toaster = new Toaster();
  const conn = connectionChip();

  // ---------------------------------------------------------------- DOM

  const video = h('video', { class: 'preview', playsinline: true, autoplay: true, muted: true }) as HTMLVideoElement;
  const stageArea = h('div', { class: 'stage-area' }, video);
  const bar = h('aside', { class: 'bar', 'aria-label': '拍摄控制' });
  const floatLayer = h('div', { class: 'float-layer', hidden: true });
  const prog = h('div', { class: 'progress', hidden: true }, h('i'));
  stageArea.appendChild(floatLayer);
  root.append(stageArea, bar, toaster.el, prog);

  // ================================================================ READOUT

  const specLine = h('span', { class: 'line', text: '正在枚举录制规格…' });
  const specSubLine = h('span', { class: 'line', text: '' });
  const readout = h('div', { class: 'readout' }, specLine, specSubLine);

  const recBadge = h('span', { class: 'rec-badge', hidden: true },
    h('span', { class: 'dot' }), h('span', { class: 'mono', text: '00:00' }));
  const recTime = recBadge.lastElementChild as HTMLElement;
  const peerChip = h('span', { class: 'chip' }, h('span', { class: 'dot' }), h('span', { text: '0 台大屏' }));

  // ================================================================ CONTROLS

  const shutterBtn = h('button', { class: 'btn', type: 'button' }, icon('photo'), h('span', { text: '拍照' }));
  const recordBtn = h('button', { class: 'btn accent', type: 'button' }, icon('record'), h('span', { text: '录像' }));
  const libBtn = iconButton('library', '回放', { onclick: () => openLibrary() });
  const setBtn = iconButton('settings', '设置', { onclick: () => settingsPanel.toggle() });
  const zoomLabel = h('span', { class: 'val mono', text: '1.0×' });
  const zoom = h('input', {
    type: 'range', min: '1', max: '6', step: '0.1', value: '1', 'aria-label': '变焦',
    on: { input: () => { void camera.setZoom(Number(zoom.value)) } },
  }) as HTMLInputElement;
  const zoomRail = h('div', { class: 'zoom-rail' },
    iconButton('zoomOut', '缩小', { cls: 'ghost icon', onclick: () => { void camera.setZoom(camera.getZoom().value / 1.4) } }),
    zoom, zoomLabel,
    iconButton('zoomIn', '放大', { cls: 'ghost icon', onclick: () => { void camera.setZoom(camera.getZoom().value * 1.4) } }),
  );

  const toolbar = h('div', { class: 'bar-row' }, shutterBtn, recordBtn, libBtn, setBtn);

  /**
   * Rebuilds the control surface for the current layout.
   *
   * 要求.txt 二-2: a perfect aspect match floats the controls over the picture; otherwise they
   * live in the black band so nothing covers the frame.
   */
  function rebuildBars(): void {
    clear(bar);
    clear(floatLayer);
    if (resolvedLayout === 'overlay') {
      bar.hidden = true;
      floatLayer.hidden = false;
      root.dataset.layout = 'overlay';
      floatLayer.append(
        h('div', { class: 'float-top' }, readout, recBadge, h('div', { class: 'spacer' }), peerChip),
        h('div', { class: 'float-bottom' }, zoomRail, toolbar),
      );
      return;
    }
    bar.hidden = false;
    floatLayer.hidden = true;
    bar.append(readout, recBadge, peerChip, zoomRail, toolbar);
  }

  // ================================================================ LAYOUT

  let currentSpec: RecordingSpec | null = null;

  /**
   * Turns the recording aspect plus the screen it is shown on into a concrete layout.
   *
   * `--bar-minor` is the band thickness in CSS pixels and `--bar-slots` is how many control
   * rows/columns fit inside it — that number is exactly "根据黑边大小决定按键显示行数".
   */
  function applyLayout(): void {
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const box = computeLetterbox(currentSpec, screenW, screenH, 56);
    const screenRatio = screenW / screenH;
    const exact = currentSpec
      ? Math.abs(currentSpec.ratio - screenRatio) / Math.max(currentSpec.ratio, screenRatio) <= 0.005
      : true;
    const naturalAxis = fitAxis(currentSpec, screenW, screenH);

    const preference: LayoutMode = settings.layout;
    resolvedLayout = preference === 'auto'
      ? (exact ? 'overlay' : (naturalAxis === 'width' ? 'split-h' : 'split-v'))
      : preference;
    const mode = resolvedLayout;

    // The band can only host the controls if it is actually wide enough; otherwise we reserve
    // space and shrink the preview, which is what "用户自己决定左右/上下关系" implies.
    const MIN_BAND = 156;
    if (mode === 'split-h') {
      const band = Math.max(box.bandLeft, box.bandRight, MIN_BAND);
      const size = Math.round(Math.min(band, screenW * 0.34));
      root.dataset.layout = 'split-h';
      if (naturalAxis === 'width') delete root.dataset.side;
      else root.dataset.side = 'right';
      root.style.setProperty('--bar-minor', `${size}px`);
      root.style.setProperty('--bar-slots', String(Math.max(1, Math.floor(size / 56))));
    } else if (mode === 'split-v') {
      const band = Math.max(box.bandTop, box.bandBottom, MIN_BAND);
      const size = Math.round(Math.min(band, screenH * 0.34));
      root.dataset.layout = 'split-v';
      if (naturalAxis === 'height') delete root.dataset.side;
      else root.dataset.side = 'bottom';
      root.style.setProperty('--bar-minor', `${size}px`);
      root.style.setProperty('--bar-slots', String(Math.max(1, Math.floor(size / 56))));
    } else {
      root.dataset.layout = 'overlay';
    }

    rebuildBars();
    // Keep the preview honest: show the real digital-zoom crop.
    video.style.transform = `scale(${camera.getZoom().hardware ? 1 : camera.getZoom().value})`;
  }

  // ================================================================ PREVIEW PUSH

  const previewCanvas = document.createElement('canvas');
  const previewCtx = previewCanvas.getContext('2d', { alpha: false });
  let frameId = 0;
  let pushing = false;
  let pushed = 0;
  let fpsWindowStart = performance.now();
  let fpsWindowCount = 0;
  let measuredFps = 0;

  /**
   * Encodes one JPEG from the live frame and broadcasts it.
   *
   * Re-entrancy guarded: `toBlob` is asynchronous, so a slow encode must not let a second one
   * start and saturate the CPU the recorder also needs.
   */
  async function pushPreviewFrame(): Promise<void> {
    const spec = currentSpec;
    if (!spec || !previewCtx || pushing) return;
    pushing = true;
    try {
      const scale = Math.min(1, settings.previewWidth / Math.max(1, spec.width));
      const w = Math.max(2, Math.round(spec.width * scale));
      const h2 = Math.max(2, Math.round(spec.height * scale));
      if (previewCanvas.width !== w || previewCanvas.height !== h2) {
        previewCanvas.width = w;
        previewCanvas.height = h2;
      }
      camera.drawFrame(previewCtx, w, h2);
      const blob = await new Promise<Blob | null>((resolve) => previewCanvas.toBlob(resolve, 'image/jpeg', settings.previewQuality));
      if (blob && session.getPeers().length) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        session.pushPreviewFrame(bytes, ++frameId);
        pushed++;
        fpsWindowCount++;
        const now = performance.now();
        if (now - fpsWindowStart >= 1000) {
          measuredFps = Math.round((fpsWindowCount * 1000) / (now - fpsWindowStart));
          fpsWindowStart = now;
          fpsWindowCount = 0;
          session.patchState({ previewFps: measuredFps });
        }
      }
    } catch { /* a single failed encode must not stop the loop */ }
    finally { pushing = false }
  }

  // ================================================================ CAPTURE

  let recorder: MediaRecorder | null = null;
  let recordHandle: string | null = null;
  let recordStartedAt = 0;
  let recordTimer: ReturnType<typeof setInterval> | null = null;

  async function capturePhoto(): Promise<void> {
    try {
      const photo = await camera.capturePhoto(0.95);
      const name = mediaFileName('photo', 'image/jpeg');
      const handle = await store.beginWrite(name, 'photo', {
        mime: 'image/jpeg', width: photo.width, height: photo.height, createdAt: Date.now(),
      });
      await store.appendWrite(handle, new Uint8Array(await photo.blob.arrayBuffer()));
      const file = await store.endWrite(handle, 0);
      toaster.show(`已保存照片 ${file.name}`, 'info');
      await refreshLibrary();
      await maybePushToStage(file);
    } catch (err) {
      toaster.show(`拍照失败：${String(err)}`, 'error');
      session.notify('error', `拍照失败：${String(err)}`);
    }
  }

  async function startRecording(): Promise<void> {
    if (recorder) return;
    try {
      const mime = pickVideoMime();
      recorder = camera.createRecorder(mime, settings.videoBitrate);
      const spec = currentSpec;
      const name = mediaFileName('video', mime);
      recordHandle = await store.beginWrite(name, 'video', {
        mime, width: spec?.width ?? 1280, height: spec?.height ?? 720, createdAt: Date.now(),
      });
      const handle = recordHandle;
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (!ev.data || ev.data.size === 0 || !handle) return;
        void ev.data.arrayBuffer()
          .then((buf) => store.appendWrite(handle, new Uint8Array(buf)))
          .catch(() => undefined);
      };
      recorder.onerror = () => toaster.show('录制出错', 'error');
      recorder.onstop = () => { void finalizeRecording() };
      // 1 s timeslice: the store appends incrementally, so a crash costs at most one second.
      recorder.start(1000);
      recordStartedAt = Date.now();
      session.patchState({ recording: true, recordingMs: 0 });
      recBadge.hidden = false;
      recordTimer = setInterval(() => {
        const ms = Date.now() - recordStartedAt;
        recTime.textContent = formatDuration(ms);
        session.patchState({ recordingMs: ms });
      }, 500);
      setRecordButton(true);
    } catch (err) {
      toaster.show(`无法开始录制：${String(err)}`, 'error');
    }
  }

  async function finalizeRecording(): Promise<void> {
    const handle = recordHandle;
    const durationMs = Date.now() - recordStartedAt;
    recordHandle = null;
    recorder = null;
    if (recordTimer) { clearInterval(recordTimer); recordTimer = null }
    recBadge.hidden = true;
    setRecordButton(false);
    session.patchState({ recording: false, recordingMs: 0 });
    if (!handle) return;
    try {
      const file = await store.endWrite(handle, durationMs);
      toaster.show(`已保存视频 ${file.name}（${formatBytes(file.size)}）`, 'info');
      await refreshLibrary();
      await maybePushToStage(file);
    } catch (err) {
      toaster.show(`保存视频失败：${String(err)}`, 'error');
    }
  }

  function stopRecording(): void {
    if (!recorder) return;
    try { recorder.stop() } catch { /* already stopped */ }
  }

  function toggleRecording(): void {
    if (recorder) stopRecording();
    else void startRecording();
  }

  function setRecordButton(recording: boolean): void {
    clear(recordBtn);
    recordBtn.append(icon(recording ? 'stop' : 'record'), h('span', { text: recording ? '停止' : '录像' }));
    recordBtn.classList.toggle('accent', !recording);
  }

  /** 要求.txt: 视频可以存在大屏端，所以录制完成后主动推送。 */
  async function maybePushToStage(file: MediaFile): Promise<void> {
    if (settings.storageTarget === 'cast') return;
    if (!session.getPeers().length) return;
    await session.pushFile(file);
  }

  // ================================================================ LIBRARY / PLAYER

  const player = new Player({
    onClose: () => session.patchState({
      mode: 'live',
      playback: { fileId: null, playing: false, positionMs: 0, durationMs: 0, rate: 1, scale: 1 },
    }),
    onState: (s) => session.patchPlayback({
      playing: s.playing, positionMs: s.positionMs, durationMs: s.durationMs, rate: s.rate, scale: s.scale,
    }),
    resolveUrl: (file) => store.urlFor(file),
  });
  root.appendChild(player.el);

  const library = new LibraryPanel({
    localRole: 'cast',
    urlFor: (file) => store.urlFor(file),
    onPlay: (files, index) => {
      player.open(files, index, (f) => store.urlFor(f));
      session.patchState({ mode: 'playback' });
      session.patchPlayback({ fileId: files[index]?.id ?? null });
    },
    onDelete: (file) => {
      void (async () => {
        await store.remove(file.id);
        await refreshLibrary();
        toaster.show(`已删除 ${file.name}`, 'info');
      })();
    },
    onOpen: () => { void host.openMediaFolder() },
  });

  function openLibrary(): void {
    void refreshLibrary().then(() => library.panel.toggle());
  }

  async function refreshLibrary(): Promise<void> {
    const files = await store.list();
    library.setFiles(files);
    session.setLibrary(files);
    session.patchState({
      photoCount: files.filter((f) => f.kind === 'photo').length,
      videoCount: files.filter((f) => f.kind === 'video').length,
    });
  }

  // ================================================================ SETTINGS PANEL

  const settingsPanel = new Panel({ title: '拍摄端设置', width: 'wide', position: 'center' });
  const specList = h('div', { class: 'spec-list' });
  const cameraSelect = h('select', { class: 'input', on: { change: () => { void switchCamera(cameraSelect.value) } } });
  const storageSeg = h('div', { class: 'seg' });
  const layoutSeg = h('div', { class: 'seg wrap' });
  const infoKv = h('dl', { class: 'kv' });
  const addrBox = h('div', { class: 'hint mono' });
  const usbBtn = h('button', { class: 'btn sm', type: 'button' }, icon('usb'), h('span', { text: 'USB 桥接（adb reverse）' }));

  function segButton(label: string, active: boolean, onclick: () => void): HTMLButtonElement {
    return h('button', { type: 'button', text: label, 'aria-pressed': String(active), on: { click: onclick } });
  }

  function renderStorageSeg(): void {
    clear(storageSeg);
    const options: Array<[StorageTarget, string]> = [['cast', '仅拍摄端'], ['stage', '仅大屏端'], ['both', '两端都存']];
    for (const [value, label] of options) {
      storageSeg.appendChild(segButton(label, settings.storageTarget === value, () => {
        settings.storageTarget = value;
        saveSettings(settings);
        session.patchState({ storageTarget: value });
        renderStorageSeg();
      }));
    }
  }

  function renderLayoutSeg(): void {
    clear(layoutSeg);
    const options: Array<[LayoutMode, string]> = [
      ['auto', '自动'], ['split-h', '按键在左右'], ['split-v', '按键在上下'], ['overlay', '悬浮在画面上'],
    ];
    for (const [value, label] of options) {
      layoutSeg.appendChild(segButton(label, settings.layout === value, () => {
        settings.layout = value;
        saveSettings(settings);
        renderLayoutSeg();
        applyLayout();
      }));
    }
  }

  function renderSpecs(specs: RecordingSpec[]): void {
    clear(specList);
    if (!specs.length) { specList.appendChild(h('div', { class: 'empty', text: '未读取到录制规格' })); return }
    for (const spec of specs) {
      specList.appendChild(h('button', {
        class: 'spec-item', type: 'button',
        'aria-pressed': String(spec.id === currentSpec?.id),
        on: { click: () => { void applySpec(spec.id) } },
      },
        h('span', { class: 'tick' }, icon('link', 'ico sm')),
        h('span', { class: 'spec-main' },
          h('span', { class: 'spec-label', text: spec.label }),
          h('span', { class: 'spec-sub', text: `${spec.id}${spec.native ? ' · 原生' : ''}` }),
        ),
      ));
    }
  }

  function renderCameras(devices: CameraDevice[]): void {
    clear(cameraSelect);
    if (!devices.length) cameraSelect.appendChild(h('option', { value: '', text: '未检测到摄像头（使用测试画面）' }));
    for (const d of devices) cameraSelect.appendChild(h('option', { value: d.deviceId, text: d.label }));
    if (camera.activeDevice) cameraSelect.value = camera.activeDevice;
  }

  function renderInfo(): void {
    clear(infoKv);
    const pairs: Array<[string, string]> = [
      ['应用', `PodiumCast-Cast ${info.appVersion}`],
      ['平台', `${info.platform} · ${info.arch}`],
      ['设备名', info.deviceName],
      ['监听端口', String(session.getPort() || DEFAULT_CAST_PORT)],
      ['存储位置', info.mediaLocation],
      ['已连大屏', `${session.getPeers().length} 台`],
      ['预览帧率', `${measuredFps || 0} fps（已发送 ${pushed} 帧）`],
    ];
    for (const [k, v] of pairs) infoKv.append(h('dt', { text: k }), h('dd', { text: v }));
  }

  async function refreshAddresses(): Promise<void> {
    try {
      const r = await host.serverStart(session.getPort() || DEFAULT_CAST_PORT);
      addrBox.textContent = r.addresses.length
        ? `大屏端可连接：${r.addresses.map((a) => `ws://${a}:${r.port}`).join('   ')}`
        : `大屏端可连接：ws://<本机IP>:${r.port}`;
    } catch {
      addrBox.textContent = '无法读取本机地址';
    }
  }

  usbBtn.addEventListener('click', () => {
    void (async () => {
      usbBtn.disabled = true;
      const r = await host.usbBridge(session.getPort() || DEFAULT_CAST_PORT)
        .catch((e: unknown) => ({ ok: false, message: String(e) }));
      usbBtn.disabled = false;
      toaster.show(r.message, r.ok ? 'info' : 'warn');
    })();
  });

  const previewControls = h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' });
  const widthSel = h('select', {
    class: 'input', 'aria-label': '预览宽度',
    on: { change: () => { settings.previewWidth = Number(widthSel.value); saveSettings(settings) } },
  }, ...[640, 960, 1280, 1920].map((w) => h('option', { value: String(w), text: `${w}px 宽`, selected: settings.previewWidth === w })));
  const fpsSel = h('select', {
    class: 'input', 'aria-label': '预览帧率',
    on: { change: () => { settings.previewFps = Number(fpsSel.value); saveSettings(settings); restartPreview() } },
  }, ...[10, 15, 20, 25, 30].map((f) => h('option', { value: String(f), text: `${f} fps`, selected: settings.previewFps === f })));
  const qualitySel = h('select', {
    class: 'input', 'aria-label': '预览画质',
    on: { change: () => { settings.previewQuality = Number(qualitySel.value); saveSettings(settings) } },
  }, ...[['0.4', '低画质'], ['0.6', '标准'], ['0.75', '高画质'], ['0.9', '最高']].map(([v, t]) =>
    h('option', { value: v, text: t, selected: String(settings.previewQuality) === v })));
  previewControls.append(widthSel, fpsSel, qualitySel);

  settingsPanel.body.append(
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '录制规格（分辨率 · 帧率 · 比例 · 色域）' }),
      specList,
      h('div', { class: 'hint', text: '大屏端首次连接时会自动选择与大屏比例相同或最接近的规格。' }),
    ),
    h('div', { class: 'field' }, h('span', { class: 'label', text: '摄像头' }), cameraSelect),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '录制文件保存位置' }),
      storageSeg,
      h('div', { class: 'hint', text: '默认保存在拍摄端；选择大屏端后，每次拍摄完会自动推送到已连接的大屏端。' }),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '界面布局（预览与按键的关系）' }),
      layoutSeg,
      h('div', { class: 'hint', text: '录制比例与屏幕不一致时，按键放在黑边中；行数/列数由黑边宽度自动决定。' }),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '预览推流' }),
      previewControls,
      h('div', { class: 'hint', text: '分辨率与帧率越高，局域网带宽占用越大；手机对手机建议 960px / 15fps。' }),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '连接信息' }),
      infoKv,
      addrBox,
      h('div', { style: 'margin-top:8px' }, usbBtn),
      h('div', { class: 'hint', text: 'USB 桥接需要电脑已安装 adb 并用数据线连接大屏设备，随后在拍摄端点击上面的按钮。' }),
    ),
  );
  settingsPanel.setFooter(
    h('button', { class: 'btn sm', type: 'button', text: '打开存储目录', on: { click: () => { void host.openMediaFolder() } } }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', type: 'button', text: '刷新', on: { click: () => { void refreshAll() } } }),
  );
  root.appendChild(settingsPanel.el);
  root.appendChild(library.panel.el);

  // ================================================================ ACTIONS

  async function switchCamera(deviceId: string): Promise<void> {
    const specs = await camera.open(deviceId);
    currentSpec = specs.find((s) => s.native) ?? specs[0] ?? null;
    session.setSpecs(specs, currentSpec?.id);
    renderSpecs(specs);
    renderCameras(await camera.listDevices());
    updateSpecLine();
    applyLayout();
  }

  async function applySpec(id: string): Promise<void> {
    const specs = session.getSpecs();
    const spec = specs.find((s) => s.id === id);
    if (!spec) return;
    const achieved = await camera.applySpec(spec);
    // Re-apply the id we asked for so the settings list and the peer see the user's choice
    // even when the camera rounded the resolution.
    const effective: RecordingSpec = { ...achieved, id: spec.id, label: spec.label };
    currentSpec = effective;
    session.setCurrentSpec(effective, session.getMatchNote());
    renderSpecs(specs);
    updateSpecLine();
    applyLayout();
  }

  function updateSpecLine(): void {
    const spec = currentSpec;
    if (!spec) { specLine.textContent = '未选择录制规格'; specSubLine.textContent = ''; return }
    const screenRatio = window.innerWidth / window.innerHeight;
    const exact = Math.abs(spec.ratio - screenRatio) / Math.max(spec.ratio, screenRatio) <= 0.005;
    specLine.textContent = `${spec.width}×${spec.height} · ${spec.fps}fps · ${spec.aspect}`;
    const note = session.getMatchNote();
    specSubLine.textContent = [
      spec.colorSpace.toUpperCase(),
      exact ? '满屏' : `面外黑边（${aspectLabel(spec.width, spec.height)} vs 屏幕 ${aspectLabel(window.innerWidth, window.innerHeight)}）`,
      note,
    ].filter(Boolean).join(' · ');
  }

  // ================================================================ SESSION INTENTS

  session.events.on('state', (state) => {
    peerChip.lastElementChild!.textContent = `${session.getPeers().length} 台大屏`;
    peerChip.className = `chip ${session.getPeers().length ? 'ok' : ''}`.trim();
    const z = camera.getZoom();
    if (Math.abs(Number(zoom.value) - z.value) > 0.01) zoom.value = String(z.value);
    zoomLabel.textContent = `${z.value.toFixed(1)}×`;
    zoom.max = String(z.max);
    if (state.storageTarget !== settings.storageTarget) {
      settings.storageTarget = state.storageTarget;
      saveSettings(settings);
      renderStorageSeg();
    }
  });

  session.events.on('intent', ({ cmd, fromName }) => {
    void (async () => {
      switch (cmd.k) {
        case 'photo': await capturePhoto(); toaster.show(`远端（${fromName}）触发拍照`, 'info'); break;
        case 'record-start': if (!recorder) await startRecording(); break;
        case 'record-stop': stopRecording(); break;
        case 'zoom': await camera.setZoom(cmd.value); break;
        case 'zoom-step': await camera.setZoom(camera.getZoom().value + cmd.delta); break;
        case 'request-spec': await applySpec(cmd.id); break;
        case 'match-display': {
          const r = matchSpec(session.getSpecs(), await host.display());
          if (r.spec) await applySpec(r.spec.id);
          toaster.show(r.note, 'info');
          break;
        }
        case 'set-storage':
          settings.storageTarget = cmd.target;
          saveSettings(settings);
          session.patchState({ storageTarget: cmd.target });
          renderStorageSeg();
          break;
        case 'switch-camera': await switchCamera(cmd.deviceId ?? ''); break;
        case 'cycle-camera': {
          const list = await camera.listDevices();
          if (list.length > 1) {
            const idx = list.findIndex((d) => d.deviceId === camera.activeDevice);
            await switchCamera(list[(idx + 1) % list.length].deviceId);
          }
          break;
        }
        case 'library-request': await refreshLibrary(); break;
        case 'delete-file': await store.remove(cmd.id); await refreshLibrary(); break;
        case 'playback-open': {
          const files = library.list;
          const idx = files.findIndex((f) => f.id === cmd.id);
          if (idx >= 0) {
            player.open(files, idx, (f) => store.urlFor(f));
            session.patchState({ mode: 'playback' });
            session.patchPlayback({ fileId: cmd.id });
          }
          break;
        }
        case 'playback-close': player.close(); break;
        case 'playback-toggle': player.toggle(); break;
        case 'playback-seek': player.seekMs(cmd.positionMs); break;
        case 'playback-rate': player.setRate(cmd.rate); break;
        case 'playback-zoom': player.setScale(cmd.scale); break;
        default: break;
      }
    })();
  });

  session.events.on('notice', ({ level, message }) => toaster.show(message, level));
  session.events.on('received', (file) => { toaster.show(`已收到大屏端文件 ${file.name}`, 'info'); void refreshLibrary() });
  session.events.on('transfer', (p) => {
    if ('sentBytes' in p) {
      prog.hidden = false;
      const pct = p.totalBytes ? Math.round((p.sentBytes / p.totalBytes) * 100) : 0;
      prog.firstElementChild!.setAttribute('style', `width:${pct}%`);
      if (p.done) setTimeout(() => { prog.hidden = true }, 900);
    }
  });

  camera.events.on('error', ({ message }) => toaster.show(message, 'warn'));
  camera.events.on('lost', () => {
    toaster.show('摄像头已断开，切换测试画面', 'warn');
    void switchCamera('');
  });
  camera.events.on('zoom', (z) => {
    zoomLabel.textContent = `${z.value.toFixed(1)}×`;
    zoom.value = String(z.value);
    zoom.max = String(z.max);
    session.patchState({ zoom: z.value, maxZoom: z.max });
    video.style.transform = `scale(${z.hardware ? 1 : z.value})`;
  });
  camera.events.on('devices', (devices) => renderCameras(devices));

  shutterBtn.addEventListener('click', () => { void capturePhoto() });
  recordBtn.addEventListener('click', () => { toggleRecording() });

  window.addEventListener('keydown', (ev) => {
    if (player.isOpen) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (ev.key === 'p' || ev.key === 'P') { ev.preventDefault(); void capturePhoto() }
    if (ev.key === 'r' || ev.key === 'R') { ev.preventDefault(); toggleRecording() }
    if (ev.key === 'l' || ev.key === 'L') { ev.preventDefault(); openLibrary() }
    if (ev.key === 's' || ev.key === 'S') { ev.preventDefault(); settingsPanel.toggle() }
    if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); void host.setFullscreen(!document.fullscreenElement) }
  });

  window.addEventListener('resize', () => { applyLayout(); updateSpecLine() });
  window.addEventListener('beforeunload', () => { void session.stop() });

  // ================================================================ BOOT

  let previewTimer: ReturnType<typeof setInterval> | null = null;
  function restartPreview(): void {
    if (previewTimer) clearInterval(previewTimer);
    previewTimer = setInterval(
      () => { void pushPreviewFrame() },
      Math.max(33, Math.round(1000 / settings.previewFps)),
    );
  }

  async function refreshAll(): Promise<void> {
    await refreshLibrary();
    renderInfo();
    await refreshAddresses();
  }

  async function boot(): Promise<void> {
    renderStorageSeg();
    renderLayoutSeg();
    rebuildBars();

    await session.start(DEFAULT_CAST_PORT).catch((err: unknown) => {
      toaster.show(`监听失败：${String(err)}`, 'error');
      return DEFAULT_CAST_PORT;
    });
    void session.startBeacon();

    const devices = await camera.refreshDevices(true);
    renderCameras(devices);
    const specs = await camera.open(devices[0]?.deviceId, undefined, { forceSynthetic: FORCE_TEST_PATTERN });
    currentSpec = specs.find((s) => s.native) ?? specs[0] ?? null;
    camera.attachVideo(video);
    session.setSpecs(specs, currentSpec?.id);
    session.announcePreview({
      width: settings.previewWidth,
      height: currentSpec ? Math.round(settings.previewWidth / currentSpec.ratio) : 720,
      fps: settings.previewFps,
      quality: settings.previewQuality,
      testPattern: camera.isSynthetic(),
    });
    renderSpecs(specs);
    updateSpecLine();
    applyLayout();
    restartPreview();
    await refreshAll();

    // 要求.txt (一): pick the recording aspect that matches this screen.
    const display: DisplaySpec = await host.display();
    const r = matchSpec(specs, display);
    if (r.spec) await applySpec(r.spec.id);
    session.setCurrentSpec(currentSpec ?? r.spec, r.note);

    if (camera.isSynthetic()) {
      toaster.show(FORCE_TEST_PATTERN ? '演示模式：正在输出测试画面' : '未检测到摄像头，正在输出测试画面', 'warn');
    }
    toaster.show(`拍摄端就绪 · 监听 ${session.getPort()} 端口`, 'info');
  }

  // React to display changes (window moved to another monitor / resolution change).
  host.onEvent((e) => { if (e.event === 'display') { updateSpecLine(); applyLayout() } });

  conn.set('拍摄端', 'ok');
  await boot();
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * The bundle is a plain `<script src>` IIFE, so nothing calls `startCast()` for us.
 *
 * A failure here is reported *in the page* rather than only on the console: the window is
 * fullscreen on a podium, and a silent black screen is the least debuggable possible outcome.
 */
function reportFatal(err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error('[podiumcast] 启动失败', err);
  const box = document.createElement('div');
  box.setAttribute('style', [
    'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column', 'gap:12px',
    'align-items:center', 'justify-content:center', 'padding:32px', 'background:#000',
    'color:#f2f2f4', 'font:14px/1.6 -apple-system,Segoe UI,Noto Sans SC,sans-serif',
    'text-align:center', 'white-space:pre-wrap', 'z-index:9999',
  ].join(';'));
  const title = document.createElement('div');
  title.textContent = 'PodiumCast 启动失败';
  title.setAttribute('style', 'font-size:18px;font-weight:600;color:#ff453a');
  const detail = document.createElement('div');
  detail.textContent = message;
  detail.setAttribute('style', 'max-width:640px;color:#9a9aa2;font-family:ui-monospace,Consolas,monospace;font-size:12.5px');
  box.append(title, detail);
  document.body.appendChild(box);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void startCast().catch(reportFatal) }, { once: true });
} else {
  void startCast().catch(reportFatal);
}
