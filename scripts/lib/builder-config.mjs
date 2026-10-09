/**
 * Electron Builder configuration, generated in code rather than kept as YAML.
 *
 * Six Windows artefacts and two macOS artefacts come out of one source tree, differing only in
 * role (Cast/Stage) and architecture. Expressing that as a function removes the copy-paste
 * that a static config would need — and guarantees the artifact names match 交付物.xlsx
 * exactly.
 */
import path from 'node:path';
import { APP_VERSION, DESKTOP_DIR, artifactPrefix, productName } from './build-common.mjs';

/** `${ext}` and friends must reach electron-builder literally, not be interpolated by JS. */
const EXT = '${ext}';

export function builderConfig(role, opts = {}) {
  const { arch = 'x64', archLabel = 'x64', outDir, targets } = opts;
  const prefix = artifactPrefix(role);
  const name = productName(role);

  const winTarget = targets?.win ?? [{ target: 'nsis', arch: [arch] }];
  const macTarget = targets?.mac ?? [{ target: 'dmg', arch: ['universal'] }];
  const linuxTarget = targets?.linux ?? [{ target: 'AppImage', arch: [arch] }];

  return {
    appId: `io.github.passersbyfromchina.podiumcast.${role}`,
    productName: name,
    executableName: prefix,
    copyright: `MIT License · 本项目由 AI 编写 (AI-generated) · PodiumCast ${APP_VERSION}`,
    directories: {
      output: outDir,
      buildResources: path.join(DESKTOP_DIR, 'build'),
    },
    files: [
      'dist/**/*',
      'package.json',
      '!**/*.map',
      '!**/*.md',
    ],
    extraMetadata: {
      // Read by apps/desktop/src/main.ts to decide which role this binary plays.
      podiumcastRole: role,
      version: APP_VERSION,
    },
    asar: true,
    compression: 'maximum',
    removePackageScripts: true,
    buildDependenciesFromSource: false,
    npmRebuild: false,
    // No production dependencies: everything (including `ws`) is bundled by esbuild.
    nodeGypRebuild: false,

    win: {
      target: winTarget,
      icon: path.join(DESKTOP_DIR, 'build', 'icon.ico'),
      artifactName: `${prefix}-${archLabel}-installer.${EXT}`,
      legalTrademarks: 'PodiumCast',
      // NOTE: `publisherName` moved under `signtoolOptions` in electron-builder 26, and the
      // schema rejects unknown keys outright. This build is intentionally unsigned, so the
      // only thing that matters is that the exe is still produced and installable.
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: name,
      artifactName: `${prefix}-${archLabel}-installer.${EXT}`,
      uninstallDisplayName: `${name} ${APP_VERSION}`,
      deleteAppDataOnUninstall: false,
      // Unsigned build: keep SmartScreen's "unknown publisher" as the only warning.
      differentialPackage: false,
    },

    mac: {
      target: macTarget,
      icon: path.join(DESKTOP_DIR, 'build', 'icon.icns'),
      category: 'public.app-category.video',
      darkModeSupport: true,
      minimumSystemVersion: '11.0',
      artifactName: `${prefix}-macos-installer.${EXT}`,
      // Camera access is the whole point of the app; without these keys macOS kills it.
      extendInfo: {
        NSCameraUsageDescription: 'PodiumCast 需要访问摄像头以进行预览、拍照与录像。',
        NSMicrophoneUsageDescription: 'PodiumCast 在录制带声音的视频时需要访问麦克风。',
        NSLocalNetworkUsageDescription: 'PodiumCast 通过局域网在大屏端与拍摄端之间传输预览画面与文件。',
        NSBonjourServices: ['_podiumcast._tcp'],
        LSApplicationCategoryType: 'public.app-category.video',
      },
      hardenedRuntime: false,
      gatekeeperAssess: false,
      identity: null,
    },
    dmg: {
      title: `${name} ${APP_VERSION}`,
      artifactName: `${prefix}-macos-installer.${EXT}`,
      backgroundColor: '#000000',
      window: { width: 560, height: 380 },
      contents: [
        { x: 150, y: 190, type: 'file' },
        { x: 410, y: 190, type: 'link', path: '/Applications' },
      ],
    },

    linux: {
      target: linuxTarget,
      icon: path.join(DESKTOP_DIR, 'build', 'icon.png'),
      category: 'AudioVideo',
      maintainer: 'PassersbyfromChina',
      synopsis: '多平台摄像头投屏与拍摄控制',
      artifactName: `${prefix}-linux-${archLabel}.${EXT}`,
    },
  };
}
