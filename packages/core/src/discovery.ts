/**
 * Peer discovery over LAN.
 *
 * Three strategies, tried in this order because each one is cheaper than the next:
 *
 *   1. **UDP beacon** — the Cast broadcasts a small datagram every second; a Stage that is
 *      listening picks it up without scanning anything. Desktop-only: a browser (and an
 *      Android WebView) cannot open a UDP socket, so the Android Stage relies on 2 and 3.
 *   2. **subnet sweep** — probe `ws://<local ip prefix>.1..254:<port>` in parallel, i.e. the
 *      whole /24 the Stage itself sits on. Used by the Android Stage, which can learn its own
 *      IPv4 address from the native plugin.
 *   3. **Manual** — the user types an address. Always available, never removed.
 *
 * The USB transport (说明\连接方式.xlsx) needs no discovery at all: `adb reverse` publishes
 * the Cast on the Stage's own loopback, so the "本机" path covers it.
 */
import { DEFAULT_CAST_PORT, DISCOVERY_MAGIC, type DeviceInfo, type Platform } from './protocol';
import type { DiscoveredPeer } from './bridge';

export interface BeaconPayload {
  magic: string;
  name: string;
  deviceId: string;
  platform: Platform;
  castPort: number;
  version: number;
  /** Bumped on every announce so a Stage can ignore duplicate beacons. */
  seq: number;
}

export function encodeBeacon(p: BeaconPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(p));
}

export function decodeBeacon(bytes: Uint8Array): BeaconPayload | null {
  try {
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith(DISCOVERY_MAGIC)) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Partial<BeaconPayload>;
    if (p.magic !== DISCOVERY_MAGIC || typeof p.castPort !== 'number') return null;
    return {
      magic: DISCOVERY_MAGIC,
      name: typeof p.name === 'string' ? p.name : 'PodiumCast',
      deviceId: typeof p.deviceId === 'string' ? p.deviceId : '',
      platform: (p.platform ?? 'linux') as Platform,
      castPort: p.castPort,
      version: typeof p.version === 'number' ? p.version : 0,
      seq: typeof p.seq === 'number' ? p.seq : 0,
    };
  } catch { return null }
}

/**
 * Every host address in the /24 that contains `ipv4`, most likely first.
 *
 * We order by |last octet − our own| so the peers physically closest on the subnet (routers,
 * APs, adjacent DHCP leases) are tried first; the sweep then usually succeeds in well under
 * a second instead of the full 254 probes.
 */
export function subnetHosts(ipv4: string, ownLastOctet?: number): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4.trim());
  if (!m) return [];
  const prefix = `${m[1]}.${m[2]}.${m[3]}`;
  const self = ownLastOctet ?? Number(m[4]);
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) {
    if (i === self) continue;
    hosts.push(`${prefix}.${i}`);
  }
  hosts.sort((a, b) => {
    const da = Math.abs(Number(a.split('.')[3]) - self);
    const db = Math.abs(Number(b.split('.')[3]) - self);
    return da - db;
  });
  // Our own address last: a same-device Stage may still be reachable there.
  hosts.push(`${prefix}.${self}`);
  return hosts;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Push the probe cost down by giving up on a host sooner than the global timeout. */
  perHostTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolves `true` when a WebSocket handshake to `url` completes in time.
 *
 * A wrong host fails fast (connection refused) and a filtered host fails slowly, so the
 * per-host timeout stays small; the global timeout is what the UI shows.
 */
export function probeWebSocket(url: string, opts: ProbeOptions = {}): Promise<boolean> {
  const perHost = opts.perHostTimeoutMs ?? 900;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      try { ws.close() } catch { /* already closed */ }
      resolve(ok);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), perHost);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    } catch { finish(false) }
  });
}

/** Probes a set of hosts for an open PodiumCast Cast, in parallel with bounded concurrency. */
export async function sweepHosts(
  hosts: string[],
  port = DEFAULT_CAST_PORT,
  opts: ProbeOptions & { concurrency?: number; onFound?: (peer: DiscoveredPeer) => void } = {},
): Promise<DiscoveredPeer[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 24, 128));
  const found: DiscoveredPeer[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 4000);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < hosts.length && Date.now() < deadline && !opts.signal?.aborted) {
      const host = hosts[cursor++];
      const address = `${host}:${port}`;
      // eslint-disable-next-line no-await-in-loop -- bounded concurrency is the point
      const ok = await probeWebSocket(`ws://${address}`, { ...opts, perHostTimeoutMs: Math.min(opts.perHostTimeoutMs ?? 900, Math.max(120, deadline - Date.now())) });
      if (ok) {
        const peer: DiscoveredPeer = { address, port, name: host, platform: null, host, lastSeen: Date.now(), via: 'sweep' };
        found.push(peer);
        opts.onFound?.(peer);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

/** Human label for a discovered peer in the connection list. */
export function peerLabel(peer: DiscoveredPeer): string {
  const where = peer.via === 'loopback' ? '本机' : peer.via === 'usb' ? 'USB' : peer.via === 'manual' ? '手动' : '局域网';
  return `${peer.name} · ${peer.host ?? peer.address} · ${where}`;
}

export function deviceSummary(d: DeviceInfo | null | undefined): string {
  if (!d) return '未知设备';
  const plat = d.platform === 'windows' ? 'Windows' : d.platform === 'macos' ? 'macOS' : d.platform === 'android' ? 'Android' : d.platform;
  return `${d.name}（${plat} ${d.arch}）`;
}
