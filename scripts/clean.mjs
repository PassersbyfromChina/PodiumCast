#!/usr/bin/env node
/** Removes every build artefact this project produces (never touches 交付物/ unless asked). */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ANDROID_DIR, DESKTOP_DIR, DELIVERABLES, OUT_DIR, ROOT } from './lib/build-common.mjs';

const targets = [
  path.join(DESKTOP_DIR, 'dist'),
  OUT_DIR,
  path.join(ROOT, 'dist'),
  path.join(ANDROID_DIR, 'www'),
  path.join(ANDROID_DIR, 'android', 'app', 'build'),
  path.join(ANDROID_DIR, 'android', 'build'),
  path.join(ANDROID_DIR, 'android', '.gradle'),
  path.join(ANDROID_DIR, 'android', 'app', 'src', 'main', 'assets', 'public'),
];

if (process.argv.includes('--deliverables')) targets.push(DELIVERABLES);

for (const t of targets) {
  await fs.rm(t, { recursive: true, force: true });
  console.log(`  · cleaned ${path.relative(ROOT, t) || t}`);
}
console.log('clean done');
