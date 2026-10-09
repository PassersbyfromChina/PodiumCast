#!/usr/bin/env node
/**
 * Builds the two macOS installers:
 *   PodiumCast-Cast-macos-installer.dmg
 *   PodiumCast-Stage-macos-installer.dmg
 *
 * ## Why this refuses to run on Windows/Linux
 *
 * A `.dmg` is an HFS+/APFS disk image. Producing one requires `hdiutil` and `codesign`, both
 * of which exist only on macOS — no third-party tool reproduces them faithfully, and an
 * unsigned image built by a work-alike would still be rejected by Gatekeeper on the target
 * machine. So this script builds only on darwin, and on every other platform the CI workflow
 * in .github/workflows/build.yml does the job on a `macos-14` runner instead.
 *
 * Both roles are built as **universal** binaries (x64 + arm64 merged by @electron/universal),
 * which is why there is one dmg per role rather than one per architecture.
 *
 * Usage: node scripts/build-macos.mjs [--role cast|stage] [--arch universal|x64|arm64]
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DELIVERABLES, DESKTOP_DIR, OUT_DIR, ROOT, artifactPrefix } from './lib/build-common.mjs';
import { builderConfig } from './lib/builder-config.mjs';
import { buildDesktop } from './build-desktop.mjs';

const electronBuilderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [electronBuilderCli, ...args], {
      cwd: DESKTOP_DIR, stdio: 'inherit', env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`electron-builder exited ${code}`))));
  });
}

export async function buildMacos({ roleFilter, arch = 'universal', minify = true } = {}) {
  if (process.platform !== 'darwin') {
    const message = [
      'macOS 的 .dmg 只能在 macOS 上构建（需要 hdiutil 与 codesign）。',
      '请使用仓库里的 GitHub Actions 工作流：.github/workflows/build.yml 会在 macos-14 runner 上产出两个 dmg，',
      '或者在一台 Mac 上重新运行 `npm run build:macos`。',
    ].join('\n');
    console.log(message);
    if (process.env.PODIUMCAST_ALLOW_NON_MAC !== '1') return [];
  }

  await fs.mkdir(DELIVERABLES, { recursive: true });
  await buildDesktop({ minify });

  const roles = roleFilter ? [roleFilter] : ['cast', 'stage'];
  const produced = [];
  for (const role of roles) {
    const configDir = path.join(OUT_DIR, `builder-${role}-mac`);
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'electron-builder.json');
    await fs.writeFile(configPath, JSON.stringify(builderConfig(role, { arch, archLabel: 'macos', outDir: DELIVERABLES, targets: { mac: [{ target: 'dmg', arch: [arch] }] } }), null, 2), 'utf8');

    console.log(`\n=== ${artifactPrefix(role)}-macos-installer.dmg ===`);
    await run(['--mac', '--config', configPath], {
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    });
    produced.push(`${artifactPrefix(role)}-macos-installer.dmg`);
  }
  return produced;
}

if (process.argv[1]?.endsWith('build-macos.mjs')) {
  const arg = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.split('=')[1];
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
  };
  const produced = await buildMacos({
    roleFilter: arg('role'),
    arch: arg('arch') ?? 'universal',
    minify: !process.argv.includes('--no-minify'),
  }).catch((err) => { console.error(err.message ?? err); process.exitCode = 1 });
  for (const f of produced ?? []) console.log(`  ✓ ${f}`);
}
