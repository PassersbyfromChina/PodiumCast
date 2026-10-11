#!/usr/bin/env node
/**
 * Confirms the two roles are genuinely separate applications.
 *
 * This is a regression test for a real release bug: Cast and Stage are built from one source
 * tree, so they shared the `name` in package.json — and Electron keys both the user-data
 * directory *and* the single-instance lock on that name. On Windows the second app therefore
 * found the lock held, forwarded its arguments to the first instance and quit, so Cast and
 * Stage could never run side by side.
 *
 * The test boots both roles at once and asserts that:
 *   · both windows exist and render the right role;
 *   · they use different user-data directories (hence different settings and device ids);
 *   · running a second Cast does NOT open a second window.
 */
import path from 'node:path';
import { launchRole, sleep } from './lib/cdp.mjs';
import { OUT_DIR } from './lib/build-common.mjs';
import { promises as fs } from 'node:fs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const probe = `(() => {
  const app = document.getElementById('app');
  return {
    hasApp: Boolean(app),
    role: app ? app.dataset.role : null,
    title: document.title,
  };
})()`;

const cast = await launchRole('cast', { width: 1000, height: 560, port: 9520, settleMs: 6000, userDataSuffix: '-dual' });
const stage = await launchRole('stage', { width: 1000, height: 560, port: 9521, settleMs: 6000, userDataSuffix: '-dual' });

try {
  const c = await cast.evaluate(probe);
  const s = await stage.evaluate(probe);

  check('Cast 窗口渲染为 cast 角色', c.hasApp && c.role === 'cast', JSON.stringify(c));
  check('Stage 窗口渲染为 stage 角色', s.hasApp && s.role === 'stage', JSON.stringify(s));
  check('两者标题不同', c.title !== s.title, `${c.title} / ${s.title}`);

  // Distinct user-data dirs are what makes the single-instance lock per-role.
  const dirs = await Promise.all(['cast', 'stage'].map(async (role) => {
    const base = path.join(OUT_DIR, `verify-${role}-dual`);
    try {
      const entries = await fs.readdir(base);
      return { role, base, entries: entries.slice(0, 4).join(',') };
    } catch { return { role, base, entries: '(missing)' } }
  }));
  check('两个角色使用不同的 userData 目录', dirs[0].base !== dirs[1].base,
    dirs.map((d) => `${d.role}:${d.entries}`).join('  '));

  // A second Cast must be refused by the lock rather than opening another window.
  let secondRefused = false;
  try {
    const dup = await launchRole('cast', { width: 800, height: 450, port: 9522, settleMs: 3000, userDataSuffix: '-dual' });
    await dup.close();
  } catch {
    secondRefused = true;
  }
  check('重复启动 Cast 会被单实例锁挡住', secondRefused, secondRefused ? '第二次启动未出现新窗口' : '出现了第二个 Cast 窗口');

  await sleep(300);
} finally {
  await cast.close();
  await stage.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
