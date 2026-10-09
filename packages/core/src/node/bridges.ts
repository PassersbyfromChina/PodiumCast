/**
 * Node.js transport implementations of the Cast/Stage bridges.
 *
 * These are the desktop (Electron main process) implementations of the interfaces declared in
 * `../bridge.ts`. They are deliberately kept in a `node/` sub-entry so the renderer bundle
 * never pulls in `node:dgram`, `node:os` or `ws`.
 *
 * Why the work happens in the main process rather than the renderer:
 *   - a browser context cannot listen on a TCP port, so the Cast *must* own the server
 *     somewhere native 鈥?on desktop that is Node, on Android it is a Java plugin;
 *   - UDP broadcast (LAN auto-discovery) is likewise unavailable to a WebView;
 *   - it keeps camera frames the only thing crossing the IPC boundary.
 */
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Emitter } from '../events';
import type { BridgeEvents, CastBridge, DiscoveredPeer, PeerInfo, StageBridge } from '../bridge';
import { DISCOVERY_MAGIC, DISCOVERY_PORT, PROTOCOL_VERSION, type Platform } from '../protocol';
import { decodeBeacon, encodeBeacon, probeWebSocket, subnetHosts } from '../discovery';

/** Send buffer high-water mark; `flush()` waits for the socket to fall back under it. */
const HIGH_WATER_MARK = 4 * 1024 * 1024;

