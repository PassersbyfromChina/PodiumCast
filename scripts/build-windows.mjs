#!/usr/bin/env node
/**
 * Builds the six Windows installers:
 *   PodiumCast-Cast-{x64,x32,arm}-installer.exe
 *   PodiumCast-Stage-{x64,x32,arm}-installer.exe
 *
 * All six come from one app directory; only the electron-builder config differs
 * (see scripts/lib/builder-config.mjs). Artifacts land in 交付物/.
 *
 * Usage: node scripts/build-windows.mjs [--arch x64|ia32|arm64] [--role cast|stage] [--no-minify]
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DELIVERABLES, DESKTOP_DIR, OUT_DIR, ROOT, WIN_ARCHES, artifactPrefix, require } from './lib/build-common.mjs';
import { builderConfig } from './lib/builder-config.mjs';
import { WIN_TARGETS, ensureElectronDist } from './lib/electron-dist.mjs';
import { buildDesktop } from './build-desktop.mjs';

/** The Electron release the installers embed — pinned in the root package.json. */
const ELECTRON_VERSION = require(path.join(ROOT, 'package.json')).devDependencies.electron.replace(/^[^\d]*/, '');

const electronBuilderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [electronBuilderCli, ...args], {
      cwd: DESKTOP_DIR,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`electron-builder exited ${code}`))));
  });
}

export async function buildWindows({ archFilter, roleFilter, minify = true } = {}) {
  await fs.mkdir(DELIVERABLES, { recursive: true });
  await buildDesktop({ minify });

  const roles = roleFilter ? [roleFilter] : ['cast', 'stage'];
  const arches = archFilter ? WIN_ARCHES.filter((a) => a.arch === archFilter) : WIN_ARCHES;
  const produced = [];

  // Fetch the Electron distributions ourselves when a mirror is configured: @electron/get
  // resets on unreliable links and restarts the 150 MB transfer from zero every time.
  const targets = arches.flatMap(({ arch }) => WIN_TARGETS[arch] ?? []);
  const electronDist = await ensureElectronDist(ELECTRON_VERSION, targets).catch((err) => {
    console.warn(`  ! 预取 Electron 失败，交给 electron-builder 自行下载：${err.message}`);
    return null;
  });

  for (const role of roles) {
    for (const { arch, label } of arches) {
      // electron-builder needs a writable output dir for its unpacked tree and block map;
      // only the finished installer is copied into 交付物/ so the deliverable folder stays
      // exactly the twelve items listed in 说明\交付物.xlsx.
      const stageDir = path.join(OUT_DIR, `nsis-${role}-${label}`);
      await fs.rm(stageDir, { recursive: true, force: true });
      await fs.mkdir(stageDir, { recursive: true });
      const configPath = path.join(stageDir, 'electron-builder.json');
      const config = builderConfig(role, { arch, archLabel: label, outDir: stageDir });
      if (electronDist) config.electronDist = electronDist;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      const artifact = `${artifactPrefix(role)}-${label}-installer.exe`;
      console.log(`\n=== ${artifact} ===`);
      await run(['--win', '--config', configPath, `--${arch}`], {
        // electron-builder downloads NSIS + winCodeSign from GitHub Releases; the mirror in
        // .npmrc is honoured, and this env var is the belt-and-braces equivalent.
        ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR
          ?? 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/',
      });
      await fs.copyFile(path.join(stageDir, artifact), path.join(DELIVERABLES, artifact));
      await fs.rm(stageDir, { recursive: true, force: true });
      produced.push(artifact);
    }
  }

  console.log('\nWindows artifacts:');
  for (const f of produced) {
    const full = path.join(DELIVERABLES, f);
    const st = await fs.stat(full).catch(() => null);
    console.log(`  ${st ? '✓' : 'x'} ${f}${st ? `  (${(st.size / 1024 / 1024).toFixed(1)} MB)` : ''}`);
  }
  return produced;
}

if (process.argv[1]?.endsWith('build-windows.mjs')) {
  const arg = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.split('=')[1];
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
  };
  await buildWindows({
    archFilter: arg('arch'),
    roleFilter: arg('role'),
    minify: !process.argv.includes('--no-minify'),
  }).catch((err) => { console.error(err.message ?? err); process.exitCode = 1 });
}

export { require };
