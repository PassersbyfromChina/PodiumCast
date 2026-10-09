/**
 * Public surface of the shared UI package.
 *
 * The two apps are separate esbuild entries (`cast.ts`, `stage.ts`); this barrel exists for
 * tooling, tests and any future third entry point that wants the primitives without the app
 * shell.
 */
export * from './dom';
export * from './panels';
export * from './playback';
export * from './camera';
export * from './platform/host';
export * from './platform/bridges';
export * from './platform/electron-channel';
export * from './platform/capacitor-channel';
