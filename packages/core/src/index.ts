/**
 * PodiumCast shared core — platform-neutral protocol, negotiation and session logic.
 *
 * Import this from anything that runs in a browser-like context (Electron renderer, Android
 * WebView). Node-only transports and storage live in `@podiumcast/core/node`.
 */
export * from './protocol';
export * from './events';
export * from './bridge';
export * from './specs';
export * from './library';
export * from './discovery';
export * from './transfer';
export * from './session/cast-session';
export * from './session/stage-session';
