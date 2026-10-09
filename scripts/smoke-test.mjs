#!/usr/bin/env node
/**
 * Runs the end-to-end smoke test (scripts/tests/smoke.ts).
 *
 * The test imports the TypeScript sources directly, so they are bundled with esbuild into a
 * throwaway ESM file first — Node cannot resolve this project's extensionless TS imports on
 * its own, and bundling also proves the sources build for the `node` platform.
 */
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALIASES, OUT_DIR, ROOT } from './lib/build-common.mjs';

const outFile = path.join(OUT_DIR, 'smoke.mjs');
await fs.mkdir(OUT_DIR, { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'tests', 'smoke.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  alias: ALIASES,
  logLevel: 'warning',
  banner: {
    // `ws` is CommonJS; an ESM bundle needs a real require() for its dynamic bits.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
if (result.errors.length) process.exit(1);

const child = spawn(process.execPath, [outFile], { stdio: 'inherit', cwd: ROOT });
child.on('close', (code) => { process.exitCode = code ?? 1 });
