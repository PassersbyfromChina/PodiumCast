#!/usr/bin/env node
/**
 * Renders a static page in a real Chromium window and writes PNGs.
 *
 * The landing page is the project's front door and it is pure HTML/CSS, so "does it look right"
 * cannot be answered by a structural check — the subagent that wrote it could only verify the
 * markup. This loads it in the same engine that will render it for visitors (Electron's
 * Chromium), at a desktop and a phone width, in both themes, and saves images to look at.
 *
 *   node scripts/screenshot-page.mjs                       # index.html, both themes
 *   node scripts/screenshot-page.mjs --page index.html --sizes 1280x900,390x844
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUT_DIR, ROOT, require } from './lib/build-common.mjs';
import { connectCdp, sleep } from './lib/cdp.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
};

const page = arg('page', 'index.html');
const sizes = arg('sizes', '1280x900,390x844').split(',').map((s) => {
  const [w, h] = s.split('x').map(Number);
  return { w, h };
});
const themes = arg('themes', 'dark,light').split(',');
const outDir = path.resolve(arg('out', path.join(OUT_DIR, 'page-shots')));
const electronPath = require('electron');

await fs.mkdir(outDir, { recursive: true });
const fileUrl = pathToFileURL(path.join(ROOT, page)).toString();

let port = 9600;
for (const { w, h } of sizes) {
  for (const theme of themes) {
    const userData = path.join(OUT_DIR, `shot-${w}x${h}-${theme}`);
    await fs.rm(userData, { recursive: true, force: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    // Electron wants an *application directory* (a folder with package.json + main), not a bare
    // script: handing it a loose file makes the loader guess the module system and it picks ESM.
    const appDir = path.join(OUT_DIR, `shot-app-${w}x${h}-${theme}`);
    await fs.rm(appDir, { recursive: true, force: true });
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'podiumcast-shot', version: '1.0.0', main: 'main.js' }, null, 2), 'utf8');
    // Build the theme-applying expression here and embed it as a properly escaped JS string
    // literal. Interpolating JSON.stringify() straight into a double-quoted line in the
    // generated file terminates that string — JSON quotes are also double quotes — and the main
    // process dies with "missing ) after argument list".
    const themeScript =
      `localStorage.setItem('podiumcast-theme', ${JSON.stringify(theme)});`
      + `document.documentElement.dataset.theme = ${JSON.stringify(theme)};`
      + `document.documentElement.style.colorScheme = ${JSON.stringify(theme)}; true;`;

    await fs.writeFile(path.join(appDir, 'main.js'), `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: ${w}, height: ${h}, show: true, frame: false, backgroundColor: '#000000',
  });
  await win.loadURL(${JSON.stringify(fileUrl)});
  // Set the theme before the shot is taken, both stored and applied, so the inline head script
  // and the toggle agree with what is being rendered.
  await win.webContents.executeJavaScript(${JSON.stringify(themeScript)});
});
`, 'utf8');

    const proc = spawn(electronPath, [appDir, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--no-sandbox'], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d) });

    try {
      const deadline = Date.now() + 25_000;
      let target = null;
      while (Date.now() < deadline && !target) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (res.ok) target = (await res.json()).find((t) => t.type === 'page');
        } catch { /* still starting */ }
        if (!target) await sleep(250);
      }
      if (!target) throw new Error(`窗口未启动。完整 stderr:\n${stderr.trim().slice(-1200)}\n--- main.js ---\n${await fs.readFile(path.join(appDir, 'main.js'), 'utf8').catch(() => '(unreadable)')}`);

      const cdp = await connectCdp(target.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 2, mobile: w < 600,
        screenWidth: w, screenHeight: h,
      }).catch(() => undefined);
      await sleep(900);
      await cdp.send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true;`,
      });
      await sleep(400);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = path.join(outDir, `${path.basename(page, '.html')}-${w}x${h}-${theme}.png`);
      await fs.writeFile(file, Buffer.from(shot.data, 'base64'));

      const metrics = await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const wrap = document.querySelector('.wrap');
          const h1 = document.querySelector('h1');
          const tw = document.querySelector('.table-wrap');
          const box = (el) => el ? {
            x: Math.round(el.getBoundingClientRect().x),
            w: Math.round(el.getBoundingClientRect().width),
          } : null;
          return {
            theme: document.documentElement.dataset.theme,
            bg: getComputedStyle(document.body).backgroundColor,
            height: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: innerWidth,
            overflowX: document.documentElement.scrollWidth > innerWidth + 1,
            hero: (document.querySelector('h1') || {}).textContent || '',
            links: [...document.querySelectorAll('a[href*="releases/latest/download/"]')].length,
            details: document.querySelectorAll('details').length,
            wrap: wrap ? { ...box(wrap), boxSizing: getComputedStyle(wrap).boxSizing,
              padL: getComputedStyle(wrap).paddingLeft, padR: getComputedStyle(wrap).paddingRight } : null,
            h1: h1 ? { ...box(h1), fontSize: getComputedStyle(h1).fontSize } : null,
            tableWrap: tw ? { ...box(tw), scrollW: tw.scrollWidth, overflowX: getComputedStyle(tw).overflowX } : null,
            // Anything that sticks out past the viewport is the real overflow signal; a wide
            // table inside an overflow-x:auto wrapper is fine and must not count.
            offenders: [...document.querySelectorAll('body *')]
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
              })
              .slice(0, 6)
              .map((el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]
                + '[' + Math.round(el.getBoundingClientRect().left) + '..' + Math.round(el.getBoundingClientRect().right) + ']'),
          };
        })()`,
      });
      const m = metrics.result.value;
      console.log(`${w}×${h} ${theme.padEnd(5)}  bg=${m.bg.padEnd(20)} 页面高=${m.height}  下载链接=${m.links}  details=${m.details}  横向溢出=${m.overflowX ? 'YES' : 'no'}`);
      console.log(`        标题: ${m.hero.slice(0, 60)}`);
      if (m.wrap) console.log(`        wrap x=${m.wrap.x} w=${m.wrap.w} box-sizing=${m.wrap.boxSizing} padding=${m.wrap.padL}/${m.wrap.padR}  h1 x=${m.h1?.x} fs=${m.h1?.fontSize}`);
      if (m.offenders?.length) console.log(`        越界元素: ${m.offenders.join(', ')}`);
      console.log(`        截图: ${path.relative(process.cwd(), file)}  (${(Buffer.from(shot.data, 'base64').length / 1024).toFixed(0)} KB)`);
      cdp.close();
    } catch (err) {
      console.error(`${w}×${h} ${theme}: 失败 — ${err.message}`);
      process.exitCode = 1;
    } finally {
      proc.kill();
      await sleep(600);
      if (!proc.killed) proc.kill('SIGKILL');
      await fs.rm(appDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(userData, { recursive: true, force: true }).catch(() => undefined);
      port++;
    }
  }
}
