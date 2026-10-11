#!/usr/bin/env node
/**
 * Layout regression harness.
 *
 * The Cast's control surface is placed by arithmetic — measure the letterbox the recording
 * aspect leaves on screen, then put the buttons in the black band. That arithmetic is only as
 * good as the smallest and largest viewports it is exercised against, so this script boots the
 * real Electron shell at a spread of sizes (including phone-landscape and a short 16:10
 * window) and measures what actually landed on screen:
 *
 *   - does the control surface overflow its own box?
 *   - is any visible control clipped by its container, or pushed off-screen entirely?
 *   - does the preview still have a picture, and the right shape?
 *
 * Exits non-zero when a size regresses, so it can gate a release the same way the smoke test
 * does.
 *
 *   node scripts/diagnose-layout.mjs
 *   node scripts/diagnose-layout.mjs --role cast --sizes 800x360,1280x720
 *   node scripts/diagnose-layout.mjs --shots            # also write PNGs
 */
import path from 'node:path';
import { OUT_DIR } from './lib/build-common.mjs';
import { LAYOUT_PROBE, launchRole, sleep, summarizeLayout } from './lib/cdp.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
};

/** Realistic landscape viewports: phone, small phone, phablet, laptop, short laptop, 1080p. */
const DEFAULT_SIZES = [
  '780x360',   // 手机横屏（最常见）
  '640x360',   // 小屏手机横屏
  '1024x600',  // 平板/上网本
  '1280x720',  // 16:9 笔记本
  '1267x684',  // 16:10 窗口（Windows 上实测出问题的那一档）
  '1920x1080',
];

const sizes = (arg('sizes') ?? DEFAULT_SIZES.join(',')).split(',').map((s) => {
  const [w, h] = s.split('x').map(Number);
  return { w, h };
});
const roles = arg('role') ? [arg('role')] : ['cast', 'stage'];
const writeShots = process.argv.includes('--shots');
const shotDir = path.resolve(arg('shot-dir', path.join(OUT_DIR, 'layout-shots')));

const results = [];
let port = 9400;

for (const role of roles) {
  for (const { w, h } of sizes) {
    const label = `${role} ${w}×${h}`;
    let session = null;
    try {
      // eslint-disable-next-line no-await-in-loop -- one window at a time keeps measurements clean
      session = await launchRole(role, {
        width: w,
        height: h,
        port: port++,
        settleMs: 4200,
        // A distinct user-data dir per size: Electron locks it, and reusing one across rapid
        // restarts fails with EBUSY before the previous instance has released it.
        userDataSuffix: `-${w}x${h}`,
      });
      // eslint-disable-next-line no-await-in-loop -- Ditto.
      const probe = await session.evaluate(LAYOUT_PROBE);

      const problems = [];
      if (probe.barOverflow) problems.push(`控件条内容溢出（scroll ${probe.barClient?.sh} > client ${probe.barClient?.h}）`);
      if (probe.clippedCount > 0) problems.push(`${probe.clippedCount} 个控件被容器裁切`);
      if (probe.invisibleCount > 0) problems.push(`${probe.invisibleCount} 个控件不可见（0 尺寸）`);
      if (!probe.stageRect || probe.stageRect.w < 80 || probe.stageRect.h < 60) problems.push('预览区域过小');
      if (role === 'cast') {
        const v = probe.previewVideo;
        if (!v || v.videoWidth === 0 || v.readyState < 2) problems.push('预览视频流未就绪');
        const controls = probe.controls.filter((c) => c.visible);
        if (controls.length < 4) problems.push(`可见控件只有 ${controls.length} 个`);
        for (const c of probe.controls) {
          if (c.visible && (c.rect.w < 16 || c.rect.h < 16)) problems.push(`控件「${c.label}」尺寸异常 ${c.rect.w}×${c.rect.h}`);
        }
      } else {
        if (probe.corners < 2) problems.push(`角标图标只有 ${probe.corners} 个`);
        const visibleButtons = probe.controls.filter((c) => c.visible && (c.cls.includes('corner-toggle'))).length;
        if (visibleButtons < 2) problems.push('左下/右下角标不可见');
      }

      const rects = probe.controls.filter((c) => c.visible).map((c) => c.rect);
      const outside = rects.filter((r) => r.x < -1 || r.y < -1 || r.x + r.w > probe.viewport.w + 1 || r.y + r.h > probe.viewport.h + 1);
      if (outside.length) problems.push(`${outside.length} 个控件跑出窗口`);

      results.push({ label, probe, problems });
      console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${label.padEnd(18)}  ${summarizeLayout(probe)}`);
      for (const p of problems) console.log(`        · ${p}`);

      if (writeShots) {
        const file = path.join(shotDir, `${role}-${w}x${h}.png`);
        // eslint-disable-next-line no-await-in-loop -- Ditto.
        const bytes = await session.screenshot(file);
        console.log(`        · 截图 ${path.relative(process.cwd(), file)} (${(bytes / 1024).toFixed(0)} KB)`);
      }
    } catch (err) {
      results.push({ label, probe: null, problems: [`启动失败：${err.message}`] });
      console.log(`FAIL  ${label.padEnd(18)}  启动失败：${err.message}`);
      if (session) console.log(`        · stderr: ${session.stderr().trim().split('\n').slice(-2).join(' | ')}`);
    } finally {
      if (session) {
        // eslint-disable-next-line no-await-in-loop -- Ditto.
        await session.close();
        // eslint-disable-next-line no-await-in-loop -- Give the OS a moment to release the debugging port.
        await sleep(500);
      }
    }
  }
}

const failed = results.filter((r) => r.problems.length);
console.log(`\n${results.length - failed.length}/${results.length} 个尺寸通过`);
if (failed.length) {
  console.log('\n失败明细：');
  for (const f of failed) console.log(`  ${f.label}: ${f.problems.join('；')}`);
  process.exitCode = 1;
}
process.exit(failed.length ? 1 : 0);
