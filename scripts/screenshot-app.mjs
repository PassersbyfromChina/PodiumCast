#!/usr/bin/env node
/**
 * Screenshots a role's window, optionally after driving the UI first.
 *
 * The layout harness measures geometry and the UI verifier asserts behaviour; neither shows
 * what a panel actually looks like. This drives a role through a short script (open Settings,
 * open the library, expand a drawer …) and saves the result, which is how the format picker and
 * the mirror switches get reviewed after a change.
 *
 *   node scripts/screenshot-app.mjs --role cast --click=.icon-btn[aria-label="设置"] --name settings
 *   node scripts/screenshot-app.mjs --role stage --click=".corner-toggle" --all-clicks
 */
import path from 'node:path';
import { OUT_DIR } from './lib/build-common.mjs';
import { launchRole, sleep } from './lib/cdp.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
};

const role = arg('role', 'cast');
const width = Number(arg('width', 1280));
const height = Number(arg('height', 800));
const selector = arg('click');
const clickAll = process.argv.includes('--all-clicks');
const name = arg('name', selector ? 'panel' : 'window');
const outDir = path.resolve(arg('out', path.join(OUT_DIR, 'app-shots')));

const session = await launchRole(role, {
  width, height, port: Number(arg('port', 9800)), settleMs: 5000, userDataSuffix: `-shot-${name}`,
});

try {
  if (selector) {
    const clicked = await session.evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      nodes.forEach((n) => n.click());
      return nodes.length;
    })()`);
    console.log(`点击 ${selector} → 命中 ${clicked} 个元素${clickAll ? '（全部）' : ''}`);
    await sleep(900);
  }

  const state = await session.evaluate(`(() => {
    const open = [...document.querySelectorAll('.panel')].filter((p) => !p.hidden).map((p) => p.getAttribute('aria-label'));
    const picker = document.querySelector('.picker');
    return {
      openPanels: open,
      pickerRows: picker ? [...picker.querySelectorAll('.picker-row')].map((r) => r.querySelector('.picker-label').textContent + ':' + [...r.querySelectorAll('button')].map((b) => b.textContent + (b.disabled ? '(禁用)' : '') + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(',')) : null,
      mirrorButtons: [...document.querySelectorAll('[aria-label*="镜像"]')].map((b) => b.getAttribute('aria-label') + '=' + b.getAttribute('aria-pressed')),
      summary: (document.querySelector('.picker-summary .chip') || {}).textContent || '',
    };
  })()`);

  const file = path.join(outDir, `${role}-${name}.png`);
  const bytes = await session.screenshot(file);
  console.log(`打开的浮层: ${state.openPanels.join(', ') || '无'}`);
  if (state.pickerRows) for (const row of state.pickerRows) console.log(`  规格选择 ${row}`);
  if (state.summary) console.log(`  当前组合: ${state.summary}`);
  if (state.mirrorButtons.length) console.log(`  镜像开关: ${state.mirrorButtons.join('  ')}`);
  console.log(`截图: ${path.relative(process.cwd(), file)}  (${(bytes / 1024).toFixed(0)} KB)`);
} catch (err) {
  console.error('失败:', err.message);
  process.exitCode = 1;
} finally {
  await session.close();
}
process.exit(process.exitCode ?? 0);
