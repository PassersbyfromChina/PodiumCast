/**
 * Renderer-side implementations of the core bridge interfaces.
 *
 * `HostMediaStore` and `IpcCastBridge` delegate to the native host (Electron main / Android
 * plugins). `BrowserStageBridge` needs no host at all: a Stage is a WebSocket *client*, which
 * every WebView already speaks, so preview frames and file chunks arrive without a base64
 * round trip through the native bridge. Only UDP discovery is borrowed from the host.
 */
import { Emitter } from '@podiumcast/core';
import type {
  BridgeEvents,
  CastBridge,
  DiscoveredPeer,
  MediaFile,
  MediaStore,
  MediaStoreEvents,
  PeerInfo,
  Platform,
  Role,
  StageBridge,
  DeviceInfo,
} from '@podiumcast/core';
import { DISCOVERY_MAGIC } from '@podiumcast/core';
import type { HostChannel, HostEvent } from './host';

// ---------------------------------------------------------------------------------------
// Media store
// ---------------------------------------------------------------------------------------

export class HostMediaStore implements MediaStore {
  readonly events = new Emitter<MediaStoreEvents>();

  constructor(
    private readonly host: HostChannel,
    private readonly urlPrefix = 'podiumcast://media',
  ) {
    host.onEvent((e) => {
      if (e.event === 'store:changed') this.events.emit('changed', e.files);
    });
  }

  list(): Promise<MediaFile[]> { return this.host.storeList() }
  location(): Promise<string> { return this.host.info().then((i) => i.mediaLocation) }
  urlFor(file: MediaFile): string {
    if (file.url) return file.url;
    return `${this.urlPrefix}/${encodeURIComponent(file.id)}`;
  }
  beginWrite(name: string, kind: 'photo' | 'video', meta: { mime: string; width: number; height: number; createdAt: number }) {
    return this.host.storeBeginWrite(name, kind, meta);
  }
  appendWrite(handle: string, bytes: Uint8Array) { return this.host.storeAppend(handle, bytes) }
  endWrite(handle: string, durationMs: number) { return this.host.storeEnd(handle, durationMs) }
  abortWrite(handle: string) { return this.host.storeAbort(handle) }
  readAll(id: string): Promise<Uint8Array> { return this.host.storeReadRange(id, 0, Number.MAX_SAFE_INTEGER) }
  readRange(id: string, offset: number, length: number) { return this.host.storeReadRange(id, offset, length) }
  remove(id: string) { return this.host.storeRemove(id) }
}

// ---------------------------------------------------------------------------------------
// Cast bridge (delegates the listening socket to the native host)
// ---------------------------------------------------------------------------------------

export class IpcCastBridge implements CastBridge {
  readonly events = new Emitter<BridgeEvents>();
  readonly role = 'cast' as const;

  private readonly peersById = new Map<string, PeerInfo>();

  constructor(private readonly host: HostChannel) {
    host.onEvent((e) => this.onHostEvent(e));
  }

  private onHostEvent(e: HostEvent): void {
    switch (e.event) {
      case 'server:listen':
        this.events.emit('listen', { port: e.port, addresses: e.addresses });
        return;
      case 'server:error':
        this.events.emit('listen', { port: e.port, error: e.message });
        return;
      case 'peer': {
        const info: PeerInfo = {
          id: e.peer.id, role: null, name: '未握手', platform: null,
          address: e.peer.address, connectedAt: e.peer.connectedAt, rttMs: 0, protocol: null,
        };
        this.peersById.set(info.id, info);
        this.events.emit('peer', info);
        return;
      }
      case 'peerGone':
        this.peersById.delete(e.id);
        this.events.emit('peerGone', { id: e.id, reason: e.reason });
        return;
      case 'text':
        this.events.emit('text', { peerId: e.peerId, message: e.message });
        return;
      case 'binary':
        this.events.emit('binary', { peerId: e.peerId, bytes: e.bytes });
        return;
      case 'error':
        this.events.emit('error', { message: e.message, fatal: e.fatal });
        return;
      default:
        return;
    }
  }

  /** Re-labels a peer once its `hello` has been parsed, so the UI can show a real name. */
  namePeer(peerId: string, device: DeviceInfo): void {
    const info = this.peersById.get(peerId);
    if (!info) return;
    info.role = device.role;
    info.name = device.name;
    info.platform = device.platform;
  }

  async start(port: number): Promise<number> {
    const r = await this.host.serverStart(port);
    return r.port;
  }
  stop(): Promise<void> { return this.host.serverStop() }
  broadcast(data: string | Uint8Array): void { this.host.serverBroadcast(data) }
  send(peerId: string, data: string | Uint8Array): void { this.host.serverSend(peerId, data) }
  /**
   * The native server tracks its own socket buffer. Electron answers honestly; the Android
   * plugin resolves immediately after handing bytes to Java-WebSocket, which has already
   * queued them — the sender still yields to the event loop between bursts either way.
   */
  async flush(): Promise<void> { await Promise.resolve() }
  closePeer(peerId: string, reason: string): void { this.host.serverClosePeer(peerId, reason) }
  peers(): PeerInfo[] { return [...this.peersById.values()] }
  async localAddresses(): Promise<string[]> {
    const info = await this.host.info();
    return info.canServe ? (await this.host.serverStart(0).then(() => []).catch(() => [])) : [];
  }
  startBeacon(opts: { port: number; castPort: number; intervalMs: number }): Promise<void> {
    return this.host.beaconStart(opts.castPort, opts.port);
  }
  stopBeacon(): Promise<void> { return this.host.beaconStop() }
}

