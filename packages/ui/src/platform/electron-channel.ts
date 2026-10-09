/**
 * Electron host channel (renderer side).
 *
 * The preload script exposes exactly two functions, which keeps the attack surface of
 * `contextIsolation` at its minimum:
 *
 *   window.podiumcast.request(op, payload) -> Promise<unknown>
 *   window.podiumcast.onEvent(cb)          -> unsubscribe
 *
 * Binary payloads rely on Electron's structured clone (Uint8Array survives the trip), so a
 * 255 KiB file chunk or a JPEG preview frame is copied, never base64-inflated.
 */
import type { DisplaySpec, MediaFile } from '@podiumcast/core';
import { WebHostChannel, type HostChannel, type HostEvent, type HostInfo, type HostPeerInfo } from './host';

interface PodiumcastPreload {
  request(op: string, payload?: unknown): Promise<unknown>;
  onEvent(cb: (event: HostEvent) => void): () => void;
}

declare global {
  interface Window { podiumcast?: PodiumcastPreload }
}

export function hasElectronHost(): boolean {
  return typeof window !== 'undefined' && typeof window.podiumcast?.request === 'function';
}

export class ElectronHostChannel implements HostChannel {
  readonly id = 'electron' as const;
  private readonly api: PodiumcastPreload;

  constructor(api: PodiumcastPreload) { this.api = api }

  private call<T>(op: string, payload?: unknown): Promise<T> {
    return this.api.request(op, payload) as Promise<T>;
  }

  info(): Promise<HostInfo> { return this.call<HostInfo>('host:info') }
  onEvent(cb: (e: HostEvent) => void): () => void { return this.api.onEvent(cb) }

  serverStart(port: number) { return this.call<{ port: number; addresses: string[] }>('server:start', { port }) }
  serverStop() { return this.call<void>('server:stop') }
  serverBroadcast(data: string | Uint8Array) { void this.call('server:broadcast', { data }) }
  serverSend(peerId: string, data: string | Uint8Array) { void this.call('server:send', { peerId, data }) }
  serverClosePeer(peerId: string, reason: string) { void this.call('server:closePeer', { peerId, reason }) }
  serverPeers() { return this.call<HostPeerInfo[]>('server:peers') }
  beaconStart(castPort: number, port: number) { return this.call<void>('beacon:start', { castPort, port }) }
  beaconStop() { return this.call<void>('beacon:stop') }
  discover(opts: { timeoutMs: number; port: number; sweep: boolean }) {
    return this.call<Array<{ address: string; port: number; name: string; host: string | null; platform: string | null; via: string }>>('discover', opts);
  }

  storeList() { return this.call<MediaFile[]>('store:list') }
  storeBeginWrite(name: string, kind: 'photo' | 'video', meta: { mime: string; width: number; height: number; createdAt: number }) {
    return this.call<string>('store:beginWrite', { name, kind, meta });
  }
  storeAppend(handle: string, bytes: Uint8Array) { return this.call<void>('store:append', { handle, bytes }) }
  storeEnd(handle: string, durationMs: number) { return this.call<MediaFile>('store:end', { handle, durationMs }) }
  storeAbort(handle: string) { return this.call<void>('store:abort', { handle }) }
  async storeReadRange(id: string, offset: number, length: number): Promise<Uint8Array> {
    const result = await this.call<Uint8Array | { data: Uint8Array }>('store:readRange', { id, offset, length });
    return result instanceof Uint8Array ? result : result.data;
  }
  storeRemove(id: string) { return this.call<void>('store:remove', { id }) }

  display() { return this.call<DisplaySpec>('display:get') }
  openMediaFolder() { return this.call<void>('media:openFolder') }
  chooseMediaFolder() { return this.call<string | null>('media:chooseFolder') }
  usbBridge(port: number) { return this.call<{ ok: boolean; message: string }>('media:usbBridge', { port }) }
  setFullscreen(fullscreen: boolean) { return this.call<boolean>('window:fullscreen', { fullscreen }) }
  quit() { return this.call<void>('app:quit') }
}

/** Picks the richest available host. Android and the browser fall back in that order. */
export function detectHost(): HostChannel {
  if (hasElectronHost()) return new ElectronHostChannel(window.podiumcast!);
  return new WebHostChannel();
}
