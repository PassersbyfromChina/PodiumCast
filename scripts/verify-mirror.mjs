#!/usr/bin/env node
/**
 * End-to-end mirror test.
 *
 * The mirror switches are the easiest feature in this project to get subtly wrong: the local
 * preview can look flipped while the streamed frames are not, or the recording can end up
 * inverted relative to what the operator saw. This test therefore checks the *pixels that
 * actually reach the big screen*, not a CSS property:
 *
 *   1. boot a Cast (synthetic test pattern) and a Stage on the same machine, so the Stage's
 *      loopback auto-discovery connects them;
 *   2. wait for the incoming frames to be painted on the Stage's canvas;
 *   3. measure a left/right colour signature of that canvas — the pattern's bars make the left
 *      third much redder than the right third;
 *   4. toggle the **Stage** mirror and assert the signature inverts (only this screen changed);
 *   5. toggle the **Cast** mirror and assert it inverts again, proving the flip travels through
 *      the encoder and the wire rather than being a local CSS transform on the Cast.
 *
 *   node scripts/verify-mirror.mjs
 */
import { launchRole, sleep } from './lib/cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * Left/right colour signature of the Stage canvas.
 * Positive ⇒ the bright grey bar is on the left; negative ⇒ mirrored.
 */
const SIGNATURE = `(() => {
  const c = document.querySelector('canvas.preview');
  if (!c || !c.width) return { error: '画布不存在' };
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  const strip = Math.max(2, Math.round(h * 0.25));
  const band = Math.max(4, Math.round(w * 0.12));
  const y0 = Math.round((h - strip) / 2);
  const read = (x, bw) => {
    const d = ctx.getImageData(x, y0, bw, strip).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
    const n = d.length / 4;
    return { r: r / n, g: g / n, b: b / n };
  };
  const left = read(0, band);
  const right = read(w - band, band);
  return {
    w, h,
    left, right,
    // Grey-vs-dark separation: large positive when the pattern is the right way round.
    signature: Math.round((left.r + left.g + left.b) - (right.r + right.g + right.b)),
    nonBlack: Math.round(Math.max(left.r + left.g + left.b, right.r + right.g + right.b)),
  };
})()`;

/** Waits until the Stage has painted a frame with actual content on it. */
async function waitForPicture(stage, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling a live canvas is inherently sequential
    last = await stage.evaluate(SIGNATURE);
    if (!last.error && last.nonBlack > 30) return last;
    // eslint-disable-next-line no-await-in-loop -- ditto
    await sleep(500);
  }
  return last;
}

const clickByLabel = (label) => `(() => {
  const el = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!el) return 0;
  el.click();
  return 1;
})()`;

const cast = await launchRole('cast', { width: 1000, height: 600, port: 9540, settleMs: 6000, userDataSuffix: '-mirror' });
const stage = await launchRole('stage', { width: 1000, height: 600, port: 9541, settleMs: 6000, userDataSuffix: '-mirror' });

try {
  const before = await waitForPicture(stage);
  if (before.error) throw new Error(before.error);
  check('大屏端收到并绘制了预览画面', before.nonBlack > 30, `画布 ${before.w}×${before.h} 亮度=${before.nonBlack}`);
  check('初始画面未镜像（左侧更亮）', before.signature > 60, `左右亮度差=${before.signature}`);
  const baseSignature = before.signature;

  // --- Stage-side mirror -----------------------------------------------------------------
  const hitStage = await stage.evaluate(clickByLabel('显示镜像'));
  check('大屏端找到「显示镜像」按钮', hitStage === 1);
  await sleep(1200);
  const afterStage = await stage.evaluate(SIGNATURE);
  check('大屏端镜像后画面翻转', afterStage.signature < -60, `左右亮度差=${afterStage.signature}`);
  check('大屏端镜像只翻自己（拍摄端未同步变化）',
    Math.abs(afterStage.signature + baseSignature) < Math.abs(baseSignature) * 0.6,
    `${baseSignature} → ${afterStage.signature}`);

  // Back to normal so the next step isolates the Cast's own switch.
  await stage.evaluate(clickByLabel('显示镜像'));
  await sleep(1200);
  const restored = await stage.evaluate(SIGNATURE);
  check('大屏端可以切回未镜像', restored.signature > 60, `左右亮度差=${restored.signature}`);

  // --- Cast-side mirror ------------------------------------------------------------------
  const hitCast = await cast.evaluate(clickByLabel('镜像预览'));
  check('拍摄端找到「镜像预览」按钮', hitCast === 1);
  await sleep(2500);
  const afterCast = await stage.evaluate(SIGNATURE);
  check('拍摄端开启镜像后，推流画面在大屏上翻转', afterCast.signature < -60,
    `左右亮度差=${afterCast.signature}（说明翻转发生在编码前，而不是拍摄端本机的 CSS 变换）`);

  // The Cast's own preview must agree with what it is sending.
  const castView = await cast.evaluate(`(() => {
    const v = document.querySelector('video.preview');
    return v ? v.style.transform : '(no video)';
  })()`);
  check('拍摄端本机预览同样翻转', /scale\(\s*-/.test(castView), `transform=${castView}`);

  await cast.evaluate(clickByLabel('镜像预览'));
  await sleep(2500);
  const final = await stage.evaluate(SIGNATURE);
  check('拍摄端可以切回未镜像', final.signature > 60, `左右亮度差=${final.signature}`);
} catch (err) {
  check('镜像端到端测试', false, err.message);
} finally {
  await cast.close();
  await stage.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
