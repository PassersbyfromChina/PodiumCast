/**
 * Capacitor host channel — used by PodiumCast for Android.
 *
 * A WebView can render and capture, but it can neither listen on a TCP port nor open a UDP
 * socket, so those capabilities come from native plugins that ship inside the APK:
 *
 *   PodiumCastLan   — WebSocket server (Java-WebSocket), UDP discovery, device facts
 *   PodiumCastStore — append-only media store backed by RandomAccessFile
 *
 * The plugin objects are looked up through `window.Capacitor` rather than `@capacitor/core`
 * so the identical bundle also loads in Electron, which has no Capacitor runtime at all.
 *
 * ## Binary on this path
 *
 * Capacitor marshals plugin arguments and results as JSON, so a preview frame or a 255 KiB
 * file chunk crosses the bridge base64-encoded — the one place the Android transport costs
 * more than Electron's structured clone. The UI compensates with a lower default preview
 * size (see `previewWidth` in packages/ui/src/cast.ts).
 */
import type { DisplaySpec, MediaFile, Platform } from '@podiumcast/core';
import {
  base64ToBytes,
  bytesToBase64,
  type HostChannel,
  type HostEvent,
  type HostInfo,
  type HostPeerInfo,
} from './host';

interface CapacitorPluginHandle {
  addListener(event: string, cb: (data: never) => void): { remove(): Promise<void> } | void;
  [method: string]: unknown;
}

interface CapacitorGlobal {
  getPlatform?(): string;
  convertFileSrc?(path: string): string;
  Plugins?: Record<string, CapacitorPluginHandle>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function hasCapacitorHost(): boolean {
  return Boolean(capacitor()?.Plugins?.PodiumCastLan);
}

/**
 * Shapes returned by the Java plugins. Capacitor's `PluginCall.resolve` only accepts a
 * JSObject, so every method answers with a wrapper object rather than a bare array or string.
 */
interface LanInfo {
  role: string; deviceName: string; deviceId: string; arch: string;
  appVersion: string; mediaLocation: string; hasAdb: boolean; sdk: number;
}
interface LanState { port: number; addresses: string[] }
interface DiscoveredPeerJson {
  address: string; port: number; name: string; host: string | null; platform: string | null; via: string;
}

export class CapacitorHostChannel implements HostChannel {
  readonly id = 'capacitor' as const;
  private readonly lan: CapacitorPluginHandle;
  private readonly store: CapacitorPluginHandle | undefined;
  private readonly platform: Platform;

  constructor(plugins: Record<string, CapacitorPluginHandle>) {
    this.lan = plugins.PodiumCastLan;
    this.store = plugins.PodiumCastStore;
    const p = capacitor()?.getPlatform?.() ?? 'android';
    this.platform = (p === 'ios' ? 'macos' : p) as Platform;
  }

  private async lanCall<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const fn = this.lan[method] as ((a: Record<string, unknown>) => Promise<T>) | undefined;
    if (typeof fn !== 'function') throw new Error(`原生插件缺少方法 PodiumCastLan.${method}`);
    return fn.call(this.lan, args);
  }

