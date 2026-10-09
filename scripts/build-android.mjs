#!/usr/bin/env node
/**
 * Builds the two Android APKs:
 *   PodiumCast-Cast.apk
 *   PodiumCast-Stage.apk
 *
 * ## Toolchain
 *
 * The machine may have no Java and no Android SDK. `scripts/toolchain/bootstrap-android.ps1`
 * provisions both into `~/.podiumcast-tools` and writes `env.txt`; this script reads that file
 * (or honours an already-set JAVA_HOME/ANDROID_HOME) before invoking Gradle.
 *
 * ## Why product flavours instead of two projects
 *
 * `android/app/build.gradle` declares a `role` flavour dimension. Cast and Stage differ only
 * in applicationId, app label and which web bundle is packed into `assets/public`, so one
 * `assembleRelease` run emits both APKs — roughly half the time and none of the drift that
 * two parallel Gradle projects would accumulate.
 *
 * Usage: node scripts/build-android.mjs [--role cast|stage] [--debug] [--no-minify]
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANDROID_DIR, DELIVERABLES, ROOT, artifactPrefix } from './lib/build-common.mjs';
import { buildWeb } from './lib/build-web.mjs';

const ANDROID_PROJECT = path.join(ANDROID_DIR, 'android');

/**
 * Windows environment blocks spell the variable `Path`, not `PATH`. Spreading `process.env`
 * copies whatever casing the OS used, so assigning `env.PATH` would add a *second*,
 * differently-cased key and the spawned `cmd.exe` would keep the original — which is how
 * `npx.cmd` ends up "not recognized as an internal or external command".
 */
function envKey(env, name) {
  return Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}

function prependPath(env, dir) {
  const key = envKey(env, 'PATH');
  env[key] = `${dir}${path.delimiter}${env[key] ?? ''}`;
}

/** Reads the toolchain env written by scripts/toolchain/bootstrap-android.ps1. */
async function toolchainEnv() {
  const env = { ...process.env };
  const envFile = path.join(os.homedir(), '.podiumcast-tools', 'env.txt');
  let wrote = false;
  try {
    const text = await fs.readFile(envFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.+)$/.exec(line.trim());
      if (m) { env[m[1]] = m[2]; wrote = true }
    }
  } catch { /* no bootstrap yet: fall back to whatever is on the machine */ }

  if (env.JAVA_HOME) prependPath(env, path.join(env.JAVA_HOME, 'bin'));
  if (env.ANDROID_HOME) {
    env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
    prependPath(env, path.join(env.ANDROID_HOME, 'platform-tools'));
  }
  env.PODIUMCAST_TOOLCHAIN_FROM_FILE = wrote ? '1' : '0';
  return env;
}

/**
 * Spawns a child process.
 *
 * `shell` is opt-in per call: Node refuses to spawn a `.cmd`/`.bat` without it on Windows, but
 * a shell re-parses the command line, so an absolute path containing a space (`C:\Program
 * Files\nodejs\node.exe`) must NOT go through one. Node itself is spawned directly; only
 * Gradle's batch wrapper uses the shell.
 */