function ipv4Addresses(): { iface: string; address: string; netmask: string }[] {
  const out: { iface: string; address: string; netmask: string }[] = [];
  const ifaces = networkInterfaces();
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      // Node <18 reports family as 'IPv4'; newer versions use the number 4.
      const isV4 = a.family === 'IPv4' || (a.family as unknown as number) === 4;
      if (isV4 && !a.internal) out.push({ iface, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

/** Directed broadcast address for a `a.b.c.d / netmask` pair, or null for /31-/32. */
function broadcastAddress(address: string, netmask: string): string | null {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || a.some(isNaN) || m.some(isNaN)) return null;
  const b = a.map((octet, i) => (octet & m[i]) | (~m[i] & 0xff));
  if (m.every((x) => x === 255)) return null; // /32 has no broadcast
  return b.join('.');
}

export function localIPv4(): string[] {
  return ipv4Addresses().map((a) => a.address);
}

// ---------------------------------------------------------------------------------------
// Cast (server)
// ---------------------------------------------------------------------------------------

export interface NodeCastBridgeOptions {
  /** Advertised name in beacons; the UI usually passes the machine name. */
  name: string;
  platform?: Platform;
  version?: number;
  /** Called for every new TCP peer so the session can log/measure. */
  logger?: (message: string) => void;
}

export class NodeCastBridge implements CastBridge {
  readonly events = new Emitter<BridgeEvents>();
  readonly role = 'cast' as const;

  private server: WebSocketServer | null = null;
  private udp: UdpSocket | null = null;
  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private readonly connectionMap = new Map<string, { socket: WsClient; info: PeerInfo }>();
  private readonly opts: NodeCastBridgeOptions;
  private beaconSeq = 0;
  private beaconPort = 0;

  constructor(opts: NodeCastBridgeOptions) { this.opts = opts }

  start(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (this.server) { resolve(port); return }
      const server = new WebSocketServer({ port, host: '0.0.0.0', perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 });
      const onError = (err: Error) => {
        this.events.emit('listen', { port, error: err.message });
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', (err) => this.events.emit('error', { message: err.message, fatal: false }));
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        this.server = server;
        this.events.emit('listen', { port: bound, addresses: localIPv4() });
        this.opts.logger?.(`listening on 0.0.0.0:${bound}`);
        resolve(bound);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.on('connection', (socket, req) => this.attach(socket, req.socket.remoteAddress ?? 'unknown'));
    });
  }

  private attach(socket: WsClient, remoteAddress: string): void {
    const id = randomUUID();
    const info: PeerInfo = {
      id,
      role: null,
      name: '未握手',
      platform: null,
      address: remoteAddress.replace(/^::ffff:/, ''),
      connectedAt: Date.now(),
      rttMs: 0,
      protocol: null,
    };
    this.connectionMap.set(id, { socket, info });
    socket.binaryType = 'nodebuffer';
    this.events.emit('peer', info);

    socket.on('message', (data, isBinary) => {
      if (isBinary) this.events.emit('binary', { peerId: id, bytes: toUint8(data as Buffer) });
      else this.events.emit('text', { peerId: id, message: (data as Buffer).toString('utf8') });
    });
    socket.on('close', (_code, reason) => {
      this.connectionMap.delete(id);
      this.events.emit('peerGone', { id, reason: reason.toString() || 'closed' });
    });
    socket.on('error', (err) => this.events.emit('error', { message: err.message, fatal: false }));
  }

  stop(): Promise<void> {
    for (const { socket } of this.connectionMap.values()) { try { socket.terminate() } catch { /* already gone */ } }
    this.connectionMap.clear();
    const server = this.server;
    this.server = null;
    return new Promise<void>((resolve) => {
      if (!server) { resolve(); return }
      server.close(() => resolve());
    });
  }

  broadcast(data: string | Uint8Array): void {
    const payload = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (const { socket } of this.connectionMap.values()) {
      if (socket.readyState === WsClient.OPEN) socket.send(payload, { binary: typeof data !== 'string' });
    }
  }

  send(peerId: string, data: string | Uint8Array): void {
    const peer = this.connectionMap.get(peerId);
    if (!peer || peer.socket.readyState !== WsClient.OPEN) return;
    const payload = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    peer.socket.send(payload, { binary: typeof data !== 'string' });
  }

  async flush(peerId?: string): Promise<void> {
    const targets = peerId ? [this.connectionMap.get(peerId)].filter(Boolean) as { socket: WsClient }[] : [...this.connectionMap.values()];
    await Promise.all(targets.map((t) => waitForDrain(t.socket)));
  }

  closePeer(peerId: string, reason: string): void {
    const peer = this.connectionMap.get(peerId);
    if (!peer) return;
    try { peer.socket.close(1000, reason.slice(0, 120)) } catch { /* ignore */ }
    this.connectionMap.delete(peerId);
    this.events.emit('peerGone', { id: peerId, reason });
  }

  peers(): PeerInfo[] { return [...this.connectionMap.values()].map((p) => p.info) }

  async localAddresses(): Promise<string[]> { return localIPv4() }

  /** Broadcasts a UDP beacon so Stages find this Cast without scanning. */
  async startBeacon(opts: { port: number; castPort: number; intervalMs: number }): Promise<void> {
    if (this.udp) return;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.beaconPort = opts.castPort;
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(opts.port, () => { socket.off('error', reject); resolve() });
    });
    socket.on('error', (err) => this.events.emit('error', { message: `UDP: ${err.message}`, fatal: false }));
    // A Stage may ask directly instead of waiting for the next tick.
    socket.on('message', (buf, rinfo) => {
      if (!buf.toString('utf8').startsWith(DISCOVERY_MAGIC)) return;
      this.announceTo(socket, rinfo.port, rinfo.address);
    });
    socket.setBroadcast(true);
    this.udp = socket;
    const tick = () => this.announce(socket, opts);
    tick();
    this.beaconTimer = setInterval(tick, Math.max(250, opts.intervalMs));
  }

  private announce(socket: UdpSocket, opts: { port: number; castPort: number }): void {
    this.beaconSeq++;
    const payload = encodeBeacon({
      magic: DISCOVERY_MAGIC,
      name: this.opts.name,
      deviceId: this.opts.name,
      platform: this.opts.platform ?? 'windows',
      castPort: opts.castPort,
      version: this.opts.version ?? PROTOCOL_VERSION,
      seq: this.beaconSeq,
    });
    for (const iface of ipv4Addresses()) {
      const bcast = broadcastAddress(iface.address, iface.netmask) ?? '255.255.255.255';
      try { socket.send(Buffer.from(payload), opts.port, bcast) } catch { /* interface went away */ }
    }
    try { socket.send(Buffer.from(payload), opts.port, '255.255.255.255') } catch { /* no default route */ }
  }

  /** Unicast answer to a probing Stage. */
  private announceTo(socket: UdpSocket, port: number, address: string): void {
    const payload = encodeBeacon({
      magic: DISCOVERY_MAGIC,
      name: this.opts.name,
      deviceId: this.opts.name,
      platform: this.opts.platform ?? 'windows',
      castPort: this.beaconPort,
      version: this.opts.version ?? PROTOCOL_VERSION,
      seq: this.beaconSeq,
    });
    try { socket.send(Buffer.from(payload), port, address) } catch { /* peer vanished */ }
  }

  stopBeacon(): Promise<void> {
    if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null }
    const udp = this.udp;
    this.udp = null;
    return new Promise<void>((resolve) => {
      if (!udp) { resolve(); return }
      try { udp.close(() => resolve()) } catch { resolve() }
    });
  }
}

// ---------------------------------------------------------------------------------------
// Stage (client)
// ---------------------------------------------------------------------------------------

export interface NodeStageBridgeOptions {
  logger?: (message: string) => void;
}

export class NodeStageBridge implements StageBridge {
  readonly events = new Emitter<BridgeEvents>();
  readonly role = 'stage' as const;

  private socket: WsClient | null = null;
  private currentUrl: string | null = null;
  private readonly opts: NodeStageBridgeOptions;

  constructor(opts: NodeStageBridgeOptions = {}) { this.opts = opts }

  get connected(): boolean { return this.socket?.readyState === WsClient.OPEN }
  get url(): string | null { return this.currentUrl }

