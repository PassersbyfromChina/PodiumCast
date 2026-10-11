/**
 * Shared Chrome DevTools Protocol helper for the verification scripts.
 *
 * Both `verify-ui.mjs` and `diagnose-layout.mjs` need to start the real Electron shell, drive
 * it and take screenshots. Keeping one implementation here means a fix to the CDP plumbing
 * (the reload-before-listening trick, the ELECTRON_RUN_AS_NODE trap, escape-sequence noise)
 * benefits every check rather than one script.
 *
 * There is deliberately no test framework: these scripts assert against a real window, which
 * no DOM shim can stand in for.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DESKTOP_DIR, OUT_DIR, require } from './build-common.mjs';

const electronPath = require('electron');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (err) { lastError = err.message }
    await sleep(200);
  }
  throw new Error(`无法连接 ${url}：${lastError}`);
}

/**
 * Waits for a *page* target to appear.
 *
 * `/json/list` answers 200 with `[]` while Electron is still starting, so a single successful
 * response is not enough — returning that empty array is what produced the intermittent
 * "未找到渲染进程 target：[]" failures.
 */
async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'empty';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
        last = `targets=${targets.length}`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) { last = err.message }
    await sleep(250);
  }
  throw new Error(`等待渲染进程超时（${last}）`);
}

/** Minimal CDP client over the `ws` package that is already a devDependency. */
export async function connectCdp(wsUrl) {
  const { WebSocket } = require('ws');
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of handlers.get(msg.method) ?? []) {
        try { fn(msg.params) } catch { /* a bad handler must not break the run */ }
      }
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, fn) => {
    const list = handlers.get(method) ?? [];
    list.push(fn);
    handlers.set(method, list);
  };
  return { send, on, close: () => socket.close() };
}

/**
 * Starts one role in a real Electron window of a given pixel size, connects over CDP and
 * waits for the app to settle.
 *
 * `forceTestPattern` defaults to on: a build machine's webcam is either absent or pointing at
 * a dark room, and neither lets you tell "the preview is broken" from "the room is dark".
 */
export async function launchRole(role, opts = {}) {
  const {
    width = 1280,
    height = 720,
    port = 9333,
    userDataSuffix = '',
    forceTestPattern = true,
    settleMs = 5000,
    extraArgs = [],
    env: extraEnv = {},
  } = opts;

  const userDataDir = path.join(OUT_DIR, `verify-${role}${userDataSuffix}`);
  await fs.rm(userDataDir, { recursive: true, force: true });

  const env = {
    ...process.env,
    PODIUMCAST_ROLE: role,
    PODIUMCAST_WINDOWED: '1',
    ...extraEnv,
  };
  if (forceTestPattern) env.PODIUMCAST_FORCE_TEST_PATTERN = '1';
  // The harness sets ELECTRON_RUN_AS_NODE=1 for its own tooling; left in place, Electron would
  // start as plain Node and never open a window.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, [
    DESKTOP_DIR,
    `--role=${role}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--no-sandbox`,
    ...extraArgs,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d) });
  child.stdout.on('data', () => undefined);

  const page = await waitForPageTarget(port, 40_000).catch((err) => {
    throw new Error(`${err.message}${stderr.trim() ? ` ｜ stderr: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  });

  const cdp = await connectCdp(page.webSocketDebuggerUrl);

  const rendererErrors = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    rendererErrors.push(d?.exception?.description ?? d?.text ?? 'unknown exception');
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      rendererErrors.push(`[console.${p.type}] ${(p.args ?? []).map((a) => a.description ?? a.value).join(' ')}`);
    }
  });
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') rendererErrors.push(`[log] ${p.entry.text}`) });

  // Resize the real window before reloading so the app boots at the target dimensions —
  // resizing afterwards would test the resize path, not the startup path.
  const { Browser } = await cdp.send('Browser.getVersion').then(() => ({ Browser: null })).catch(() => ({ Browser: null }));
  void Browser;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: role === 'stage' ? false : true,
    screenWidth: width, screenHeight: height,
  }).catch(() => undefined);

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(settleMs);

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '脚本异常');
    return r.result.value;
  };

  const screenshot = async (file) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
    return (await fs.stat(file)).size;
  };

  const close = async () => {
    try { cdp.close() } catch { /* already closed */ }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      child.once('exit', () => resolve());
    });
    child.kill();
    // Wait for the process to actually go away before the caller starts the next one: Electron
    // keeps a lock on its user-data dir, and launching again too early fails with EBUSY.
    const timedOut = await Promise.race([exited.then(() => false), sleep(4000).then(() => true)]);
    if (timedOut) child.kill('SIGKILL');
    await sleep(500);
  };

  return { cdp, evaluate, screenshot, close, stderr: () => stderr, rendererErrors, child };
}

