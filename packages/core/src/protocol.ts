/**
 * PodiumCast wire protocol — the contract shared by every Cast and Stage build.
 *
 * Design notes
 * ------------
 * PodiumCast is "one camera, two previews, optionally two storages". A *Cast* peer owns the
 * camera and is always the WebSocket **server**; a *Stage* peer is always the **client**.
 * That holds for all five transports described in 说明\连接方式.xlsx:
 *
 *   - 本机 (same device)   : Stage dials 127.0.0.1
 *   - LAN  (局域网)          : Stage dials the Cast's private IPv4 address
 *   - USB                   : `adb reverse tcp:8765 tcp:8765` makes the Cast reachable on
 *                             the Stage's own 127.0.0.1, so the LAN code path is reused
 *
 * Two payload classes travel over that one socket:
 *
 *   - **text** frames  : JSON control messages ({@link ControlMessage})
 *   - **binary** frames: length-efficient media frames, see {@link encodeMediaFrame}
 *
 * Keeping control and media on a single socket means a Stage only ever needs one port open,
 * which matters on Android where the Cast app runs an embedded WebSocket server.
 */

/** Bumped whenever a field changes meaning. Peers refuse to pair across major versions. */
export const PROTOCOL_VERSION = 1;

/** Default TCP port the Cast listens on and the Stage dials. */
export const DEFAULT_CAST_PORT = 8765;

/** UDP port used for LAN auto-discovery beacons (desktop Cast peers only). */
export const DISCOVERY_PORT = 8766;

/** Magic prefix so a stray UDP packet on 8766 is never mistaken for a PodiumCast beacon. */
export const DISCOVERY_MAGIC = 'PODIUMCAST-DISCOVERY/1';

/** Binary frame kinds. First byte of every binary WebSocket message. */
export const MEDIA_FRAME_PREVIEW = 0x01;
export const MEDIA_FRAME_FILE_CHUNK = 0x02;

/** Bytes of JPEG payload per preview frame chunk header (kind + uint32 frame id). */
export const PREVIEW_HEADER_BYTES = 5;
/** kind + uint32 transferId + uint32 chunkIndex. */
export const FILE_CHUNK_HEADER_BYTES = 9;

/** Largest single WebSocket message we emit. 256 KiB is safe on every target runtime. */
export const MAX_FRAME_BYTES = 256 * 1024;

export type Role = 'cast' | 'stage';

export type Platform = 'windows' | 'macos' | 'android' | 'linux';

/** Which side owns the recorded file. Mirrors 要求.txt: default is the Cast. */
export type StorageTarget = 'cast' | 'stage' | 'both';

export type CameraKind = 'photo' | 'video';

/** A colour gamut the capture pipeline can be asked for. */
export type ColorSpace = 'srgb' | 'rec709' | 'p3' | 'rec2020';

export interface DeviceInfo {
  /** Stable per-installation id (persisted), used to remember pairings. */
  id: string;
  /** Human readable, shown in the peer list. */
  name: string;
  role: Role;
  platform: Platform;
  /** `x64` | `x32` | `arm` | `arm64` — matches the installer naming in 交付物.xlsx. */
  arch: string;
  appVersion: string;
}

/** A capture format the Cast can actually produce, before any pairing happened. */
export interface RecordingSpec {
  /** Stable key, e.g. `1920x1080@30|rec709`. */
  id: string;
  width: number;
  height: number;
  /** `16:9`, `4:3`, `9:16`, `1:1`, … derived from width/height and normalised. */
  aspect: string;
  /** Exact ratio, used for tolerance comparisons. */
  ratio: number;
  fps: number;
  colorSpace: ColorSpace;
  /** What the user sees in the settings list. */
  label: string;
  /** True when the browser/OS reports this as the camera's native mode. */
  native?: boolean;
  /** True when the capture device exposes a hardware zoom range for this mode. */
  zoomable?: boolean;
  maxZoom?: number;
}

/** What the big screen can display. Read on Stage startup, sent to the Cast on connect. */
export interface DisplaySpec {
  width: number;
  height: number;
  aspect: string;
  ratio: number;
  /** Physical refresh rate reported by the display, if known. */
  fps: number;
  /** Best-effort guess: `p3` on Apple panels, `srgb` elsewhere. */
  colorSpace: ColorSpace;
  /** `true` when the Stage window is fullscreen on the target display. */
  fullscreen: boolean;
  devicePixelRatio: number;
}

