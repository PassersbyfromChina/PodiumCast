/**
 * PodiumCast desktop shell (Electron main process).
 *
 * One binary hosts either role, chosen at build time by `podiumcastRole` in package.json
 * (electron-builder's `extraMetadata`) and overridable at runtime with `--role=` or
 * `PODIUMCAST_ROLE` for development. That is why there are six Windows artefacts and two
 * macOS ones from a single source tree.
 *
 * Everything native lives here — the WebSocket server, UDP discovery, the media store, the
 * `adb reverse` USB bridge, the display probe and the `podiumcast://` protocol handler — and
 * the renderer reaches it through the two-function preload bridge.
 */
import { app, BrowserWindow, ipcMain, net, protocol, screen, session as electronSession, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeCastBridge, NodeMediaStore, localIPv4 } from '@podiumcast/core/node';
import type { DisplaySpec, MediaFile } from '@podiumcast/core';

type Role = 'cast' | 'stage';

// ---------------------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------------------

function resolveRole(): Role {
  const fromArg = process.argv.find((a) => a.startsWith('--role='));
  if (fromArg) return fromArg.split('=')[1] === 'stage' ? 'stage' : 'cast';
  if (process.env.PODIUMCAST_ROLE === 'stage') return 'stage';
  if (process.env.PODIUMCAST_ROLE === 'cast') return 'cast';
  try {
    const pkg = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { podiumcastRole?: string };
    if (pkg.podiumcastRole === 'stage') return 'stage';
  } catch { /* fall through to the default */ }
  return 'cast';
}

const ROLE: Role = resolveRole();
const APP_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { version?: string }).version ?? '1.0.0';
  } catch { return '1.0.0' }
})();

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

const DEFAULT_PORT = 8765;
const DISCOVERY_PORT = 8766;

let mediaBase = '';
let store: NodeMediaStore | null = null;
let castBridge: NodeCastBridge | null = null;
let mainWindow: BrowserWindow | null = null;

/** Writes are keyed by the handle the store hands back, so the renderer never sees a path. */
const writeHandles = new Map<string, string>();

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function mediaDirectory(): string {
  // The user's real Videos folder keeps recordings discoverable outside the app.
  const videos = app.getPath('videos');
  return path.join(videos, 'PodiumCast');
}

/** Reads the display a window is on, with the fallbacks Electron leaves undocumented. */
function displayFor(window: BrowserWindow | null): DisplaySpec {
  const d = window && !window.isDestroyed()
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getPrimaryDisplay();
  const width = d.size.width;
  const height = d.size.height;
  return {
    width,
    height,
    aspect: '',
    ratio: width / Math.max(1, height),
    fps: Math.round(d.displayFrequency || 60),
    // macOS panels are P3; Windows/Linux report sRGB. Electron exposes no gamut query.
    colorSpace: process.platform === 'darwin' ? 'p3' : 'srgb',
    fullscreen: Boolean(window?.isFullScreen()),
    devicePixelRatio: d.scaleFactor || 1,
  };
}

// ---------------------------------------------------------------------------------------
// Adb (USB transport, 说明\连接方式.xlsx 「USB」)
// ---------------------------------------------------------------------------------------

function runAdb(args: string[], timeoutMs = 12_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('adb', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) });
    });
  });
}

async function adbAvailable(): Promise<boolean> {
  const r = await runAdb(['version'], 5000);
  return r.code === 0;
}

