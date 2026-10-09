/**
 * Pre-fetches the Electron distribution zips via a mirror.
 *
 * ## Why this exists
 *
 * electron-builder 26 downloads Electron through `@electron/get`, which is reliable on a good
 * network and *not* reliable on the ones this project is built on: a 150 MB fetch through
 * `got` died with `read ECONNRESET` twice in a row, and each retry had to start over. curl
 * against the same mirror sustains ~11 MB/s and resumes.
 *
 * electron-builder accepts `electronDist` pointing at a directory that contains
 * `electron-v<version>-<platform>-<arch>.zip`, so we fetch the zips ourselves, verify every
 * one against the publisher's `SHASUMS256.txt`, and hand the directory over. When no mirror is
 * configured (CI, or a good network) this returns `null` and electron-builder downloads
 * normally — the fast path is never the only path.
 *
 * Verification is not optional: a silently corrupted or substituted Electron binary would be
 * shipped inside every installer.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from './build-common.mjs';

const DEFAULT_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/';

/** Where the zips live. Kept out of the repository; see .gitignore. */
export const ELECTRON_DIST_DIR = path.join(OUT_DIR, 'electron-dist');

function mirrorUrl() {
  const configured = process.env.ELECTRON_MIRROR
    ?? process.env.npm_config_electron_mirror
    ?? process.env.npm_package_config_electron_mirror
    ?? DEFAULT_MIRROR;
  const url = configured.endsWith('/') ? configured : `${configured}/`;
  // A GitHub URL means "no mirror": let electron-builder handle it with its own retry logic.
  if (/^https?:\/\/(www\.)?github\.com\//.test(url)) return null;
  return url;
}

function curl(url, dest, { resume = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-L', '--fail', '--ssl-no-revoke', '--retry', '8', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '30', '-sS', '-o', dest];
    if (resume) args.push('-C', '-');
    args.push(url);
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d) });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`curl ${code}: ${stderr.trim() || url}`))));
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

/** Parses `SHASUMS256.txt` into `{ filename: sha256 }`. */
function parseShasums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

async function fetchShasums(mirror, version) {
  const url = `${mirror}${version}/SHASUMS256.txt`;
  const tmp = path.join(ELECTRON_DIST_DIR, `.shasums-${version}.txt`);
  try {
    await curl(url, tmp);
    return parseShasums(await fs.readFile(tmp, 'utf8'));
  } catch {
    return null;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * Ensures `electron-v<version>-<platform>-<arch>.zip` exists locally.
 * Returns the directory to pass as `electronDist`, or `null` when the mirror should not be used.
 */
export async function ensureElectronDist(version, targets, { log = console.log } = {}) {
  const mirror = mirrorUrl();
  if (!mirror) return null;
  await fs.mkdir(ELECTRON_DIST_DIR, { recursive: true });

  const shasums = await fetchShasums(mirror, version);
  if (!shasums) {
    log('  ! 未能取得 SHASUMS256.txt，将跳过校验（仅体积检查）');
  }

  for (const { platform, arch } of targets) {
    const filename = `electron-v${version}-${platform}-${arch}.zip`;
    const dest = path.join(ELECTRON_DIST_DIR, filename);
    const expected = shasums?.get(filename);

    let ok = false;
    try {
      const st = await fs.stat(dest);
      // 100 MB floor: every supported Electron build is far larger, so a small file is a
      // truncated download from a previous interrupted run.
      if (st.size > 100 * 1024 * 1024) {
        if (!expected) { ok = true } else {
          const actual = await sha256(dest);
          ok = actual === expected;
          if (!ok) log(`  ! ${filename} 校验失败，重新下载`);
        }
      }
    } catch { /* not cached yet */ }

    if (ok) { log(`  · ${filename} 已缓存`); continue }

    log(`  · 下载 ${filename} …`);
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- retries are inherently sequential
        await curl(`${mirror}${version}/${filename}`, dest, { resume: attempt > 1 });
        const st = await fs.stat(dest);
        if (st.size <= 100 * 1024 * 1024) throw new Error(`文件过小：${st.size} 字节`);
        if (expected) {
          const actual = await sha256(dest);
          if (actual !== expected) throw new Error('sha256 校验失败');
        }
        ok = true;
        log(`    ✓ ${(st.size / 1024 / 1024).toFixed(1)} MB${expected ? '（sha256 已校验）' : ''}`);
      } catch (err) {
        log(`    x 第 ${attempt} 次失败：${err.message}`);
        if (attempt === 3) throw err;
      }
    }
  }
  return ELECTRON_DIST_DIR;
}

/** Targets for a Windows build, keyed by the electron-builder arch name. */
export const WIN_TARGETS = {
  x64: [{ platform: 'win32', arch: 'x64' }],
  ia32: [{ platform: 'win32', arch: 'ia32' }],
  arm64: [{ platform: 'win32', arch: 'arm64' }],
};
