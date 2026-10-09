/**
 * Host channel — how the renderer reaches the native side.
 *
 * Three hosts are supported and all three expose the *same* request/event surface, so the
 * session code above never branches on platform:
 *
 *   Electron renderer → `window.podiumcast` (installed by apps/desktop/src/preload.ts)
 *   Android WebView   → the `PodiumCastLan` / `PodiumCastStore` Capacitor plugins
 *   Plain browser     → a no-op channel: the Stage still works over a plain WebSocket
 *
 * Only *native capabilities* cross this boundary:
 *   - the WebSocket **server** (a browser cannot listen on a TCP port),
 *   - **UDP** discovery,
 *   - the **filesystem**,
 *   - the **display** the window is on,
 *   - `adb reverse` for the USB transport.
 *
 * Camera frames stay in the renderer; only the finished JPEG preview crosses over.
 */
import type { DisplaySpec, MediaFile, Platform, Role } from '@podiumcast/core';

export interface HostPeerInfo {
  id: string;
  address: string;
  connectedAt: number;
}

export type HostEvent =
  | { event: 'server:listen'; port: number; addresses: string[] }
  | { event: 'server:error'; port: number; message: string }
  | { event: 'peer'; peer: HostPeerInfo }
  | { event: 'peerGone'; id: string; reason: string }
  | { event: 'text'; peerId: string; message: string }
  | { event: 'binary'; peerId: string; bytes: Uint8Array }
  | { event: 'error'; message: string; fatal: boolean }
  | { event: 'store:changed'; files: MediaFile[] }
  | { event: 'display'; display: DisplaySpec }
  | { event: 'action'; action: string; payload?: unknown };

export interface HostInfo {
  role: Role;
  platform: Platform;
  arch: string;
  appVersion: string;
  deviceId: string;
  deviceName: string;
  /** Absolute path recordings are written to (desktop) or a friendly name (Android). */
  mediaLocation: string;
  /** `true` when the host can run a listening socket. */
  canServe: boolean;
  /** `true` when the host can broadcast UDP beacons. */
  canBeacon: boolean;
  /** `true` when `adb` was found on PATH, enabling the USB transport. */
  hasAdb: boolean;
}

export interface HostChannel {
  readonly id: 'electron' | 'capacitor' | 'web';
  info(): Promise<HostInfo>;
  onEvent(cb: (e: HostEvent) => void): () => void;

  // --- transport -------------------------------------------------------------------
  serverStart(port: number): Promise<{ port: number; addresses: string[] }>;
  serverStop(): Promise<void>;
  serverBroadcast(data: string | Uint8Array): void;
  serverSend(peerId: string, data: string | Uint8Array): void;
  serverClosePeer(peerId: string, reason: string): void;
  serverPeers(): Promise<HostPeerInfo[]>;
  beaconStart(castPort: number, port: number): Promise<void>;
  beaconStop(): Promise<void>;
  /** UDP listen (+ optional subnet sweep) used by the Stage to find a Cast. */
  discover(opts: { timeoutMs: number; port: number; sweep: boolean }): Promise<Array<{ address: string; port: number; name: string; host: string | null; platform: string | null; via: string }>>;

  // --- storage ---------------------------------------------------------------------
  storeList(): Promise<MediaFile[]>;
  storeBeginWrite(name: string, kind: 'photo' | 'video', meta: { mime: string; width: number; height: number; createdAt: number }): Promise<string>;
  /** Base64 on the wire for the Capacitor path; Uint8Array for Electron. */
  storeAppend(handle: string, bytes: Uint8Array): Promise<void>;
  storeEnd(handle: string, durationMs: number): Promise<MediaFile>;
  storeAbort(handle: string): Promise<void>;
  storeReadRange(id: string, offset: number, length: number): Promise<Uint8Array>;
  storeRemove(id: string): Promise<void>;

  // --- OS integration --------------------------------------------------------------
  display(): Promise<DisplaySpec>;
  openMediaFolder(): Promise<void>;
  chooseMediaFolder(): Promise<string | null>;
  /** Runs `adb reverse tcp:<port> tcp:<port>` so an Android Stage can reach this Cast. */
  usbBridge(port: number): Promise<{ ok: boolean; message: string }>;
  setFullscreen(fullscreen: boolean): Promise<boolean>;
  quit(): Promise<void>;
}

/** Base64 helpers shared by the Capacitor channel (Electron uses structured clone). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** No-op channel: enough for a Stage opened in a plain browser over a manual address. */
export class WebHostChannel implements HostChannel {
  readonly id = 'web' as const;
  constructor(private readonly base: Partial<HostInfo> = {}) {}

  async info(): Promise<HostInfo> {
    return {
      role: 'stage',
      platform: 'linux',
      arch: 'web',
      appVersion: '1.0.0',
      deviceId: 'web',
      deviceName: '网页版',
      mediaLocation: '浏览器下载目录',
      canServe: false,
      canBeacon: false,
      hasAdb: false,
      ...this.base,
    };
  }

  onEvent(): () => void { return () => undefined }
  async serverStart(): Promise<{ port: number; addresses: string[] }> { throw new Error('网页版无法作为拍摄端监听端口') }
  async serverStop(): Promise<void> { /* nothing to stop */ }
  serverBroadcast(): void { /* no server */ }
  serverSend(): void { /* no server */ }
  serverClosePeer(): void { /* no server */ }
  async serverPeers(): Promise<HostPeerInfo[]> { return [] }
  async beaconStart(): Promise<void> { /* no UDP in a page */ }
  async beaconStop(): Promise<void> { /* no UDP in a page */ }
  async discover(): Promise<Array<{ address: string; port: number; name: string; host: string | null; platform: string | null; via: string }>> { return [] }
  async storeList(): Promise<MediaFile[]> { return [] }
  async storeBeginWrite(): Promise<string> { throw new Error('网页版不提供存储') }
  async storeAppend(): Promise<void> { throw new Error('网页版不提供存储') }
  async storeEnd(): Promise<MediaFile> { throw new Error('网页版不提供存储') }
  async storeAbort(): Promise<void> { /* nothing to abort */ }
  async storeReadRange(): Promise<Uint8Array> { return new Uint8Array(0) }
  async storeRemove(): Promise<void> { /* nothing to remove */ }
  async display(): Promise<DisplaySpec> {
    const w = window.screen?.width ?? 1920;
    const h = window.screen?.height ?? 1080;
    return { width: w, height: h, aspect: '', ratio: w / h, fps: 60, colorSpace: 'srgb', fullscreen: Boolean(document.fullscreenElement), devicePixelRatio: window.devicePixelRatio || 1 };
  }
  async openMediaFolder(): Promise<void> { /* not applicable */ }
  async chooseMediaFolder(): Promise<string | null> { return null }
  async usbBridge(): Promise<{ ok: boolean; message: string }> { return { ok: false, message: '网页版不支持 USB 桥接' } }
  async setFullscreen(fullscreen: boolean): Promise<boolean> {
    if (fullscreen && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen().catch(() => undefined);
    } else if (!fullscreen && document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen().catch(() => undefined);
    }
    return Boolean(document.fullscreenElement);
  }
  async quit(): Promise<void> { window.close() }
}