  connect(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.disconnect().finally(() => {
        const socket = new WebSocketCtor(url) as WsClient;
        this.socket = socket;
        this.currentUrl = url;
        socket.binaryType = 'nodebuffer';
        const fail = (err: Error) => {
          socket.off('open', ok);
          reject(err);
        };
        const ok = () => {
          socket.off('error', fail);
          socket.on('error', (err) => this.events.emit('error', { message: err.message, fatal: false }));
          this.opts.logger?.(`connected ${url}`);
          this.events.emit('peer', {
            id: url,
            role: 'cast',
            name: '拍摄端',
            platform: null,
            address: url,
            connectedAt: Date.now(),
            rttMs: 0,
            protocol: null,
          });
          resolve();
        };
        socket.once('open', ok);
        socket.once('error', fail);
        socket.on('message', (data, isBinary) => {
          if (isBinary) this.events.emit('binary', { peerId: url, bytes: toUint8(data as Buffer) });
          else this.events.emit('text', { peerId: url, message: (data as Buffer).toString('utf8') });
        });
        socket.on('close', (_code, reason) => {
          this.events.emit('peerGone', { id: url, reason: reason.toString() || 'closed' });
        });
      }).catch(reject);
    });
  }

  disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.currentUrl = null;
    if (!socket) return Promise.resolve();
    return new Promise<void>((resolve) => {
      if (socket.readyState === WsClient.CLOSED) { resolve(); return }
      socket.once('close', () => resolve());
      try { socket.close(1000, 'client disconnect') } catch { resolve() }
      setTimeout(resolve, 500).unref?.();
    });
  }

  send(data: string | Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WsClient.OPEN) return;
    const payload = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    socket.send(payload, { binary: typeof data !== 'string' });
  }

  async flush(): Promise<void> {
    if (this.socket) await waitForDrain(this.socket);
  }

  /**
   * Looks for a Cast, cheapest strategy first: loopback, then UDP beacons, then a /24 sweep.
   * `sweep: false` keeps it to the first two so the Android-style fallback can be skipped on
   * networks that dislike 254 parallel connection attempts.
   */
  async discover(opts: { timeoutMs: number; port: number; sweep?: boolean }): Promise<DiscoveredPeer[]> {
    const found = new Map<string, DiscoveredPeer>();
    const deadline = Date.now() + opts.timeoutMs;

    const add = (peer: DiscoveredPeer) => { if (!found.has(peer.address)) found.set(peer.address, peer) };

    // 1. Same-machine Stage (璇存槑\杩炴帴鏂瑰紡.xlsx 銆屾湰鏈恒€? and the USB path after `adb reverse`).
    if (await probeWebSocket(`ws://127.0.0.1:${opts.port}`, { perHostTimeoutMs: 600 })) {
      add({ address: `127.0.0.1:${opts.port}`, port: opts.port, name: '鏈満', platform: null, host: '127.0.0.1', lastSeen: Date.now(), via: 'loopback' });
      return [...found.values()];
    }

    // 2. UDP beacons.
    const udp = createSocket({ type: 'udp4', reuseAddr: true });
    const udpDone = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve() } };
      udp.on('message', (buf, rinfo) => {
        const beacon = decodeBeacon(buf);
        if (!beacon) return;
        const port = beacon.castPort || opts.port;
        add({
          address: `${rinfo.address}:${port}`,
          port,
          name: beacon.name,
          platform: beacon.platform,
          host: rinfo.address,
          lastSeen: Date.now(),
          via: 'udp',
        });
      });
      udp.on('error', () => finish());
      udp.bind(DISCOVERY_PORT, () => {
        // Ask explicitly rather than waiting up to a full beacon interval.
        try {
          const query = Buffer.from(`${DISCOVERY_MAGIC} QUERY`);
          udp.setBroadcast(true);
          udp.send(query, DISCOVERY_PORT, '255.255.255.255');
          for (const a of ipv4Addresses()) {
            const b = broadcastAddress(a.address, a.netmask);
            if (b) udp.send(query, DISCOVERY_PORT, b);
          }
        } catch { /* no broadcast route */ }
      });
      setTimeout(finish, Math.min(opts.timeoutMs, 2500));
    });

    await udpDone;
    try { udp.close() } catch { /* already closed */ }
    if (found.size > 0) return [...found.values()];

    // 3. /24 sweep around our own address, bounded by the remaining time budget.
    if (opts.sweep !== false && Date.now() < deadline) {
      const mine = localIPv4()[0];
      if (mine) {
        const hosts = subnetHosts(mine);
        const peers = await this.sweep(hosts, opts.port, deadline - Date.now());
        for (const p of peers) add(p);
      }
    }
    return [...found.values()];
  }

  private async sweep(hosts: string[], port: number, budgetMs: number): Promise<DiscoveredPeer[]> {
    const { sweepHosts } = await import('../discovery');
    return sweepHosts(hosts, port, { timeoutMs: Math.max(400, budgetMs), concurrency: 32, perHostTimeoutMs: 700 });
  }
}

/** `ws` named export is a constructor; aliased so the class body reads cleanly. */
const WebSocketCtor: typeof WsClient = WsClient;

function toUint8(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Resolves when `socket.bufferedAmount` drops below the high-water mark. */
function waitForDrain(socket: WsClient, timeoutMs = 5000): Promise<void> {
  if (socket.bufferedAmount <= HIGH_WATER_MARK) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (socket.bufferedAmount <= HIGH_WATER_MARK || socket.readyState !== WsClient.OPEN || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 4);
    timer.unref?.();
  });
}
