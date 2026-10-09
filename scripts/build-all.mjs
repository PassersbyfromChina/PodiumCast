#!/usr/bin/env node
/**
 * Orchestrates everything that can be built on the current platform.
 *
 *   node scripts/build-all.mjs            # web + desktop + Windows installers (+ APKs if the
 *                                         # Android toolchain is present, + dmg on macOS)
 *   node scripts/build-all.mjs --only=web,windows
 *
 * The macOS step is a no-op off darwin by design: the .dmg is produced by the GitHub Actions
 * workflow in .github/workflows/build.yml. See scripts/build-macos.mjs for why.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DELIVERABLES } from './lib/build-common.mjs';
import { buildDesktop } from './build-desktop.mjs';
import { buildWindows } from './build-windows.mjs';
import { buildMacos } from './build-macos.mjs';
import { buildAndroid } from './build-android.mjs';

const started = Date.now();
const only = (() => {
  const hit = process.argv.find((a) => a.startsWith('--only='));
  return hit ? new Set(hit.slice('--only='.length).split(',').map((s) => s.trim())) : null;
})();
const wants = (step) => !only || only.has(step);

const summary = [];

async function androidToolchainPresent() {
  try {
    const text = await fs.readFile(path.join(os.homedir(), '.podiumcast-tools', 'env.txt'), 'utf8');
    return text.includes('ANDROID_HOME=');
  } catch { return Boolean(process.env.ANDROID_HOME && process.env.JAVA_HOME) }
}

if (wants('desktop')) {
  console.log('\n=== 1/4 desktop shell (Electron main + preload + renderers) ===');
  await buildDesktop({ minify: true });
}

if (wants('windows')) {
  console.log('\n=== 2/4 Windows installers (x64 / x32 / arm, Cast + Stage) ===');
  summary.push(...await buildWindows({ minify: false }));
}

if (wants('android')) {
  if (await androidToolchainPresent()) {
    console.log('\n=== 3/4 Android APKs (Cast + Stage) ===');
    summary.push(...await buildAndroid());
  } else {
    console.log('\n=== 3/4 Android APKs — skipped ===');
    console.log('  未检测到 Android 工具链，请先运行：');
    console.log('  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/toolchain/bootstrap-android.ps1');
  }
}

if (wants('macos')) {
  console.log('\n=== 4/4 macOS dmg ===');
  const produced = await buildMacos({});
  summary.push(...produced);
}

console.log(`\n=== done in ${((Date.now() - started) / 1000).toFixed(0)}s ===`);
for (const f of summary) {
  const st = await fs.stat(path.join(DELIVERABLES, f)).catch(() => null);
  console.log(`  ${st ? '✓' : '·'} ${f}${st ? `  ${(st.size / 1024 / 1024).toFixed(1)} MB` : ''}`);
}
console.log(`\n产物目录：${DELIVERABLES}`);
