/**
 * Node-only entry point: transports (`ws` + `node:dgram`) and filesystem storage.
 * Bundled exclusively into the Electron **main** process.
 */
export * from './bridges';
export * from './store';
