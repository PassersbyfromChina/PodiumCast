/**
 * Shared build constants and esbuild plumbing.
 *
 * The whole project is bundled with esbuild rather than tsc: it is one binary, needs no
 * configuration per target, and lets the *same* TypeScript sources become an Electron main
 * process bundle (CJS, node platform), a renderer bundle (IIFE, browser platform) and an
 * Android WebView bundle. Type checking is a separate `npm run typecheck` step so a type
 * error never blocks an otherwise valid build during iteration.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CORE_SRC = path.join(ROOT, 'packages', 'core', 'src');
export const UI_SRC = path.join(ROOT, 'packages', 'ui', 'src');
export const DESKTOP_DIR = path.join(ROOT, 'apps', 'desktop');
export const ANDROID_DIR = path.join(ROOT, 'apps', 'android');
export const DELIVERABLES = path.join(ROOT, '交付物');
export const OUT_DIR = path.join(ROOT, '.podiumcast-out');

/** esbuild alias table — keeps `@podiumcast/*` imports working without a bundler plugin. */
export const ALIASES = {
  '@podiumcast/core/node': path.join(CORE_SRC, 'node', 'index.ts'),
  '@podiumcast/core': path.join(CORE_SRC, 'index.ts'),
  '@podiumcast/ui': path.join(UI_SRC, 'index.ts'),
};

export const APP_VERSION = require(path.join(ROOT, 'package.json')).version;
export const PRODUCTS = ['cast', 'stage'];
export const WIN_ARCHES = [
  { arch: 'x64', label: 'x64' },
  { arch: 'ia32', label: 'x32' },
  { arch: 'arm64', label: 'arm' },
];

export function productName(role) {
  return role === 'cast' ? 'PodiumCast Cast' : 'PodiumCast Stage';
}

export function artifactPrefix(role) {
  return role === 'cast' ? 'PodiumCast-Cast' : 'PodiumCast-Stage';
}

/** Post-processes esbuild's output so the console tells the truth about warnings. */
export function reportResult(label, result) {
  const warnings = result.warnings ?? [];
  const errors = result.errors ?? [];
  if (warnings.length) {
    console.warn(`  ! ${label}: ${warnings.length} warning(s)`);
    for (const w of warnings.slice(0, 5)) {
      console.warn(`      ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`);
    }
  }
  if (errors.length) {
    for (const e of errors) console.error(`  x ${label}: ${e.text}${e.location ? ` (${e.location.file}:${e.location.line})` : ''}`);
    throw new Error(`${label} 构建失败`);
  }
}

export function banner(role) {
  return `/* PodiumCast ${role === 'cast' ? 'Cast' : 'Stage'} v${APP_VERSION} — AI-generated project — MIT License */`;
}