export interface MediaFile {
  id: string;
  name: string;
  kind: CameraKind;
  mime: string;
  size: number;
  width: number;
  height: number;
  /** Recording length; 0 for photos. */
  durationMs: number;
  /** Epoch millis. */
  createdAt: number;
  origin: Role;
  /** Cast-local absolute path or Stage-local path. Never sent to a browser context. */
  localPath?: string;
  /** Playable URL inside the owning app (blob:, http://localhost/_capacitor_file_/, …). */
  url?: string;
}

/** Realtime snapshot the Cast broadcasts; drives every remote indicator on the Stage. */
export interface SessionState {
  mode: 'live' | 'playback';
  recording: boolean;
  recordingMs: number;
  previewFps: number;
  specId: string;
  zoom: number;
  maxZoom: number;
  cameraName: string;
  cameraCount: number;
  storageTarget: StorageTarget;
  photoCount: number;
  videoCount: number;
  /** Playback state, only meaningful when `mode === 'playback'`. */
  playback: {
    fileId: string | null;
    playing: boolean;
    positionMs: number;
    durationMs: number;
    rate: number;
    scale: number;
  };
  /** Last error surfaced to the UI, if any. */
  lastError?: string;
}

// ---------------------------------------------------------------------------------------
// Control messages (WebSocket text frames, JSON encoded)
// ---------------------------------------------------------------------------------------

export interface HelloMessage {
  t: 'hello';
  protocol: number;
  device: DeviceInfo;
  /**
   * Stage → Cast only: the screen this Stage is showing on. Folded into the handshake so the
   * Cast can pick a matching recording aspect before the first preview frame is sent
   * (要求.txt 一：启动配置 — "第一次连接大屏时，匹配与大屏相同或最为接近的拍摄比例").
   */
  display?: DisplaySpec;
}

export interface WelcomeMessage {
  t: 'welcome';
  protocol: number;
  device: DeviceInfo;
  /** Echoes the Stage display so the Cast can pick a matching recording aspect. */
  display?: DisplaySpec;
  /** Rejected handshake: the socket is closed right after this is delivered. */
  accept: boolean;
  reason?: string;
}

export interface SpecsMessage {
  t: 'specs';
  specs: RecordingSpec[];
  current: string;
  /** Set when the Cast chose the spec by matching the Stage's display on first connect. */
  autoMatched?: boolean;
  matchNote?: string;
}

export interface ChooseSpecMessage {
  t: 'choose-spec';
  id: string;
  /** `true` when the Stage is only suggesting; `false` forces the switch. */
  request?: boolean;
}

export interface SpecChangedMessage {
  t: 'spec-changed';
  spec: RecordingSpec;
  autoMatched?: boolean;
  matchNote?: string;
}

export interface StateMessage {
  t: 'state';
  state: SessionState;
}

export interface CommandMessage {
  t: 'command';
  cmd: ControlCommand;
}

export interface LibraryMessage {
  t: 'library';
  files: MediaFile[];
  storageTarget: StorageTarget;
  /** Which side produced this listing. */
  owner: Role;
}

export interface LibraryRequestMessage {
  t: 'library-request';
  owner: Role;
}

/** Asks the peer to stream a file back. `id` is only unique within the owner's library. */
export interface FileRequestMessage {
  t: 'file-request';
  id: string;
  name: string;
  /** Where the requester wants the bytes stored once the transfer lands. */
  saveAs?: boolean;
}

export interface FileOfferMessage {
  t: 'file-offer';
  transferId: number;
  name: string;
  kind: CameraKind;
  size: number;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  createdAt: number;
}

export interface FileDoneMessage {
  t: 'file-done';
  transferId: number;
  /** `false` when the sender aborted mid-stream. */
  ok: boolean;
  error?: string;
}

export interface PingMessage { t: 'ping'; ts: number }
export interface PongMessage { t: 'pong'; ts: number; echo: number }
export interface ErrorMessage { t: 'error'; message: string; fatal?: boolean }

/** Sent by the Cast to describe where its preview is currently coming from. */
export interface PreviewInfoMessage {
  t: 'preview-info';
  width: number;
  height: number;
  fps: number;
  quality: number;
  /** Synthetic test pattern is running because no camera was found. */
  testPattern: boolean;
}

/**
 * Stage → Cast: the screen changed (window dragged to another monitor, fullscreen toggled,
 * resolution switched). Carries the same payload as the handshake so the Cast can re-run
 * aspect matching with one code path.
 */
export interface DisplayMessage {
  t: 'display';
  display: DisplaySpec;
}

