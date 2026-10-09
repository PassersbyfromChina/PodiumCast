/**
 * PodiumCast Stage — the big-screen app.
 *
 * 要求.txt (二/2): "把所有操控按键隐藏为一个小图标在左和右下角，需要时打开。
 * 部分 ui 和 PodiumCast-Cast 应用保持一致。"
 *
 * So the Stage shows nothing but the live picture until the user taps one of the two corner
 * icons: the left drawer carries the capture controls (拍摄 / 变焦 / 回放) and the right
 * drawer carries connection, format, storage and library. Both use the same control widgets,
 * colours and type scale as the Cast app.
 *
 * 要求.txt (一): it reads the display it is presenting on at startup and hands that to the
 * Cast during the handshake, which is what lets the Cast match the recording aspect.
 */
import {
  DEFAULT_CAST_PORT,
  StageSession,
  defaultState,
  formatDuration,
  type DeviceInfo,
  type DisplaySpec,
  type MediaFile,
  type RecordingSpec,
  type SessionState,
  type StorageTarget,
} from '@podiumcast/core';
import { clamp, clear, debounce, h, icon, iconButton } from './dom';
import { LibraryPanel, Panel, Toaster } from './panels';
import { Player } from './playback';
import { BrowserStageBridge, HostMediaStore, normalizeAddress } from './platform/bridges';
import { CapacitorHostChannel } from './platform/capacitor-channel';
import { ElectronHostChannel, hasElectronHost } from './platform/electron-channel';
import { WebHostChannel, type HostChannel, type HostInfo } from './platform/host';
import './styles.css';

function pickHost(): HostChannel {
  if (hasElectronHost()) return new ElectronHostChannel(window.podiumcast!);
  const cap = (globalThis as { Capacitor?: { Plugins?: Record<string, never> } }).Capacitor;
  if (cap?.Plugins?.PodiumCastLan) return new CapacitorHostChannel(cap.Plugins as never);
  return new WebHostChannel();
}

