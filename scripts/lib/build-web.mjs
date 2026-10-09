/**
 * Builds one role's web bundle (the UI that runs in the Electron renderer or an Android
 * WebView). Shared by the desktop build, the Android build and the dev server, so all three
 * ship byte-identical UI code.
 */
import * as esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALIASES, APP_VERSION, UI_SRC, banner, reportResult } from './build-common.mjs';

export const ROLE_TITLE = { cast: 'PodiumCast Cast', stage: 'PodiumCast Stage' };

/**
 * The document both hosts load.
 *
 * The CSP is strict on purpose — `default-src 'self'` — which is only meaningful because the
 * desktop shell serves this page from `podiumcast://app/…` (a real origin) instead of
 * `file://` (an opaque one, where `'self'` matches nothing and the bundle would be blocked).
 * `podiumcast:` appears in the media directives because recorded files are streamed from
 * `podiumcast://media/<id>`, a different host on the same scheme.
 */
export function indexHtml(role, { capacitor = false } = {}) {
  const title = ROLE_TITLE[role] ?? 'PodiumCast';
  const mediaScheme = capacitor ? '' : ' podiumcast:';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#000000">
<meta name="description" content="${title} — PodiumCast 多平台摄像头投屏与拍摄控制">
<title>${title}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:${mediaScheme}; media-src 'self' blob: data:${mediaScheme}; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23000'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%23ff3b30'/%3E%3C/svg%3E">
<link rel="stylesheet" href="./app.css">
</head>
<body>
<div id="app" data-role="${role}" data-version="${APP_VERSION}"></div>
<script src="./app.js"></script>
</body>
</html>
`;
}

export async function buildWeb({ role, outDir, minify = true, sourcemap = false }) {
  if (role !== 'cast' && role !== 'stage') throw new Error(`未知角色：${role}`);
  await fs.mkdir(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [path.join(UI_SRC, `${role}.ts`)],
    outfile: path.join(outDir, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120', 'safari16'],
    minify,
    sourcemap: sourcemap ? 'linked' : false,
    legalComments: 'none',
    banner: { js: banner(role) },
    alias: ALIASES,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') },
  });
  reportResult(`web/${role}`, result);

  // `import './styles.css'` makes esbuild emit app.css beside app.js.
  await fs.writeFile(path.join(outDir, 'index.html'), indexHtml(role), 'utf8');
  return outDir;
}