  private async storeCall<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.store) throw new Error('原生插件 PodiumCastStore 未安装');
    const fn = this.store[method] as ((a: Record<string, unknown>) => Promise<T>) | undefined;
    if (typeof fn !== 'function') throw new Error(`原生插件缺少方法 PodiumCastStore.${method}`);
    return fn.call(this.store, args);
  }

  async info(): Promise<HostInfo> {
    const r = await this.lanCall<LanInfo>('info');
    return {
      role: r.role === 'stage' ? 'stage' : 'cast',
      platform: this.platform,
      arch: r.arch,
      appVersion: r.appVersion,
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      mediaLocation: r.mediaLocation,
      canServe: true,
      canBeacon: true,
      hasAdb: Boolean(r.hasAdb),
    };
  }

  onEvent(cb: (e: HostEvent) => void): () => void {
    const handles: Array<{ remove(): Promise<void> } | void> = [];
    const listen = (event: string, map: (data: never) => HostEvent | null) => {
      const h = this.lan.addListener(event, (data: never) => {
        const mapped = map(data);
        if (mapped) cb(mapped);
      });
      if (h) handles.push(h);
    };
    listen('serverListen', (d: LanState) => ({ event: 'server:listen', port: d.port, addresses: d.addresses }));
    listen('serverError', (d: { port: number; message: string }) => ({ event: 'server:error', port: d.port, message: d.message }));
    listen('peer', (d: HostPeerInfo) => ({ event: 'peer', peer: d }));
    listen('peerGone', (d: { id: string; reason: string }) => ({ event: 'peerGone', id: d.id, reason: d.reason }));
    listen('text', (d: { peerId: string; message: string }) => ({ event: 'text', peerId: d.peerId, message: d.message }));
    listen('binary', (d: { peerId: string; data: string }) => ({ event: 'binary', peerId: d.peerId, bytes: base64ToBytes(d.data) }));
    listen('error', (d: { message: string; fatal?: boolean }) => ({ event: 'error', message: d.message, fatal: Boolean(d.fatal) }));
    return () => { for (const h of handles) void h?.remove?.() };
  }

  serverStart(port: number) { return this.lanCall<LanState>('start', { port }) }
  serverStop() { return this.lanCall<void>('stop') }
  serverBroadcast(data: string | Uint8Array) {
    void this.lanCall('broadcast', typeof data === 'string' ? { text: data } : { binary: bytesToBase64(data) });
  }
  serverSend(peerId: string, data: string | Uint8Array) {
    void this.lanCall('sendTo', typeof data === 'string' ? { peerId, text: data } : { peerId, binary: bytesToBase64(data) });
  }
  serverClosePeer(peerId: string, reason: string) { void this.lanCall('closePeer', { peerId, reason }) }
  async serverPeers(): Promise<HostPeerInfo[]> {
    const r = await this.lanCall<{ peers: HostPeerInfo[] }>('peers');
    return r.peers ?? [];
  }
  beaconStart(castPort: number, port: number) { return this.lanCall<void>('startBeacon', { castPort, port }) }
  beaconStop() { return this.lanCall<void>('stopBeacon') }
  async discover(opts: { timeoutMs: number; port: number; sweep: boolean }): Promise<DiscoveredPeerJson[]> {
    const r = await this.lanCall<{ peers: DiscoveredPeerJson[] }>('discover', opts);
    return r.peers ?? [];
  }

  async storeList(): Promise<MediaFile[]> {
    const r = await this.storeCall<{ files: MediaFile[] }>('list');
    return (r.files ?? []).map((f) => {
      const url = this.toPlayableUrl(f.localPath);
      return url ? { ...f, url } : f;
    });
  }
  async storeBeginWrite(name: string, kind: 'photo' | 'video', meta: { mime: string; width: number; height: number; createdAt: number }) {
    const r = await this.storeCall<{ handle: string }>('beginWrite', { name, kind, ...meta });
    return r.handle;
  }
  storeAppend(handle: string, bytes: Uint8Array) {
    // Capacitor marshals plugin arguments as JSON, so binary must be base64 on this path.
    return this.storeCall<void>('append', { handle, data: bytesToBase64(bytes) });
  }
  async storeEnd(handle: string, durationMs: number): Promise<MediaFile> {
    const f = await this.storeCall<MediaFile>('end', { handle, durationMs });
    const url = this.toPlayableUrl(f.localPath);
    return url ? { ...f, url } : f;
  }
  storeAbort(handle: string) { return this.storeCall<void>('abort', { handle }) }
  async storeReadRange(id: string, offset: number, length: number): Promise<Uint8Array> {
    const r = await this.storeCall<{ data: string }>('readRange', { id, offset, length });
    return base64ToBytes(r.data);
  }
  storeRemove(id: string) { return this.storeCall<void>('remove', { id }) }

  /**
   * Turns an app-private file path into something `<img>`/`<video>` will load.
   * Capacitor serves these through its local WebView asset handler.
   */
  private toPlayableUrl(localPath: string | undefined): string | undefined {
    if (!localPath) return undefined;
    const convert = capacitor()?.convertFileSrc;
    if (typeof convert === 'function') return convert(localPath);
    return `file://${localPath}`;
  }

  async display(): Promise<DisplaySpec> {
    const r = await this.lanCall<{ width: number; height: number; fps: number; colorSpace: string; devicePixelRatio: number }>('display');
    const ratio = r.width / Math.max(1, r.height);
    return {
      width: r.width,
      height: r.height,
      aspect: '',
      ratio,
      fps: r.fps || 60,
      colorSpace: (r.colorSpace as DisplaySpec['colorSpace']) ?? 'srgb',
      fullscreen: true,
      devicePixelRatio: r.devicePixelRatio || 1,
    };
  }
  openMediaFolder() { return this.lanCall<void>('openMediaFolder') }
  async chooseMediaFolder(): Promise<string | null> { return null }
  async usbBridge(port: number) { return this.lanCall<{ ok: boolean; message: string }>('usbBridge', { port }) }
  async setFullscreen(fullscreen: boolean) { return this.lanCall<boolean>('setFullscreen', { fullscreen }) }
  quit() { return this.lanCall<void>('quit') }
}
