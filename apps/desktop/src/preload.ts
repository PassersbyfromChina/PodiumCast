/**
 * PodiumCast preload bridge.
 *
 * `contextIsolation` stays on and exactly two functions cross the boundary:
 *
 *   window.podiumcast.request(op, payload) -> Promise<unknown>
 *   window.podiumcast.onEvent(cb)          -> unsubscribe
 *
 * Everything else — including which IPC channels exist — stays in the main process, so a
 * compromised renderer cannot reach an arbitrary Electron API.
 *
 * Binary payloads (JPEG preview frames, 255 KiB file chunks) rely on Electron's structured
 * clone: a `Uint8Array` survives the trip intact, so nothing is base64-inflated.
 */
import { contextBridge, ipcRenderer } from 'electron';

/** Ops the main process implements. Anything else is rejected before it reaches IPC. */
const ALLOWED_OPS = new Set([
  'host:info',
  'server:start', 'server:stop', 'server:broadcast', 'server:send', 'server:closePeer', 'server:peers',
  'beacon:start', 'beacon:stop',
  'discover',
  'store:list', 'store:beginWrite', 'store:append', 'store:end', 'store:abort', 'store:readRange', 'store:remove',
  'display:get', 'media:openFolder', 'media:chooseFolder', 'media:usbBridge',
  'window:fullscreen', 'app:quit',
]);

contextBridge.exposeInMainWorld('podiumcast', {
  request(op: string, payload?: unknown): Promise<unknown> {
    if (!ALLOWED_OPS.has(op)) return Promise.reject(new Error(`不支持的宿主操作：${op}`));
    return ipcRenderer.invoke(op, payload);
  },
  onEvent(cb: (event: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('podiumcast:event', listener);
    return () => ipcRenderer.removeListener('podiumcast:event', listener);
  },
});
