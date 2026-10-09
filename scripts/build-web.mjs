#!/usr/bin/env node
/**
 * Builds just the web bundles (no Electron packaging). Useful for iterating on UI, and it is
 * what the Android build consumes.
 *
 * Usage: node scripts/build-web.mjs [--role cast|stage] [--out <dir>] [--no-minify]
 */
import path from 'node:path';
import { OUT_DIR } from './lib/build-common.mjs';
import { buildWeb } from './lib/build-web.mjs';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};

const role = arg('role');
const roles = role ? [role] : ['cast', 'stage'];
const minify = !process.argv.includes('--no-minify');

for (const r of roles) {
  const out = arg('out') ? path.resolve(arg('out'), r) : path.join(OUT_DIR, 'web', r);
  await buildWeb({ role: r, outDir: out, minify });
  console.log(`  · ${r} -> ${out}`);
}
console.log('web bundles built');
