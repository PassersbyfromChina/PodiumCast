#!/usr/bin/env node
/**
 * Runs one role in Electron with live rebuilds.
 *
 *   npm run dev:cast
 *   npm run dev:stage
 *
 * The renderer bundle is rebuilt on every change; the Electron process is restarted by hand
 * (Ctrl+C then re-run) because the main-process bundle is not hot-swappable without extra
 * tooling — and a camera app that silently swaps its capture pipeline mid-recording would be
 * worse than one that makes you press Enter.
 */
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALIASES, DESKTOP_DIR, UI_SRC, banner, require } from './lib/build-common.mjs';
import { buildDesktop } from './build-desktop.mjs';

const role = process.argv[2] === 'stage' ? 'stage' : 'cast';
const dist = path.join(DESKTOP_DIR, 'dist');

await buildDesktop({ minify: false, roles: ['cast', 'stage'] });

const ctx = await esbuild.context({
  entryPoints: [path.join(UI_SRC, `${role}.ts`)],
  outfile: path.join(dist, 'renderer', role, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: 'inline',
  alias: ALIASES,
  banner: { js: banner(role) },
  logLevel: 'info',
});
await ctx.watch();
console.log(`watching ${role} renderer sources — edit packages/ui/src and reload the window`);

const electron = require('electron');
const child = spawn(electron, [DESKTOP_DIR], {
  stdio: 'inherit',
  env: { ...process.env, PODIUMCAST_ROLE: role, PODIUMCAST_WINDOWED: '1', ELECTRON_ENABLE_LOGGING: '1' },
});
child.on('close', async (code) => { await ctx.dispose(); process.exitCode = code ?? 0 });
