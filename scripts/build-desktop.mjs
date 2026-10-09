#!/usr/bin/env node
/**
 * Bundles the Electron shell: main process, preload, and both renderer bundles.
 *
 * Output layout (what electron-builder packages):
 *   apps/desktop/dist/main.js
 *   apps/desktop/dist/preload.js
 *   apps/desktop/dist/renderer/cast/{index.html,app.js,app.css}
 *   apps/desktop/dist/renderer/stage/{index.html,app.js,app.css}
 */
import * as esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALIASES, APP_VERSION, DESKTOP_DIR, banner, reportResult } from './lib/build-common.mjs';
import { buildWeb } from './lib/build-web.mjs';

export async function buildDesktop({ minify = true, roles = ['cast', 'stage'] } = {}) {
  const dist = path.join(DESKTOP_DIR, 'dist');
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    sourcemap: false,
    legalComments: 'none',
    alias: ALIASES,
    logLevel: 'silent',
    minify,
    banner: { js: banner('desktop') },
    // `electron` is provided by the runtime; the other two are ws's optional native
    // accelerators, absent in this build and safely skipped by ws at require() time.
    external: ['electron', 'bufferutil', 'utf-8-validate'],
  };

  const mainResult = await esbuild.build({
    ...common,
    entryPoints: [path.join(DESKTOP_DIR, 'src', 'main.ts')],
    outfile: path.join(dist, 'main.js'),
  });
  reportResult('desktop/main', mainResult);

  const preloadResult = await esbuild.build({
    ...common,
    entryPoints: [path.join(DESKTOP_DIR, 'src', 'preload.ts')],
    outfile: path.join(dist, 'preload.js'),
  });
  reportResult('desktop/preload', preloadResult);

  for (const role of roles) {
    await buildWeb({ role, outDir: path.join(dist, 'renderer', role), minify });
    console.log(`  · renderer/${role} -> ${path.relative(process.cwd(), path.join(dist, 'renderer', role))}`);
  }

  // electron-builder reads version/podiumcastRole from this manifest at package time.
  const pkgPath = path.join(DESKTOP_DIR, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.version = APP_VERSION;
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  console.log(`PodiumCast desktop shell built (${APP_VERSION})`);
  return dist;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-desktop.mjs')) {
  await buildDesktop({ minify: !process.argv.includes('--no-minify') });
}