// ---------------------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('host:info', async () => ({
    role: ROLE,
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    arch: process.arch === 'ia32' ? 'x32' : process.arch === 'arm64' ? 'arm' : 'x64',
    appVersion: APP_VERSION,
    deviceId: deviceId(),
    deviceName: os_hostname(),
    mediaLocation: mediaBase,
    canServe: true,
    canBeacon: true,
    hasAdb: await adbAvailable(),
  }));

  // --- transport ---------------------------------------------------------------------
  ipcMain.handle('server:start', async (_e, { port }: { port: number }) => {
    if (!castBridge) castBridge = makeCastBridge();
    const bound = await castBridge.start(port || DEFAULT_PORT);
    return { port: bound, addresses: localIPv4() };
  });
  ipcMain.handle('server:stop', async () => { await castBridge?.stop(); castBridge = null });
  ipcMain.handle('server:broadcast', (_e, { data }: { data: string | Uint8Array }) => { castBridge?.broadcast(data) });
  ipcMain.handle('server:send', (_e, { peerId, data }: { peerId: string; data: string | Uint8Array }) => { castBridge?.send(peerId, data) });
  ipcMain.handle('server:closePeer', (_e, { peerId, reason }: { peerId: string; reason: string }) => { castBridge?.closePeer(peerId, reason) });
  ipcMain.handle('server:peers', async () => castBridge?.peers() ?? []);
  ipcMain.handle('beacon:start', async (_e, { castPort, port }: { castPort: number; port: number }) => {
    if (!castBridge) castBridge = makeCastBridge();
    await castBridge.startBeacon({ port: port || DISCOVERY_PORT, castPort: castPort || DEFAULT_PORT, intervalMs: 1000 });
  });
  ipcMain.handle('beacon:stop', async () => { await castBridge?.stopBeacon() });
  ipcMain.handle('discover', async (_e, opts: { timeoutMs: number; port: number; sweep: boolean }) => {
    const { NodeStageBridge } = await import('@podiumcast/core/node');
    const bridge = new NodeStageBridge();
    try { return await bridge.discover(opts) } finally { await bridge.disconnect().catch(() => undefined) }
  });

  // --- storage -----------------------------------------------------------------------
  ipcMain.handle('store:list', async () => store?.list() ?? []);
  ipcMain.handle('store:beginWrite', async (_e, args: { name: string; kind: 'photo' | 'video'; meta: { mime: string; width: number; height: number; createdAt: number } }) => {
    if (!store) throw new Error('存储未初始化');
    const handle = await store.beginWrite(args.name, args.kind, args.meta);
    writeHandles.set(handle, args.name);
    return handle;
  });
  ipcMain.handle('store:append', async (_e, { handle, bytes }: { handle: string; bytes: Uint8Array }) => {
    if (!store) throw new Error('存储未初始化');
    await store.appendWrite(handle, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBufferLike));
  });
  ipcMain.handle('store:end', async (_e, { handle, durationMs }: { handle: string; durationMs: number }) => {
    if (!store) throw new Error('存储未初始化');
    writeHandles.delete(handle);
    return store.endWrite(handle, durationMs);
  });
  ipcMain.handle('store:abort', async (_e, { handle }: { handle: string }) => {
    writeHandles.delete(handle);
    await store?.abortWrite(handle);
  });
  ipcMain.handle('store:readRange', async (_e, { id, offset, length }: { id: string; offset: number; length: number }) => {
    if (!store) throw new Error('存储未初始化');
    const bytes = await store.readRange(id, offset, Math.min(length, 64 * 1024 * 1024));
    // Returned as a Buffer-backed Uint8Array; structured clone preserves the bytes.
    return bytes;
  });
  ipcMain.handle('store:remove', async (_e, { id }: { id: string }) => { await store?.remove(id) });

  // --- OS integration ----------------------------------------------------------------
  ipcMain.handle('display:get', async () => displayFor(mainWindow));
  ipcMain.handle('media:openFolder', async () => {
    await fs.mkdir(mediaBase, { recursive: true });
    await shell.openPath(mediaBase);
  });
  ipcMain.handle('media:chooseFolder', async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择录制文件保存目录', defaultPath: mediaBase });
    if (result.canceled || !result.filePaths[0]) return null;
    mediaBase = result.filePaths[0];
    store = new NodeMediaStore(mediaBase, 'podiumcast://media');
    await store.init();
    return mediaBase;
  });
  ipcMain.handle('media:usbBridge', async (_e, { port }: { port: number }) => {
    if (!(await adbAvailable())) return { ok: false, message: '未找到 adb：请安装 Android Platform Tools 并加入 PATH。' };
    const devices = await runAdb(['devices']);
    const attached = devices.stdout.split(/\r?\n/).slice(1).filter((l) => l.trim() && !l.includes('offline')).length;
    if (!attached) return { ok: false, message: 'adb 未检测到设备：请用数据线连接大屏设备并打开 USB 调试。' };
    const r = await runAdb(['reverse', `tcp:${port}`, `tcp:${port}`]);
    if (r.code !== 0) return { ok: false, message: `adb reverse 失败：${r.stderr.trim() || r.stdout.trim()}` };
    return { ok: true, message: `USB 桥接已建立：大屏端连接 127.0.0.1:${port} 即可。` };
  });
  ipcMain.handle('window:fullscreen', async (_e, { fullscreen }: { fullscreen: boolean }) => {
    mainWindow?.setFullScreen(Boolean(fullscreen));
    return Boolean(mainWindow?.isFullScreen());
  });
  ipcMain.handle('app:quit', async () => { app.quit() });
}

function os_hostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:os').hostname() as string;
  } catch { return 'PodiumCast' }
}

function deviceId(): string {
  const file = path.join(app.getPath('userData'), 'device-id');
  try { return readFileSync(file, 'utf8').trim() } catch { /* first run */ }
  const id = `pc-${Math.random().toString(36).slice(2, 10)}`;
  try { void fs.writeFile(file, id, 'utf8') } catch { /* read-only profile */ }
  return id;
}

function makeCastBridge(): NodeCastBridge {
  const bridge = new NodeCastBridge({
    name: os_hostname(),
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    version: 1,
  });
  bridge.events.on('peer', (p) => send('podiumcast:event', { event: 'peer', peer: { id: p.id, address: p.address, connectedAt: p.connectedAt } }));
  bridge.events.on('peerGone', (p) => send('podiumcast:event', { event: 'peerGone', id: p.id, reason: p.reason }));
  bridge.events.on('text', (m) => send('podiumcast:event', { event: 'text', peerId: m.peerId, message: m.message }));
  bridge.events.on('binary', (m) => send('podiumcast:event', { event: 'binary', peerId: m.peerId, bytes: m.bytes }));
  bridge.events.on('error', (m) => send('podiumcast:event', { event: 'error', message: m.message, fatal: m.fatal }));
  bridge.events.on('listen', (v) => {
    if ('error' in v) send('podiumcast:event', { event: 'server:error', port: v.port, message: v.error });
    else send('podiumcast:event', { event: 'server:listen', port: v.port, addresses: v.addresses });
  });
  return bridge;
}