export type ControlMessage =
  | HelloMessage
  | WelcomeMessage
  | SpecsMessage
  | ChooseSpecMessage
  | SpecChangedMessage
  | StateMessage
  | CommandMessage
  | LibraryMessage
  | LibraryRequestMessage
  | FileRequestMessage
  | FileOfferMessage
  | FileDoneMessage
  | PingMessage
  | PongMessage
  | ErrorMessage
  | PreviewInfoMessage
  | DisplayMessage;

// ---------------------------------------------------------------------------------------
// Remote control verbs
// ---------------------------------------------------------------------------------------

export type ControlCommand =
  /** Take a still. */
  | { k: 'photo' }
  | { k: 'record-start' }
  | { k: 'record-stop' }
  /** Absolute zoom factor, clamped by the Cast to its own range. */
  | { k: 'zoom'; value: number }
  | { k: 'zoom-step'; delta: number }
  | { k: 'switch-camera'; deviceId?: string }
  | { k: 'cycle-camera' }
  | { k: 'set-storage'; target: StorageTarget }
  /** Ask the Cast to re-run spec matching against the Stage display. */
  | { k: 'match-display' }
  | { k: 'request-spec'; id: string }
  | { k: 'library-request' }
  | { k: 'delete-file'; id: string }
  | { k: 'playback-open'; id: string }
  | { k: 'playback-close' }
  | { k: 'playback-toggle' }
  | { k: 'playback-seek'; positionMs: number }
  | { k: 'playback-rate'; rate: number }
  | { k: 'playback-zoom'; scale: number };

export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2, 4] as const;
export const PLAYBACK_SCALE_MIN = 1;
export const PLAYBACK_SCALE_MAX = 8;

// ---------------------------------------------------------------------------------------
// Binary framing
// ---------------------------------------------------------------------------------------

/**
 * Preview frame: `[0x01][uint32 frameId][jpeg bytes…]`.
 * Every frame is standalone (a full JPEG), so a dropped frame only costs one frame of
 * latency instead of corrupting the stream.
 */
export function encodePreviewFrame(frameId: number, jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(PREVIEW_HEADER_BYTES + jpeg.byteLength);
  out[0] = MEDIA_FRAME_PREVIEW;
  new DataView(out.buffer).setUint32(1, frameId >>> 0, false);
  out.set(jpeg, PREVIEW_HEADER_BYTES);
  return out;
}

export interface DecodedPreviewFrame { frameId: number; jpeg: Uint8Array }

export function decodePreviewFrame(buf: Uint8Array): DecodedPreviewFrame | null {
  if (buf.byteLength <= PREVIEW_HEADER_BYTES || buf[0] !== MEDIA_FRAME_PREVIEW) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { frameId: view.getUint32(1, false), jpeg: buf.subarray(PREVIEW_HEADER_BYTES) };
}

/** File chunk: `[0x02][uint32 transferId][uint32 chunkIndex][payload…]`. */
export function encodeFileChunk(transferId: number, chunkIndex: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FILE_CHUNK_HEADER_BYTES + payload.byteLength);
  out[0] = MEDIA_FRAME_FILE_CHUNK;
  const view = new DataView(out.buffer);
  view.setUint32(1, transferId >>> 0, false);
  view.setUint32(5, chunkIndex >>> 0, false);
  out.set(payload, FILE_CHUNK_HEADER_BYTES);
  return out;
}

export interface DecodedFileChunk { transferId: number; chunkIndex: number; payload: Uint8Array }

export function decodeFileChunk(buf: Uint8Array): DecodedFileChunk | null {
  if (buf.byteLength < FILE_CHUNK_HEADER_BYTES || buf[0] !== MEDIA_FRAME_FILE_CHUNK) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    transferId: view.getUint32(1, false),
    chunkIndex: view.getUint32(5, false),
    payload: buf.subarray(FILE_CHUNK_HEADER_BYTES),
  };
}

/** Payload bytes per file chunk, sized so a full message stays under {@link MAX_FRAME_BYTES}. */
export const FILE_CHUNK_PAYLOAD_BYTES = MAX_FRAME_BYTES - FILE_CHUNK_HEADER_BYTES - 1024;

export function isControlMessage(value: unknown): value is ControlMessage {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string';
}

/** Parses an inbound text frame, returning `null` for anything malformed. */
export function parseControlMessage(text: string): ControlMessage | null {
  try {
    const v: unknown = JSON.parse(text);
    return isControlMessage(v) ? v : null;
  } catch { return null }
}