function aspectOfDisplay(): DisplaySpec {
  const w = window.screen?.width ?? window.innerWidth;
  const hgt = window.screen?.height ?? window.innerHeight;
  const ratio = w / Math.max(1, hgt);
  return {
    width: w,
    height: hgt,
    aspect: '',
    ratio,
    fps: 60,
    colorSpace: /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'p3' : 'srgb',
    fullscreen: Boolean(document.fullscreenElement),
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

export async function startStage(): Promise<void> {
  const host = pickHost();
  const info: HostInfo = await host.info();

  const root = document.getElementById('app') ?? h('div', { id: 'app' });
  root.className = 'stage';
  document.body.appendChild(root);

  const store = new HostMediaStore(host, 'podiumcast://media');
  const bridge = new BrowserStageBridge(host);

  let display: DisplaySpec = await host.display().catch(() => aspectOfDisplay());

  const identity: DeviceInfo = {
    id: info.deviceId || `stage-${Math.random().toString(36).slice(2, 8)}`,
    name: info.deviceName || '大屏端',
    role: 'stage',
    platform: info.platform,
    arch: info.arch,
    appVersion: info.appVersion,
  };

  const session = new StageSession({ bridge, store, identity, display: () => display });
  const toaster = new Toaster();

  // ================================================================ DOM

  const canvas = h('canvas', { class: 'preview' }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d', { alpha: false });
  const placeholder = h('div', {
    class: 'empty',
    style: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(520px,84vw);text-align:center',
    text: '尚未连接拍摄端。点击左下角图标选择设备。',
  });
  const stageArea = h('div', { class: 'stage-area' }, canvas, placeholder);
  const prog = h('div', { class: 'progress', hidden: true }, h('i'));
  root.append(stageArea, toaster.el, prog);

  // ------------------------------------------------------------------ corner drawers

  const recBadge = h('span', { class: 'rec-badge', hidden: true }, h('span', { class: 'dot' }), h('span', { class: 'mono', text: '00:00' }));
  const recTime = recBadge.lastElementChild as HTMLElement;
  const stateChip = h('span', { class: 'chip', hidden: true });

  // Left drawer — capture controls (requirements.txt 二/2).
  const shutterBtn = h('button', { class: 'btn', type: 'button' }, icon('photo'), h('span', { text: '拍照' }));
  const recordBtn = h('button', { class: 'btn accent', type: 'button' }, icon('record'), h('span', { text: '录像' }));
  const playBtn = iconButton('library', '回放', { onclick: () => { void openLibrary() } });
  const zoomLabel = h('span', { class: 'val mono', text: '1.0×' });
  const zoom = h('input', {
    type: 'range', min: '1', max: '6', step: '0.1', value: '1', 'aria-label': '变焦',
    on: { input: () => sendZoom(Number(zoom.value)) },
  }) as HTMLInputElement;
  const leftDrawer = h('div', { class: 'drawer', hidden: true },
    h('span', { class: 'drawer-title', text: '操控' }),
    shutterBtn, recordBtn, playBtn,
    h('div', { class: 'zoom-rail' },
      iconButton('zoomOut', '缩小', { cls: 'ghost icon', onclick: () => sendZoom(currentZoom() / 1.4) }),
      zoom, zoomLabel,
      iconButton('zoomIn', '放大', { cls: 'ghost icon', onclick: () => sendZoom(currentZoom() * 1.4) }),
    ),
  );

  const specLabel = h('span', { class: 'mono dim', text: '—' });
  const hostLabel = h('span', { class: 'dim', text: '未连接' });
  const storageSeg = h('div', { class: 'seg' });
  const rightDrawer = h('div', { class: 'drawer', hidden: true },
    h('span', { class: 'drawer-title', text: '连接与格式' }),
    h('div', { class: 'readout' },
      h('span', { class: 'line', text: '拍摄端' }), hostLabel,
      h('span', { class: 'line', text: '录制规格' }), specLabel,
    ),
    h('div', { class: 'seg' }, storageSeg),
    iconButton('link', '连接设备', { cls: 'icon', onclick: () => connectionPanel.toggle() }),
    iconButton('settings', '设置', { cls: 'icon', onclick: () => settingsPanel.toggle() }),
    iconButton('fullscreen', '全屏', { cls: 'icon', onclick: () => { void host.setFullscreen(!document.fullscreenElement) } }),
  );

  const leftToggle = h('button', {
    class: 'corner-toggle', type: 'button', 'aria-expanded': 'false', 'aria-label': '操控面板', title: '操控面板',
    on: { click: () => { leftDrawer.hidden = !leftDrawer.hidden; leftToggle.setAttribute('aria-expanded', String(!leftDrawer.hidden)) } },
  }, icon('camera'));
  const rightToggle = h('button', {
    class: 'corner-toggle', type: 'button', 'aria-expanded': 'false', 'aria-label': '连接与设置', title: '连接与设置',
    on: { click: () => { rightDrawer.hidden = !rightDrawer.hidden; rightToggle.setAttribute('aria-expanded', String(!rightDrawer.hidden)) } },
  }, icon('settings'));

  stageArea.append(
    h('div', { class: 'corner left' }, leftDrawer, leftToggle),
    h('div', { class: 'corner right' }, rightDrawer, rightToggle),
    h('div', { class: 'float-top' }, recBadge, stateChip, h('div', { class: 'spacer' })),
  );

  // ================================================================ PREVIEW RENDER

  let pendingBitmap: ImageBitmap | null = null;
  let renderQueued = false;

  function sizeCanvas(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(stageArea.clientWidth * dpr));
    const h2 = Math.max(2, Math.round(stageArea.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h2) { canvas.width = w; canvas.height = h2 }
  }

  function drawBitmap(bmp: ImageBitmap): void {
    if (!ctx) return;
    sizeCanvas();
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    // `contain`: identical letterboxing to the Cast's own preview.
    const scale = Math.min(cw / bmp.width, ch / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    ctx.drawImage(bmp, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const bmp = pendingBitmap;
      pendingBitmap = null;
      if (bmp) { drawBitmap(bmp); bmp.close() }
    });
  }

  async function onPreview(jpeg: Uint8Array): Promise<void> {
    try {
      // Copy into a standalone buffer: the transport buffer is recycled by the socket.
      const copy = jpeg.slice();
      const bmp = await createImageBitmap(new Blob([copy], { type: 'image/jpeg' }));
      pendingBitmap?.close();
      pendingBitmap = bmp;
      placeholder.hidden = true;
      scheduleRender();
    } catch { /* a single corrupt frame is not worth surfacing */ }
  }

  // ================================================================ SESSION WIRING

  let current: SessionState = defaultState();

  function currentZoom(): number { return current.zoom || 1 }

  function sendZoom(value: number): void {
    session.send({ k: 'zoom', value: clamp(value, 1, Math.max(1, current.maxZoom || 6)) });
  }

  function setRecordButton(recording: boolean): void {
    clear(recordBtn);
    recordBtn.append(icon(recording ? 'stop' : 'record'), h('span', { text: recording ? '停止' : '录像' }));
    recordBtn.classList.toggle('accent', !recording);
  }

  session.events.on('status', ({ status, message }) => {
    stateChip.hidden = status === 'idle';
    stateChip.className = `chip ${status === 'connected' ? 'ok' : status === 'error' ? 'err' : 'warn'}`;
    clear(stateChip);
    stateChip.append(h('span', { class: 'dot' }), h('span', { text: message ?? status }));
    if (status === 'idle' && !session.getHost()) {
      placeholder.hidden = false;
      hostLabel.textContent = '未连接';
    }
  });

  session.events.on('welcome', ({ device, accept, reason }) => {
    if (!accept) { toaster.show(reason ?? '对端拒绝连接', 'error'); return }
    hostLabel.textContent = `${device.name}（${device.platform} ${device.arch}）`;
    toaster.show(`已连接 ${device.name}`, 'info');
  });

  session.events.on('specs', ({ specs, current: cur, matchNote }) => {
    const spec = specs.find((s) => s.id === cur) ?? null;
    specLabel.textContent = spec ? `${spec.width}×${spec.height} · ${spec.fps}fps · ${spec.aspect} · ${spec.colorSpace.toUpperCase()}` : '—';
    if (matchNote) toaster.show(matchNote, 'info', 4200);
    renderSpecs(specs, cur);
  });

  session.events.on('state', (state) => {
    current = state;
    recBadge.hidden = !state.recording;
    recTime.textContent = formatDuration(state.recordingMs);
    setRecordButton(state.recording);
    if (Math.abs(Number(zoom.value) - state.zoom) > 0.01) zoom.value = String(state.zoom);
    zoomLabel.textContent = `${state.zoom.toFixed(1)}×`;
    zoom.max = String(Math.max(1, state.maxZoom));
    renderStorageSeg();
  });

  session.events.on('library', ({ files }) => {
    library.setFiles(files);
    const remote = files.filter((f) => f.origin === 'cast').length;
    const local = files.length - remote;
    if (library.panel.isOpen) library.panel.setTitle(`拍摄库 · 本机 ${local} / 远端 ${remote}`);
  });

  session.events.on('preview', ({ jpeg }) => { void onPreview(jpeg) });
  session.events.on('received', (file) => { toaster.show(`已接收 ${file.name}`, 'info'); void refreshLibrary() });
  session.events.on('notice', ({ level, message }) => toaster.show(message, level));
  session.events.on('transfer', (p) => {
    if ('receivedBytes' in p) {
      prog.hidden = false;
      prog.firstElementChild!.setAttribute('style', `width:${p.totalBytes ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0}%`);
      if (p.done) setTimeout(() => { prog.hidden = true }, 900);
    }
  });

  // ================================================================ PANELS

  const player = new Player({
    onClose: () => { /* state returns to live automatically */ },
    resolveUrl: (file) => store.urlFor(file),
  });
  root.appendChild(player.el);

  const library = new LibraryPanel({
    localRole: 'stage',
    urlFor: (file) => store.urlFor(file),
    onPlay: (files, index) => {
      player.open(files, index, (f) => store.urlFor(f));
      const file = files[index];
      if (file) session.send({ k: 'playback-open', id: file.id });
    },
    onPull: (file) => { session.requestFile(file) },
    onDelete: (file) => { void (async () => {
      await store.remove(file.id);
      await refreshLibrary();
      toaster.show(`已删除 ${file.name}`, 'info');
    })() },
    onOpen: () => { void host.openMediaFolder() },
  });

  async function openLibrary(): Promise<void> {
    await refreshLibrary();
    library.panel.toggle();
    session.send({ k: 'library-request' });
  }

  async function refreshLibrary(): Promise<void> {
    const files = await store.list();
    library.setFiles(files.length ? files : library.list);
  }

  // ------------------------------------------------------------------ connection panel

  const peerList = h('div', { class: 'spec-list' });
  const addrInput = h('input', { class: 'input', placeholder: '例如 192.168.1.20:8765', value: '' });
  const scanBtn = h('button', { class: 'btn sm', type: 'button' }, icon('wifi'), h('span', { text: '扫描局域网' }));
  const connectBtn = h('button', { class: 'btn sm accent', type: 'button' }, icon('link'), h('span', { text: '连接' }));
  const diagText = h('div', { class: 'hint mono', text: '—' });

  const connectionPanel = new Panel({ title: '连接拍摄端', width: 'wide', position: 'center' });
  connectionPanel.body.append(
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '扫描到的设备' }),
      peerList,
      h('div', { class: 'hint', text: '拍摄端开启后会自动广播；USB 连接请先在拍摄端点击「USB 桥接」。' }),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '手动输入地址' }),
      h('div', { style: 'display:flex;gap:8px' }, addrInput, connectBtn),
      h('div', { class: 'hint', text: `默认端口 ${DEFAULT_CAST_PORT}。同一台设备上同时运行两个应用时可直接连接 127.0.0.1。` }),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '本机信息' }),
      diagText,
    ),
  );
  connectionPanel.setFooter(scanBtn, h('div', { class: 'spacer' }), iconButton('close', '关闭', { cls: 'sm', onclick: () => connectionPanel.close() }));
  root.appendChild(connectionPanel.el);

  function renderPeers(peers: Array<{ address: string; name: string; via: string; platform: string | null }>): void {
    clear(peerList);
    if (!peers.length) { peerList.appendChild(h('div', { class: 'empty', text: '未发现设备。可手动输入地址连接。' })); return }
    for (const p of peers) {
      peerList.appendChild(h('button', {
        class: 'spec-item', type: 'button',
        on: { click: () => { void connectTo(p.address) } },
      },
        h('span', { class: 'tick' }, icon('link', 'ico sm')),
        h('span', { class: 'spec-main' },
          h('span', { class: 'spec-label', text: p.name || p.address }),
          h('span', { class: 'spec-sub', text: `${p.address} · ${p.via}` }),
        ),
      ));
    }
  }

  async function scan(): Promise<void> {
    scanBtn.disabled = true;
    clear(peerList);
    peerList.appendChild(h('div', { class: 'empty', text: '正在扫描…' }));
    try {
      const peers = await session.discover({ timeoutMs: 3500, port: DEFAULT_CAST_PORT, sweep: true });
      renderPeers(peers.map((p) => ({ address: p.address, name: p.name, via: p.via, platform: p.platform })));
    } catch (err) {
      toaster.show(`扫描失败：${String(err)}`, 'warn');
    } finally { scanBtn.disabled = false }
  }

  async function connectTo(rawAddress: string): Promise<void> {
    const url = normalizeAddress(rawAddress, DEFAULT_CAST_PORT);
    if (!url) { toaster.show('地址无效', 'warn'); return }
    try {
      await session.connect(url);
      connectionPanel.close();
    } catch (err) {
      toaster.show(`连接失败：${String(err)}`, 'error');
    }
  }

  scanBtn.addEventListener('click', () => { void scan() });
  connectBtn.addEventListener('click', () => { void connectTo(addrInput.value) });
  addrInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void connectTo(addrInput.value) });

  // ------------------------------------------------------------------ settings panel

  const settingsPanel = new Panel({ title: '大屏端设置', width: 'narrow', position: 'center' });
  const kv = h('dl', { class: 'kv' });

  function renderStorageSeg(): void {
    clear(storageSeg);
    const options: Array<[StorageTarget, string]> = [['cast', '存拍摄端'], ['stage', '存本机'], ['both', '两端都存']];
    for (const [value, label] of options) {
      storageSeg.appendChild(h('button', {
        type: 'button', text: label, 'aria-pressed': String(current.storageTarget === value),
        on: { click: () => { session.setStorageTarget(value); renderStorageSeg() } },
      }));
    }
  }

  function renderKv(): void {
    clear(kv);
    const pairs: Array<[string, string]> = [
      ['应用', `PodiumCast-Stage ${info.appVersion}`],
      ['平台', `${info.platform} · ${info.arch}`],
      ['设备名', info.deviceName],
      ['大屏分辨率', `${display.width}×${display.height} @ ${display.fps}Hz`],
      ['大屏比例', `${(display.ratio).toFixed(3)} : 1`],
      ['色域', display.colorSpace.toUpperCase()],
      ['缩放倍率', String(display.devicePixelRatio)],
      ['接收帧率', `${session.getMeasuredFps()} fps`],
      ['本机存储', info.mediaLocation],
    ];
    for (const [k, v] of pairs) kv.append(h('dt', { text: k }), h('dd', { text: v }));
  }

  settingsPanel.body.append(
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '大屏规格' }),
      kv,
      h('div', { class: 'hint', text: '首次连接时，拍摄端会按这里的比例自动匹配最接近的录制规格。' }),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '录制文件保存位置' }),
      storageSeg,
      h('div', { class: 'hint', text: '选择「存本机」后，拍摄端录完会自动把文件传过来；也可以在大屏端手动拉取。' }),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'label', text: '显示' }),
      h('div', { class: 'seg' },
        h('button', { type: 'button', text: '全屏', on: { click: () => { void host.setFullscreen(true) } } }),
        h('button', { type: 'button', text: '窗口', on: { click: () => { void host.setFullscreen(false) } } }),
        h('button', { type: 'button', text: '重新匹配比例', on: { click: () => { session.send({ k: 'match-display' }); toaster.show('已请求重新匹配大屏比例', 'info') } } }),
      ),
    ),
  );
  settingsPanel.setFooter(
    h('button', { class: 'btn sm', type: 'button', text: '打开本机存储', on: { click: () => { void host.openMediaFolder() } } }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', type: 'button', text: '断开连接', on: { click: () => { void session.disconnect() } } }),
  );
  root.appendChild(settingsPanel.el);
  root.appendChild(library.panel.el);

  function renderSpecs(specs: RecordingSpec[], currentId: string): void {
    void specs; void currentId;
  }

  // ================================================================ ACTIONS

  shutterBtn.addEventListener('click', () => session.send({ k: 'photo' }));
  recordBtn.addEventListener('click', () => session.send({ k: current.recording ? 'record-stop' : 'record-start' }));
  playBtn.addEventListener('click', () => session.send({ k: 'playback-toggle' }));

  window.addEventListener('keydown', (ev) => {
    if (player.isOpen) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    switch (ev.key) {
      case 'p': case 'P': ev.preventDefault(); session.send({ k: 'photo' }); break;
      case 'r': case 'R': ev.preventDefault(); session.send({ k: current.recording ? 'record-stop' : 'record-start' }); break;
      case 'l': case 'L': ev.preventDefault(); void openLibrary(); break;
      case 'c': case 'C': ev.preventDefault(); connectionPanel.toggle(); break;
      case 'f': case 'F': ev.preventDefault(); void host.setFullscreen(!document.fullscreenElement); break;
      case 'ArrowUp': ev.preventDefault(); sendZoom(currentZoom() * 1.2); break;
      case 'ArrowDown': ev.preventDefault(); sendZoom(currentZoom() / 1.2); break;
      default: break;
    }
  });

  const onResize = debounce(() => {
    sizeCanvas();
    // A window move can land on a different monitor: tell the Cast so it can re-match.
    void host.display().then((d) => {
      display = d;
      session.reportDisplay();
      renderKv();
    }).catch(() => undefined);
  }, 350);
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', () => session.dispose());

  // ================================================================ BOOT

  renderStorageSeg();
  renderKv();
  sizeCanvas();

  const diag = [
    `平台 ${info.platform}/${info.arch}`,
    `设备 ${info.deviceName}`,
    `本机存储 ${info.mediaLocation}`,
    `adb ${info.hasAdb ? '可用' : '不可用'}`,
  ].join(' · ');
  diagText.textContent = diag;

  await refreshLibrary().catch(() => undefined);

  // Auto-connect: try loopback first (same machine / USB), then scan once.
  void (async () => {
    const peers = await session.discover({ timeoutMs: 2600, port: DEFAULT_CAST_PORT, sweep: true }).catch(() => []);
    renderPeers(peers.map((p) => ({ address: p.address, name: p.name, via: p.via, platform: p.platform })));
    if (peers.length) await connectTo(peers[0].address).catch(() => undefined);
    else toaster.show('未自动发现拍摄端，请点击左下角图标手动连接', 'warn', 5200);
  })();

  placeholder.hidden = false;
  toaster.show('大屏端已启动', 'info');
}

export type { MediaFile };


// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * The bundle is a plain `<script src>` IIFE, so nothing calls `startStage()` for us.
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
  document.addEventListener('DOMContentLoaded', () => { void startStage().catch(reportFatal) }, { once: true });
} else {
  void startStage().catch(reportFatal);
}