// ---------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------

function createWindow(): void {
  const isStage = ROLE === 'stage';
  mainWindow = new BrowserWindow({
    width: isStage ? 1600 : 1280,
    height: isStage ? 900 : 720,
    minWidth: isStage ? 640 : 720,
    minHeight: isStage ? 400 : 420,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    fullscreen: isStage && process.env.PODIUMCAST_WINDOWED !== '1',
    title: isStage ? 'PodiumCast Stage' : 'PodiumCast Cast',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A 20 fps preview must keep flowing even when the window is not focused.
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null });

  // Camera/microphone permission: the renderer asks, the main process decides.
  const ses = mainWindow.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture' || permission === 'fullscreen');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'fullscreen');

  const html = path.join(__dirname, 'renderer', ROLE, 'index.html');
  // The renderer is served from `podiumcast://app/…` rather than `file://`.
  //
  // A `file://` document has an opaque origin, so the renderer's own `default-src 'self'`
  // Content-Security-Policy matches nothing — Chromium then refuses to load app.js and
  // app.css and the window stays blank. Registering a standard, secure scheme gives the page a
  // real origin, so the strict CSP written in scripts/lib/build-web.mjs is both enforced and
  // satisfiable.
  const testPattern = process.env.PODIUMCAST_FORCE_TEST_PATTERN === '1' ? '?forceTestPattern=1' : '';
  void mainWindow.loadURL(`podiumcast://app/${ROLE}/index.html${testPattern}`).catch((err) => {
    console.error('[podiumcast] failed to load renderer', err);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    send('podiumcast:event', { event: 'display', display: displayFor(mainWindow) });
  });

  // The window may be dragged onto another monitor: report the new display.
  const reportDisplay = () => send('podiumcast:event', { event: 'display', display: displayFor(mainWindow) });
  mainWindow.on('move', reportDisplay);
  mainWindow.on('resize', reportDisplay);
  mainWindow.on('enter-full-screen', reportDisplay);
  mainWindow.on('leave-full-screen', reportDisplay);
  screen.on('display-metrics-changed', reportDisplay);
  screen.on('display-added', reportDisplay);
  screen.on('display-removed', reportDisplay);
}

// ---------------------------------------------------------------------------------------
// Custom protocol: podiumcast://app/<role>/…  and  podiumcast://media/<id>
// ---------------------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Serves the bundled renderer. `requestPath` is always inside `dist/renderer`. */
async function serveRenderer(requestPath: string): Promise<Response> {
  const root = path.join(__dirname, 'renderer');
  const clean = decodeURIComponent(requestPath).replace(/^\/+/, '');
  const resolved = path.resolve(root, clean);
  // Path traversal guard: a crafted URL must never escape the renderer directory.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const body = await fs.readFile(resolved);
    const type = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function registerAppProtocol(): void {
  protocol.handle('podiumcast', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'app') return await serveRenderer(url.pathname);

      if (url.hostname === 'media') {
        const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
        const resolved = store?.resolvePath(id) ?? null;
        if (!resolved) return new Response('not found', { status: 404 });
        const response = await net.fetch(pathToFileURL(resolved).toString());
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: response.status, headers });
      }
      return new Response('unknown host', { status: 404 });
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  });
}

// ---------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  // `standard` + `secure` give the renderer a real origin, which is what makes the
  // strict `default-src 'self'` policy inside the page both enforceable and satisfiable.
  { scheme: 'podiumcast', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

// Only one instance per role: a second Cast would fail to bind the port anyway.
if (!app.requestSingleInstanceLock({ role: ROLE })) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  });

  void app.whenReady().then(async () => {
    mediaBase = mediaDirectory();
    store = new NodeMediaStore(mediaBase, 'podiumcast://media');
    await store.init();
    store.events.on('changed', (files: MediaFile[]) => send('podiumcast:event', { event: 'store:changed', files }));

    registerAppProtocol();
    registerIpc();
    createWindow();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() });
  app.on('before-quit', async () => {
    await castBridge?.stopBeacon().catch(() => undefined);
    await castBridge?.stop().catch(() => undefined);
  });

  // Never let an unhandled rejection in the transport take the app down mid-recording.
  process.on('uncaughtException', (err) => { console.error('[podiumcast] uncaught', err) });
  process.on('unhandledRejection', (err) => { console.error('[podiumcast] unhandled rejection', err) });

  // Chromium needs this on some Windows drivers before it will hand over 1080p60.
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
}

export { electronSession };
