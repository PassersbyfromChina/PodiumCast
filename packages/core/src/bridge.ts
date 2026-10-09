/**
 * Platform abstraction layer.
 *
 * Everything above this line is plain TypeScript that runs unchanged in Electron's main
 * process, Electron's renderer and an Android WebView. Everything below it is one of:
 *
 *   - {@link ./node/ws-server}  — `ws` + `node:dgram`, used by the Electron main process
 *   - a Capacitor plugin        — the same contract, backed by an embedded Java WebSocket
 *                                 server (`apps/android/.../PodiumCastLanPlugin.java`)
 *   - a plain browser client    — the Stage side needs nothing but the platform WebSocket
 *
 * Keeping the seam here is what lets the same recording-spec negotiation, control routing
 * and file-transfer logic serve all five shipping targets (win x64/x86/arm64, macOS,
 * Android).
 */
import type { DisplaySpec, MediaFile, Platform, Role } from './protocol';
import type { Emitter } from './events';

export interface PeerInfo {
  id: string;
  /** `null` until the peer's `hello` arrives. */
  role: Role | null;
  name: string;
  platform: Platform | null;
  address: string;
  connectedAt: number;
  /** Round-trip time in ms, refreshed by the heartbeat. */
  rttMs: number;
  protocol: number | null;
}

export interface DiscoveredPeer {
  address: string;
  port: number;
  name: string;
  platform: Platform | null;
  host: string | null;
  /** Epoch millis of the last beacon. */
  lastSeen: number;
  /** Which transport found it, for the connection dialog. */
  via: 'udp' | 'loopback' | 'manual' | 'usb' | 'sweep';
}

export interface BridgeEvents {
  /** A transport-level peer appeared. `info.role` may still be null. */
  peer: PeerInfo;
  peerGone: { id: string; reason: string };
  /** A JSON control message arrived. `peerId` is empty for client bridges. */
  text: { peerId: string; message: unknown };
  /** A binary media frame arrived. */
  binary: { peerId: string; bytes: Uint8Array };
  /** Transport-level failure; the session decides whether to reconnect. */
  error: { message: string; fatal: boolean };
  /** Server listen state (Cast bridge only). */
  listen: { port: number; addresses: string[] } | { port: number; error: string };
}

export interface DeviceIdentity {
  id: string;
  name: string;
  platform: Platform;
  arch: string;
  appVersion: string;
}

export interface MediaStoreEvents {
  changed: MediaFile[];
}

/** Byte-level media storage, implemented per platform (node fs / Capacitor Filesystem). */
export interface MediaStore {
  readonly events: Emitter<MediaStoreEvents>;
  list(): Promise<MediaFile[]>;
  /** Where files land, shown in Settings so the user can find them. */
  location(): Promise<string>;
  /** Opens an append-only writer; returns an opaque handle. */
  beginWrite(name: string, kind: 'photo' | 'video', meta: { mime: string; width: number; height: number; createdAt: number }): Promise<string>;
  appendWrite(handle: string, bytes: Uint8Array): Promise<void>;
  /** Finalises the file, fills in size/duration and returns the completed entry. */
  endWrite(handle: string, durationMs: number): Promise<MediaFile>;
  abortWrite(handle: string): Promise<void>;
  readAll(id: string): Promise<Uint8Array>;
  /**
   * Reads `[offset, offset+length)` of a stored file. File transfer streams in 255 KiB
   * chunks through this, so a 4 GB clip never has to fit in memory on either peer.
   */
  readRange(id: string, offset: number, length: number): Promise<Uint8Array>;
  remove(id: string): Promise<void>;
  /** Playable URL for `<img>`/`<video>` inside the owning app. */
  urlFor(file: MediaFile): string;
}

/**
 * The Cast half of the transport: it owns the listening socket and fans out to many Stages.
 */
export interface CastBridge {
  readonly events: Emitter<BridgeEvents>;
  readonly role: 'cast';
  start(port: number): Promise<number>;
  stop(): Promise<void>;
  broadcast(data: string | Uint8Array): void;
  send(peerId: string, data: string | Uint8Array): void;
  /**
   * Resolves once the socket send buffer has drained below the high-water mark.
   * File transfer awaits this between chunks so a fast disk cannot inflate the socket
   * buffer to the size of the whole video.
   */
  flush(peerId?: string): Promise<void>;
  closePeer(peerId: string, reason: string): void;
  peers(): PeerInfo[];
  /** Local IPv4 addresses the Stage can dial directly. */
  localAddresses(): Promise<string[]>;
  /** Best-effort UDP beacon; no-op on platforms without UDP. */
  startBeacon(opts: { port: number; castPort: number; intervalMs: number }): Promise<void>;
  stopBeacon(): Promise<void>;
}

/** The Stage half of the transport: a single outbound connection. */
export interface StageBridge {
  readonly events: Emitter<BridgeEvents>;
  readonly role: 'stage';
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  send(data: string | Uint8Array): void;
  flush(): Promise<void>;
  get connected(): boolean;
  get url(): string | null;
  /** UDP listen + optional /24 sweep; returns everything found within the window. */
  discover(opts: { timeoutMs: number; port: number; sweep?: boolean }): Promise<DiscoveredPeer[]>;
}

export interface DisplayProbe {
  /** Reads the current screen. Re-read on window move for multi-monitor setups. */
  read(): DisplaySpec;
  onChanged(cb: (spec: DisplaySpec) => void): () => void;
}