/** Injects the DOM probe used by both scripts. Kept as a string so it runs in the page. */
export const LAYOUT_PROBE = `(() => {
  const app = document.getElementById('app');
  const stage = document.querySelector('.stage-area');
  const bar = document.querySelector('.bar');
  const floats = document.querySelector('.float-layer');
  const preview = document.querySelector('.preview');

  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const visible = (el) => {
    if (!el) return false;
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // Every control the user is meant to see, with whether it actually fits on screen.
  const controls = [...document.querySelectorAll('.bar .btn, .bar .icon-btn, .bar input[type=range], .bar .readout, .bar .chip, .bar .rec-badge, .float-layer .btn, .float-layer .icon-btn, .float-layer input[type=range], .corner-toggle')]
    .map((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const stageRect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const barRect = bar ? bar.getBoundingClientRect() : null;
      const host = el.closest('.bar') ? barRect : (el.closest('.float-layer') ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : stageRect);
      const clipped = host
        ? (r.left < host.left - 1 || r.top < host.top - 1 || r.right > host.right + 1 || r.bottom > host.bottom + 1)
        : false;
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 14),
        cls: el.className,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0 && !el.closest('[hidden]'),
        inHiddenContainer: Boolean(el.closest('[hidden]')),
        // A density tier removes controls with display:none on purpose (the zoom slider in a
        // 70px-wide band). That is a design decision, not a layout failure, so it must not be
        // reported as an unexpectedly invisible control.
        displayNone: style.display === 'none',
        clipped,
        display: style.display,
        overflow: style.overflow,
      };
    });

  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    layout: app ? app.dataset.layout : null,
    barMinor: app ? getComputedStyle(app).getPropertyValue('--bar-minor').trim() : '',
    barSlots: app ? getComputedStyle(app).getPropertyValue('--bar-slots').trim() : '',
    stageRect: rect(stage),
    barRect: rect(bar),
    barClient: bar ? { w: bar.clientWidth, h: bar.clientHeight, sw: bar.scrollWidth, sh: bar.scrollHeight } : null,
    barOverflow: bar ? (bar.scrollHeight > bar.clientHeight + 1 || bar.scrollWidth > bar.clientWidth + 1) : false,
    barHidden: bar ? bar.hidden : null,
    floatsHidden: floats ? floats.hidden : null,
    previewRect: rect(preview),
    previewVideo: preview && preview.tagName === 'VIDEO'
      ? { videoWidth: preview.videoWidth, videoHeight: preview.videoHeight, readyState: preview.readyState, paused: preview.paused }
      : null,
    canvasRect: (() => { const c = document.querySelector('canvas.preview'); return c ? { w: c.width, h: c.height, css: rect(c) } : null })(),
    controls,
    clippedCount: controls.filter((c) => c.visible && c.clipped).length,
    // Only count a control as "unexpectedly invisible" when nothing above it was deliberately
    // hidden: a button inside a collapsed drawer or an unused float layer is supposed to be 0px.
    invisibleCount: controls.filter((c) => !c.visible && !c.inHiddenContainer && !c.displayNone).length,
    hiddenByContainer: controls.filter((c) => !c.visible && c.inHiddenContainer).length,
    corners: document.querySelectorAll('.corner-toggle').length,
    shots: {
      readout: (document.querySelector('.readout .line') || {}).textContent || '',
    },
  };
})()`;

/** Human-readable one-line summary of a probe result. */
export function summarizeLayout(probe) {
  const bits = [
    `${probe.viewport.w}×${probe.viewport.h}`,
    `layout=${probe.layout}`,
    `band=${probe.barMinor || '-'}`,
    `slots=${probe.barSlots || '-'}`,
    `bar=${probe.barRect ? `${probe.barRect.w}×${probe.barRect.h}` : '-'}`,
    `overflow=${probe.barOverflow ? 'YES' : 'no'}`,
    `clipped=${probe.clippedCount}`,
    `hidden=${probe.invisibleCount}`,
    `stage=${probe.stageRect ? `${probe.stageRect.w}×${probe.stageRect.h}` : '-'}`,
  ];
  if (probe.previewVideo) bits.push(`video=${probe.previewVideo.videoWidth}×${probe.previewVideo.videoHeight}`);
  if (probe.canvasRect) bits.push(`canvas=${probe.canvasRect.w}×${probe.canvasRect.h}`);
  return bits.join('  ');
}
