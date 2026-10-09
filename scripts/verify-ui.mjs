#!/usr/bin/env node
/**
 * Headless UI verification for the Electron apps.
 *
 * A build that compiles is not a build that runs. This script launches the real packaged
 * shell (or the dev dist), drives it over the Chrome DevTools Protocol, asserts that the
 * expected UI actually materialised, and writes a PNG of the window so the result can be
 * inspected by a human.
 *
 * It deliberately runs without a camera: the Cast falls back to its synthetic test pattern, so
 * this works on a build agent and still exercises the whole pipeline — device enumeration,
 * spec list, layout computation and the network half of the session.
 *
 *   node scripts/verify-ui.mjs                 # both roles
 *   node scripts/verify-ui.mjs --role cast
 *   node scripts/verify-ui.mjs --screenshot-dir .podiumcast-out/shots
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DESKTOP_DIR, OUT_DIR, require } from './lib/build-common.mjs';

const CDP_PORT = Number(process.env.PODIUMCAST_CDP_PORT ?? 9333);

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
};

const shotDir = path.resolve(arg('screenshot-dir', path.join(OUT_DIR, 'shots')));
const roles = arg('role') ? [arg('role')] : ['cast', 'stage'];

const electronPath = require('electron');
const results = [];

function check(role, name, ok, detail = '') {
  results.push({ role, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${role}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (err) { lastError = err.message }
    await sleep(250);
  }
  throw new Error(`无法连接 ${url}：${lastError}`);
}

/** Minimal CDP client over the `ws` package that is already a devDependency. */
async function connectCdp(wsUrl) {
  const { WebSocket } = require('ws');
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
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

async function verifyRole(role) {
  const userDataDir = path.join(OUT_DIR, `verify-${role}`);
  await fs.rm(userDataDir, { recursive: true, force: true });

  const env = {
    ...process.env,
    PODIUMCAST_ROLE: role,
    PODIUMCAST_WINDOWED: '1',
    // Deterministic picture for the preview check: a real webcam on a build machine is either
    // missing or pointing at a dark room, which makes "is anything rendering?" unanswerable.
    PODIUMCAST_FORCE_TEST_PATTERN: '1',
  };
  // The harness sets ELECTRON_RUN_AS_NODE=1 for its own tooling; left in place, Electron would
  // start as plain Node and never open a window.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, [
    DESKTOP_DIR,
    `--role=${role}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d) });
  child.stdout.on('data', () => undefined);

  try {
    const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 30_000);
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error(`未找到渲染进程 target：${JSON.stringify(targets).slice(0, 300)}`);
    check(role, '渲染进程已启动', true, page.url.replace(/^file:\/\/.*\//, '…/'));

    const cdp = await connectCdp(page.webSocketDebuggerUrl);

    // Capture renderer diagnostics and *reload*, so the boot sequence runs again while we are
    // already listening. Without the reload a startup exception would fire before the CDP
    // connection exists and the failure would be invisible.
    const rendererErrors = [];
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      rendererErrors.push(d?.exception?.description ?? d?.text ?? 'unknown exception');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'warning') return;
      rendererErrors.push(`[console.${p.type}] ${(p.args ?? []).map((a) => a.description ?? a.value).join(' ')}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') rendererErrors.push(`[log] ${p.entry.text}`);
    });

    await cdp.send('Page.reload', { ignoreCache: true });
    // Give the app time to enumerate devices, negotiate the layout and paint once.
    await sleep(5000);

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '脚本异常');
      return r.result.value;
    };

    const probe = await evaluate(`(() => {
      const app = document.getElementById('app');
      const bar = document.querySelector('.bar');
      const floats = document.querySelector('.float-layer');
      const stage = document.querySelector('.stage-area');
      const preview = document.querySelector('.preview');
      const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent);
      return {
        hasApp: !!app,
        role: app ? app.dataset.role : null,
        layout: app ? app.dataset.layout : null,
        barMinor: app ? getComputedStyle(app).getPropertyValue('--bar-minor').trim() : '',
        barSlots: app ? getComputedStyle(app).getPropertyValue('--bar-slots').trim() : '',
        buttons: [...document.querySelectorAll('.btn, .icon-btn, .corner-toggle')].map(b => b.getAttribute('aria-label') || b.textContent.trim()).filter(Boolean),
        // Only what the user can actually see: panels and drawers start hidden, and counting
        // their descendants would make "controls are hidden until asked for" untestable.
        visibleButtons: [...document.querySelectorAll('.btn, .icon-btn, .corner-toggle')].filter(b => {
          if (b.closest('[hidden]')) return false;
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).length,
        specText: (document.querySelector('.readout .line') || {}).textContent || '',
        corners: document.querySelectorAll('.corner-toggle').length,
        drawers: document.querySelectorAll('.drawer').length,
        stageSize: stage ? [stage.clientWidth, stage.clientHeight] : null,
        previewSize: preview ? [preview.clientWidth, preview.clientHeight] : null,
        toasts,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        scripts: document.querySelectorAll('script[src]').length,
        title: document.title,
      };
    })()`);

    check(role, '应用根节点渲染', probe.hasApp === true);
    check(role, '角色标记正确', probe.role === role, String(probe.role));
    check(role, '标题正确', /PodiumCast/.test(probe.title), probe.title);
    check(role, '黑色背景', probe.bodyBg === 'rgb(0, 0, 0)', probe.bodyBg);
    check(role, '预览区域有尺寸', Boolean(probe.stageSize && probe.stageSize[0] > 100), JSON.stringify(probe.stageSize));

    if (role === 'cast') {
      check(role, '控件已渲染', probe.visibleButtons >= 4, `${probe.visibleButtons} 个可见：${probe.buttons.slice(0, 8).join(' / ')}`);
      check(role, '布局模式已计算', ['overlay', 'split-h', 'split-v'].includes(probe.layout), String(probe.layout));
      if (probe.layout !== 'overlay') {
        check(role, '黑边宽度与行数已推导', Number(probe.barMinor.replace('px', '')) > 100 && Number(probe.barSlots) >= 1,
          `--bar-minor=${probe.barMinor} --bar-slots=${probe.barSlots}`);
      }
      check(role, '录制规格已枚举', /×/.test(probe.specText), probe.specText.slice(0, 80));
    } else {
      check(role, '左下/右下角图标已渲染', probe.corners >= 2, `${probe.corners} 个`);
      check(role, '角标抽屉存在', probe.drawers >= 2, `${probe.drawers} 个`);
      // 要求.txt 二-2: the Stage hides every control behind the two corner icons.
      check(role, '默认只显示角标，操控已隐藏', probe.visibleButtons === 2, `${probe.visibleButtons} 个可见按钮`);
      const opened = await evaluate(`(() => {
        const toggles = [...document.querySelectorAll('.corner-toggle')];
        toggles.forEach(t => t.click());
        const drawers = [...document.querySelectorAll('.drawer')];
        return {
          open: drawers.filter(d => !d.hidden).length,
          buttons: [...document.querySelectorAll('.drawer .btn, .drawer .icon-btn')].length,
        };
      })()`);
      check(role, '点击角标展开抽屉', opened.open === 2, `${opened.open}/2 展开`);
      check(role, '抽屉内含操控按键', opened.buttons >= 5, `${opened.buttons} 个`);
    }

    // Screenshot the real window contents.
    await fs.mkdir(shotDir, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(shotDir, `${role}.png`);
    await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
    const size = (await fs.stat(file)).size;
    check(role, '窗口截图已保存', size > 5000, `${path.relative(process.cwd(), file)} (${(size / 1024).toFixed(0)} KB)`);

    // The Cast must actually be rendering a picture — a UI that draws its chrome around a
    // black rectangle looks "fine" in a DOM assertion and is completely broken in the field.
    if (role === 'cast') {
      const live = await evaluate(`(() => {
        const v = document.querySelector('video.preview');
        if (!v) return { error: '找不到预览 video 元素' };
        const c = document.createElement('canvas');
        c.width = 64; c.height = 36;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 64, 36);
        const d = ctx.getImageData(0, 0, 64, 36).data;
        let sum = 0, max = 0;
        for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; sum += l; max = Math.max(max, l) }
        return {
          videoWidth: v.videoWidth, videoHeight: v.videoHeight,
          readyState: v.readyState, paused: v.paused,
          avgLuma: sum / (d.length / 4 * 3), maxLuma: max,
        };
      })()`);
      check(role, '预览流已就绪', (live.videoWidth ?? 0) > 0 && live.readyState >= 2,
        `videoWidth=${live.videoWidth} readyState=${live.readyState} paused=${live.paused}`);
      check(role, '预览画面非纯黑', (live.avgLuma ?? 0) > 4 || (live.maxLuma ?? 0) > 20,
        `平均亮度=${Number(live.avgLuma ?? 0).toFixed(1)} 峰值=${live.maxLuma}`);
    }

    // Collect any renderer-side errors that would otherwise be invisible in a build log.
    check(role, '渲染进程无报错', rendererErrors.length === 0,
      rendererErrors.length ? rendererErrors.slice(0, 3).join(' | ').slice(0, 400) : '');

    cdp.close();
    return true;
  } catch (err) {
    check(role, '启动验证失败', false, err.message);
    if (stderr.trim()) console.error(`    stderr: ${stderr.trim().split('\n').slice(-6).join('\n    ')}`);
    return false;
  } finally {
    child.kill();
    await sleep(600);
    if (!child.killed) child.kill('SIGKILL');
  }
}

console.log('PodiumCast UI 验证（无摄像头，使用测试画面）\n');
for (const role of roles) {
  console.log(`--- ${role} ---`);
  // Each role needs its own debugging port so a leftover process cannot answer for the next.
  process.env.PODIUMCAST_CDP_PORT = String(CDP_PORT + roles.indexOf(role));
  // eslint-disable-next-line no-await-in-loop -- roles are verified one at a time
  await verifyRole(role);
  console.log('');
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.error(`  · [${f.role}] ${f.name} ${f.detail}`);
  process.exitCode = 1;
}
process.exit(failed.length ? 1 : 0);