function run(cmd, args, { cwd, env, shell = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell, windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}`))));
  });
}

/** Writes a role's web bundle where the Gradle flavour expects it. */
async function stageWebAssets(role) {
  const target = path.join(ANDROID_PROJECT, 'app', 'src', role, 'assets', 'public');
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  await buildWeb({ role, outDir: target, minify: true });
  console.log(`  · www/${role} -> ${path.relative(process.cwd(), target)}`);
}

async function ensureKeystore(env) {
  const keystore = path.join(ANDROID_PROJECT, 'app', 'podiumcast.keystore');
  try { await fs.access(keystore); return keystore } catch { /* generate below */ }
  const keytool = path.join(env.JAVA_HOME ?? '', 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  console.log('  · generating a self-signed APK keystore (debug-grade, not for the Play Store)');
  await run(keytool, [
    '-genkeypair', '-v',
    '-keystore', keystore,
    '-alias', 'podiumcast',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
    '-storepass', 'podiumcast', '-keypass', 'podiumcast',
    '-dname', 'CN=PodiumCast, OU=AI-generated, O=PassersbyfromChina, L=Shenzhen, C=CN',
  ], { cwd: ANDROID_PROJECT, env });
  return keystore;
}

export async function buildAndroid({ roleFilter, debug = false, minify = true } = {}) {
  const env = await toolchainEnv();
  if (!env.JAVA_HOME) throw new Error('未找到 JAVA_HOME：先运行 scripts/toolchain/bootstrap-android.ps1');
  if (!env.ANDROID_HOME) throw new Error('未找到 ANDROID_HOME：先运行 scripts/toolchain/bootstrap-android.ps1');

  await fs.mkdir(DELIVERABLES, { recursive: true });
  const roles = roleFilter ? [roleFilter] : ['cast', 'stage'];
  for (const role of roles) await stageWebAssets(role);

  // `cap sync` restores capacitor.config.json / capacitor.plugins.json / native-bridge.js in
  // src/main/assets. It must never write a web bundle back into src/main/assets/public, or the
  // flavour assets would collide with it at merge time.
  //
  // The CLI is invoked through Node rather than `npx`: npx resolves the registry on a miss and
  // is one more shell layer that can differ between machines.
  const capacitorCli = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
  await run(process.execPath, [capacitorCli, 'sync', 'android'], { cwd: ANDROID_DIR, env });
  await fs.rm(path.join(ANDROID_PROJECT, 'app', 'src', 'main', 'assets', 'public'), { recursive: true, force: true });

  const keystore = await ensureKeystore(env);
  void keystore;

  const variant = debug ? 'Debug' : 'Release';
  const tasks = roles.map((r) => `assemble${r[0].toUpperCase()}${r.slice(1)}${variant}`);
  console.log(`  · gradle ${tasks.join(' ')}`);
  if (process.platform === 'win32') {
    // Node refuses to spawn a `.cmd`/`.bat` without a shell; the wrapper path is relative and
    // contains no spaces, so a shell is safe here.
    await run('gradlew.bat', [...tasks, '--no-daemon', '--console=plain'], { cwd: ANDROID_PROJECT, env, shell: true });
  } else {
    // `sh gradlew` rather than `./gradlew`: the Gradle wrapper's executable bit is not
    // preserved by every checkout (it is lost entirely when the file is first committed from
    // Windows), and a first CI run died on `spawn ./gradlew EACCES` because of exactly that.
    // Invoking it through `sh` makes the build independent of the file mode.
    await run('sh', ['gradlew', ...tasks, '--no-daemon', '--console=plain'], { cwd: ANDROID_PROJECT, env });
  }

  const produced = [];
  for (const role of roles) {
    const src = path.join(ANDROID_PROJECT, 'app', 'build', 'outputs', 'apk', role, variant.toLowerCase(), `app-${role}-${variant.toLowerCase()}.apk`);
    const dest = path.join(DELIVERABLES, `${artifactPrefix(role)}.apk`);
    try {
      await fs.copyFile(src, dest);
      const st = await fs.stat(dest);
      console.log(`  ✓ ${path.basename(dest)}  (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
      produced.push(path.basename(dest));
    } catch (err) {
      console.error(`  x 未找到 APK：${src}（${String(err)}）`);
    }
  }
  void minify;
  return produced;
}

if (process.argv[1]?.endsWith('build-android.mjs')) {
  const arg = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.split('=')[1];
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
  };
  await buildAndroid({
    roleFilter: arg('role'),
    debug: process.argv.includes('--debug'),
    minify: !process.argv.includes('--no-minify'),
  }).catch((err) => { console.error(err.message ?? err); process.exitCode = 1 });
}