// ---------------------------------------------------------------------------------------
// Stage bridge (plain browser WebSocket, host only for discovery)
// ---------------------------------------------------------------------------------------

export class BrowserStageBridge implements StageBridge {
  readonly events = new Emitter<BridgeEvents>();
  readonly role = 'stage' as const;

  private socket: WebSocket | null = null;
  private currentUrl: string | null = null;
  private host: HostChannel | null;

  constructor(host: HostChannel | null = null) { this.host = host }

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN }
  get url(): string | null { return this.currentUrl }

  connect(url: string): Promise<void> {
    this.disconnectSync();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      this.currentUrl = url;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close() } catch { /* not open */ }
        reject(new Error(`连接 ${url} 超时`));
      }, 8000);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.events.emit('peer', {
          id: url, role: 'cast', name: '拍摄端', platform: null as Platform | null,
          address: url, connectedAt: Date.now(), rttMs: 0, protocol: null,
        });
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message = `无法连接 ${url}`;
        this.events.emit('error', { message, fatal: true });
        reject(new Error(message));
      };
      socket.onclose = (ev) => {
        clearTimeout(timer);
        this.events.emit('peerGone', { id: url, reason: ev.reason || `code ${ev.code}` });
        if (!settled) { settled = true; reject(new Error(`连接 ${url} 失败（code ${ev.code}）`)) }
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data === 'string') this.events.emit('text', { peerId: url, message: ev.data });
        else if (ev.data instanceof ArrayBuffer) this.events.emit('binary', { peerId: url, bytes: new Uint8Array(ev.data) });
        else if (ev.data instanceof Blob) {
          void ev.data.arrayBuffer().then((buf) => this.events.emit('binary', { peerId: url, bytes: new Uint8Array(buf) }));
        }
      };
    });
  }

  private disconnectSync(): void {
    const socket = this.socket;
    this.socket = null;
    this.currentUrl = null;
    if (!socket) return;
    socket.onopen = null; socket.onerror = null; socket.onmessage = null; socket.onclose = null;
    try { socket.close(1000, 'client disconnect') } catch { /* already closed */ }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.disconnectSync();
    await Promise.resolve(socket);
  }

  send(data: string | Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(typeof data === 'string' ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength));
  }

  /** Waits until `bufferedAmount` falls back under the high-water mark. */
  flush(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.bufferedAmount < 4 * 1024 * 1024) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!this.socket || this.socket.bufferedAmount < 4 * 1024 * 1024 || Date.now() - started > 5000) {
          clearInterval(timer); resolve();
        }
      }, 8);
    });
  }

  /**
   * Discovery order: loopback (covers the USB transport after `adb reverse`), then the host's
   * UDP/sweep helper, then a manual address supplied by the user.
   */
  async discover(opts: { timeoutMs: number; port: number; sweep?: boolean }): Promise<DiscoveredPeer[]> {
    const found: DiscoveredPeer[] = [];
    const local = `127.0.0.1:${opts.port}`;
    if (await this.ping(local, 700)) {
      found.push({ address: local, port: opts.port, name: '本机', platform: null, host: '127.0.0.1', lastSeen: Date.now(), via: 'loopback' });
      return found;
    }
    if (this.host) {
      try {
        const peers = await this.host.discover({ timeoutMs: opts.timeoutMs, port: opts.port, sweep: opts.sweep !== false });
        for (const p of peers) {
          if (found.some((f) => f.address === p.address)) continue;
          found.push({
            address: p.address, port: p.port, name: p.name, platform: p.platform as Platform | null,
            host: p.host, lastSeen: Date.now(), via: (p.via as DiscoveredPeer['via']) ?? 'udp',
          });
        }
      } catch { /* discovery is best-effort */ }
    }
    return found;
  }

  private ping(address: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      let socket: WebSocket | null = null;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { socket?.close() } catch { /* already closed */ }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        socket = new WebSocket(`ws://${address}`);
        socket.onopen = () => finish(true);
        socket.onerror = () => finish(false);
        socket.onclose = () => finish(false);
      } catch { finish(false) }
    });
  }
}

/** Helper for the connection dialog: parses `host`, `host:port` or `ws://host:port`. */
export function normalizeAddress(input: string, defaultPort: number): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^wss?:\/\//.test(trimmed) ? trimmed : `ws://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = String(defaultPort);
    return url.toString().replace(/\/$/, '');
  } catch { return null }
}

export { DISCOVERY_MAGIC };
export type { Role };
