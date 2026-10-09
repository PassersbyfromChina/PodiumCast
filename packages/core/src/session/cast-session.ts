/**
 * Cast session — the camera-owning half of PodiumCast.
 *
 * Responsibilities, in the order 要求.txt introduces them:
 *   (一) 启动配置 : advertise the available recording specs, auto-match the first display
 *   (二) 应用 ui  : nothing (that lives in packages/ui)
 *   (三) 应用使用 : broadcast live preview, route remote commands, serve the media library
 *
 * The session never touches a camera or a file directly — it emits intents and the UI
 * executes them. That is what lets the identical session class run in Electron's main
 * process (desktop) and inside an Android WebView.
 */
import { Emitter } from '../events';
import {
  DEFAULT_CAST_PORT,
  DISCOVERY_PORT,
  PROTOCOL_VERSION,
  decodePreviewFrame,
  encodePreviewFrame,
  parseControlMessage,
  type ChooseSpecMessage,
  type CommandMessage,
  type ControlCommand,
  type DeviceInfo,
  type DisplaySpec,
  type FileDoneMessage,
  type FileRequestMessage,
  type FileOfferMessage,
  type HelloMessage,
  type LibraryMessage,
  type LibraryRequestMessage,
  type MediaFile,
  type RecordingSpec,
  type SessionState,
  type SpecsMessage,
  type StorageTarget,
  type WelcomeMessage,
} from '../protocol';
import { matchSpec } from '../specs';
import type { CastBridge, MediaStore, PeerInfo } from '../bridge';
import { deviceSummary } from '../discovery';
import { FileReceiver, FileSender, type ReceiveProgress, type SendProgress } from '../transfer';

export interface CastSessionEvents {
  /** The UI must carry this out; results are reported back via `patchState`. */
  intent: { cmd: ControlCommand; fromPeerId: string; fromName: string };
  /** Local UI and every Stage should re-render. */
  state: SessionState;
  /** A Stage connected/disconnected — drives the "已连接" indicator. */
  peers: PeerInfo[];
  /** Someone sent a command; also emitted for local feedback/logging. */
  command: { cmd: ControlCommand; fromPeerId: string; fromName: string };
  /** Incoming file finished writing locally. */
  received: MediaFile;
  transfer: SendProgress | ReceiveProgress;
  /** Human-readable notice for the status strip. */
  notice: { level: 'info' | 'warn' | 'error'; message: string };
  error: { message: string };
}

export function defaultState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mode: 'live',
    recording: false,
    recordingMs: 0,
    previewFps: 0,
    specId: '',
    zoom: 1,
    maxZoom: 1,
    cameraName: '—',
    cameraCount: 0,
    storageTarget: 'cast',
    photoCount: 0,
    videoCount: 0,
    playback: { fileId: null, playing: false, positionMs: 0, durationMs: 0, rate: 1, scale: 1 },
    ...overrides,
  };
}

/** How often the full state is pushed to Stages. 4 Hz is plenty for indicators. */
const STATE_BROADCAST_MS = 250;
/** Heartbeat cadence; peers that miss two in a row are dropped. */
const PING_INTERVAL_MS = 3000;
const PING_TIMEOUT_MS = 9000;

export interface CastSessionOptions {
  bridge: CastBridge;
  store: MediaStore;
  identity: DeviceInfo;
  state?: Partial<SessionState>;
  port?: number;
}

export class CastSession {
  readonly events = new Emitter<CastSessionEvents>();

  private readonly bridge: CastBridge;
  private readonly store: MediaStore;
  readonly identity: DeviceInfo;
  private state: SessionState;
  private port: number;

  private specs: RecordingSpec[] = [];
  private currentSpecId = '';
  private lastMatchNote = '';
  private hasAutoMatched = false;

  /** peerId → handshake bookkeeping. */
  private readonly peers = new Map<string, {
    info: PeerInfo;
    device: DeviceInfo | null;
    lastPongAt: number;
    lastPingSentAt: number;
    rttMs: number;
  }>();

  private readonly inbound: FileReceiver;
  private readonly outbound: Map<string, FileSender> = new Map();
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stateDirty = false;
  private lastStateSentAt = 0;
  private started = false;
  private library: MediaFile[] = [];

  constructor(opts: CastSessionOptions) {
    this.bridge = opts.bridge;
    this.store = opts.store;
    this.identity = opts.identity;
    this.state = defaultState(opts.state);
    this.port = opts.port ?? DEFAULT_CAST_PORT;

    this.inbound = new FileReceiver(
      this.store,
      (p) => this.events.emit('transfer', p),
      (file) => {
        this.library = [file, ...this.library];
        this.events.emit('received', file);
        this.broadcastLibrary();
        this.emitState(true);
      },
      (id, message) => this.events.emit('notice', { level: 'error', message: `接收文件失败 #${id}：${message}` }),
      async () => (await this.store.list()).map((f) => f.name),
    );

    this.wireBridge();
  }

  // ------------------------------------------------------------------ lifecycle

  async start(port = this.port): Promise<number> {
    if (this.started) return this.port;
    this.port = await this.bridge.start(port);
    this.started = true;
    this.library = await this.store.list();
    this.stateTimer = setInterval(() => this.flushState(), STATE_BROADCAST_MS);
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.events.emit('notice', { level: 'info', message: `拍摄端已就绪，监听端口 ${this.port}` });
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.stateTimer = null;
    this.pingTimer = null;
    await this.bridge.stopBeacon().catch(() => undefined);
    await this.bridge.stop().catch(() => undefined);
    this.started = false;
  }

  /**
   * Starts broadcasting the UDP discovery beacon so Stages find this Cast without scanning.
   * Desktop-only by construction: {@link CastBridge.startBeacon} is a no-op where UDP is
   * unavailable.
   */
  async startBeacon(port = DISCOVERY_PORT): Promise<void> {
    try {
      await this.bridge.startBeacon({ port, castPort: this.port, intervalMs: 1000 });
    } catch (err) {
      this.events.emit('notice', { level: 'warn', message: `无法开启局域网广播（可手动输入地址）：${String(err)}` });
    }
  }

  getState(): SessionState { return this.state }
  getSpecs(): RecordingSpec[] { return this.specs }
  getMatchNote(): string { return this.lastMatchNote }
  getPort(): number { return this.port }
  getPeers(): PeerInfo[] { return [...this.peers.values()].map((p) => p.info) }

  // ------------------------------------------------------------------ UI inputs

  /** Called by the UI once the camera has been probed (要求.txt 一：启动配置). */
  setSpecs(specs: RecordingSpec[], currentId?: string): void {
    this.specs = specs;
    if (currentId) this.currentSpecId = currentId;
    else if (!this.currentSpecId && specs.length) this.currentSpecId = specs[0].id;
    this.broadcastSpecs();
    this.emitState(true);
  }

  setCurrentSpec(spec: RecordingSpec, note = ''): void {
    this.currentSpecId = spec.id;
    if (note) this.lastMatchNote = note;
    const msg: SpecsMessage = {
      t: 'specs', specs: this.specs, current: this.currentSpecId,
      autoMatched: this.hasAutoMatched, matchNote: this.lastMatchNote,
    };
    this.broadcast(msg);
    this.emitState(true);
  }

  /** Applies a partial state and schedules a broadcast. */
  patchState(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch, playback: { ...this.state.playback, ...(patch.playback ?? {}) } };
    this.emitState(false);
  }

  patchPlayback(patch: Partial<SessionState['playback']>): void {
    this.state = { ...this.state, playback: { ...this.state.playback, ...patch } };
    this.emitState(false);
  }

  setLibrary(files: MediaFile[]): void {
    this.library = files;
    this.broadcastLibrary();
    this.emitState(true);
  }

  notify(level: 'info' | 'warn' | 'error', message: string): void {
    this.events.emit('notice', { level, message });
  }

  // ------------------------------------------------------------------ media push

  /** Broadcasts one preview JPEG to every Stage. Called from the capture loop. */
  pushPreviewFrame(jpeg: Uint8Array, frameId: number): number {
    if (this.peers.size === 0) return 0;
    this.bridge.broadcast(encodePreviewFrame(frameId, jpeg));
    return this.peers.size;
  }

  announcePreview(info: { width: number; height: number; fps: number; quality: number; testPattern: boolean }): void {
    this.broadcast({ t: 'preview-info', ...info });
  }

  // ------------------------------------------------------------------ internals

  private wireBridge(): void {
    this.bridge.events.on('peer', (info) => {
      this.peers.set(info.id, { info, device: null, lastPongAt: Date.now(), lastPingSentAt: 0, rttMs: 0 });
      const hello: HelloMessage = { t: 'hello', protocol: PROTOCOL_VERSION, device: this.identity };
      this.bridge.send(info.id, JSON.stringify(hello));
      this.events.emit('peers', this.getPeers());
      this.events.emit('notice', { level: 'info', message: `大屏端已接入：${info.address}` });
    });

    this.bridge.events.on('peerGone', ({ id, reason }) => {
      const known = this.peers.get(id);
      this.peers.delete(id);
      this.outbound.delete(id);
      this.events.emit('peers', this.getPeers());
      if (known) this.events.emit('notice', { level: 'warn', message: `大屏端已断开（${reason}）` });
    });

    this.bridge.events.on('text', ({ peerId, message }) => this.onText(peerId, message));
    this.bridge.events.on('binary', ({ peerId, bytes }) => { void this.onBinary(peerId, bytes) });
    this.bridge.events.on('error', ({ message, fatal }) => {
      this.events.emit('notice', { level: fatal ? 'error' : 'warn', message });
      if (fatal) this.events.emit('error', { message });
    });
    this.bridge.events.on('listen', (v) => {
      if ('error' in v) this.events.emit('notice', { level: 'error', message: `监听 ${v.port} 失败：${v.error}` });
    });
  }

  private onText(peerId: string, raw: unknown): void {
    const msg = typeof raw === 'string' ? parseControlMessage(raw) : parseControlMessage(JSON.stringify(raw));
    if (!msg) return;
    const peer = this.peers.get(peerId);
    if (peer) { peer.lastPongAt = Date.now(); peer.info.rttMs = peer.rttMs }

    switch (msg.t) {
      case 'hello': {
        const hello = msg as HelloMessage;
        const device = hello.device;
        if (peer) { peer.device = device; peer.info.role = device.role; peer.info.name = device.name; peer.info.platform = device.platform; peer.info.protocol = hello.protocol }
        const accepted = hello.protocol === PROTOCOL_VERSION;
        const welcome: WelcomeMessage = {
          t: 'welcome', protocol: PROTOCOL_VERSION, device: this.identity, accept: accepted,
          reason: accepted ? undefined : `协议版本不一致（本机 v${PROTOCOL_VERSION}，对端 v${hello.protocol}）`,
        };
        this.bridge.send(peerId, JSON.stringify(welcome));
        if (!accepted) { this.bridge.closePeer(peerId, 'protocol mismatch'); return }
        // 要求.txt (一): the first Stage to connect drives the recording aspect.
        if (hello.display) this.handleDisplay(hello.display, peerId);
        this.events.emit('peers', this.getPeers());
        this.sendSpecsTo(peerId);
        this.sendStateTo(peerId);
        this.sendLibraryTo(peerId);
        this.events.emit('notice', { level: 'info', message: `已连接 ${deviceSummary(device)}` });
        return;
      }
      case 'display': {
        // Stage re-reported its screen (window moved / display changed): re-match on demand.
        this.applyDisplayMatch((msg as { display: DisplaySpec }).display, true);
        return;
      }
      case 'command': {
        const cmd = (msg as CommandMessage).cmd;
        const name = peer?.device ? peer.device.name : peerId;
        this.events.emit('command', { cmd, fromPeerId: peerId, fromName: name });
        if (cmd.k === 'library-request') { this.sendLibraryTo(peerId); return }
        if (cmd.k === 'match-display') { this.applyDisplayMatch(this.lastDisplay, true); return }
        this.events.emit('intent', { cmd, fromPeerId: peerId, fromName: name });
        return;
      }
      case 'specs': {
        // A Stage may advertise its own spec list when *it* owns the camera; not our case.
        return;
      }
      case 'choose-spec': {
        const choose = msg as ChooseSpecMessage;
        this.events.emit('intent', { cmd: { k: 'request-spec', id: choose.id }, fromPeerId: peerId, fromName: peer?.device?.name ?? peerId });
        return;
      }
      case 'file-request': {
        void this.serveFile(peerId, msg as FileRequestMessage);
        return;
      }
      case 'file-offer': {
        // The Stage is pushing a file we asked for ("互相拉取").
        void this.inbound.begin(msg as FileOfferMessage).catch((err: unknown) => {
          this.events.emit('notice', { level: 'error', message: `无法创建接收文件：${String(err)}` });
        });
        return;
      }
      case 'file-done': {
        this.outbound.get(peerId)?.settle(msg as FileDoneMessage);
        return;
      }
      case 'ping': {
        this.bridge.send(peerId, JSON.stringify({ t: 'pong', ts: Date.now(), echo: (msg as { ts: number }).ts }));
        return;
      }
      case 'pong': {
        if (peer && peer.lastPingSentAt) {
          peer.rttMs = Math.max(0, Date.now() - peer.lastPingSentAt);
          peer.info.rttMs = peer.rttMs;
        }
        return;
      }
      default: return;
    }
  }

  private lastDisplay: DisplaySpec | null = null;

  /**
   * 要求.txt (一): "第一次连接大屏时，匹配与大屏相同或最为接近的拍摄比例。"
   * We only *force* a switch the first time; afterwards the user's manual choice wins and
   * the Stage merely sees the recommendation.
   */
  private applyDisplayMatch(display: DisplaySpec | null, force = false): void {
    if (!display) return;
    this.lastDisplay = display;
    if (!this.specs.length) { this.lastMatchNote = '等待拍摄端枚举录制规格'; return }
    const result = matchSpec(this.specs, display);
    if (!result.spec) return;
    const changed = result.spec.id !== this.currentSpecId;
    this.lastMatchNote = result.note;
    const firstTime = force ? !this.hasAutoMatched : !this.hasAutoMatched;
    if (changed && (firstTime || force)) {
      this.hasAutoMatched = true;
      this.events.emit('intent', {
        cmd: { k: 'request-spec', id: result.spec.id },
        fromPeerId: '',
        fromName: `大屏匹配 ${display.width}×${display.height}`,
      });
    }
    this.hasAutoMatched = true;
  }

  /** Feeds the display spec the Stage reported at handshake time. */
  handleDisplay(display: DisplaySpec | undefined, peerId: string): void {
    if (!display) return;
    this.lastDisplay = display;
    this.applyDisplayMatch(display);
    this.broadcastSpecs();
    void peerId;
  }

  private async onBinary(peerId: string, bytes: Uint8Array): Promise<void> {
    if (decodePreviewFrame(bytes)) return; // a Stage should never send preview frames
    try { await this.inbound.push(bytes) }
    catch (err) { this.events.emit('notice', { level: 'error', message: `写入失败：${String(err)}` }) }
  }

  private async serveFile(peerId: string, req: FileRequestMessage): Promise<void> {
    const file = this.library.find((f) => f.id === req.id) ?? (await this.store.list()).find((f) => f.id === req.id);
    if (!file) {
      this.bridge.send(peerId, JSON.stringify({ t: 'error', message: `未找到文件 ${req.name}` }));
      return;
    }
    await this.sendFileTo(peerId, file);
  }

  /**
   * Pushes a freshly recorded file to every connected Stage.
   *
   * 要求.txt (三): "视频文件默认存在 PodiumCast-Cast 应用，可以选择存在 PodiumCast-Stage
   * 应用" — when the user picks 大屏端 as a storage target, the Cast does not wait to be
   * asked; it offers the file the moment recording finishes.
   */
  async pushFile(file: MediaFile): Promise<void> {
    for (const peerId of [...this.peers.keys()]) {
      // eslint-disable-next-line no-await-in-loop -- one transfer at a time per peer
      await this.sendFileTo(peerId, file);
    }
  }

  private async sendFileTo(peerId: string, file: MediaFile): Promise<void> {
    let sender = this.outbound.get(peerId);
    if (!sender) {
      sender = new FileSender(
        { send: (d) => this.bridge.send(peerId, d), flush: () => this.bridge.flush(peerId) },
        this.store,
        (p) => this.events.emit('transfer', p),
      );
      this.outbound.set(peerId, sender);
    }
    try {
      // FileSender owns offer → chunks → done, so the Stage never needs a side channel.
      await sender.send(file);
      this.events.emit('notice', { level: 'info', message: `已发送 ${file.name}` });
    } catch (err) {
      this.events.emit('notice', { level: 'error', message: `发送 ${file.name} 失败：${String(err)}` });
    }
  }

  // ------------------------------------------------------------------ outbound

  private broadcast(msg: unknown): void {
    if (this.peers.size === 0) return;
    this.bridge.broadcast(JSON.stringify(msg));
  }

  private broadcastSpecs(): void {
    const msg: SpecsMessage = {
      t: 'specs', specs: this.specs, current: this.currentSpecId,
      autoMatched: this.hasAutoMatched, matchNote: this.lastMatchNote,
    };
    this.broadcast(msg);
  }

  private sendSpecsTo(peerId: string): void {
    const msg: SpecsMessage = {
      t: 'specs', specs: this.specs, current: this.currentSpecId,
      autoMatched: this.hasAutoMatched, matchNote: this.lastMatchNote,
    };
    this.bridge.send(peerId, JSON.stringify(msg));
  }

  private broadcastLibrary(): void {
    const msg: LibraryMessage = { t: 'library', files: this.library, storageTarget: this.state.storageTarget, owner: 'cast' };
    this.broadcast(msg);
  }

  private sendLibraryTo(peerId: string): void {
    const msg: LibraryMessage = { t: 'library', files: this.library, storageTarget: this.state.storageTarget, owner: 'cast' };
    this.bridge.send(peerId, JSON.stringify(msg));
  }

  private sendStateTo(peerId: string): void {
    this.bridge.send(peerId, JSON.stringify({ t: 'state', state: this.state }));
  }

  private emitState(immediate: boolean): void {
    this.events.emit('state', this.state);
    this.stateDirty = true;
    if (immediate) this.flushState();
  }

  private flushState(force = false): void {
    if (!this.stateDirty && !force) return;
    const now = Date.now();
    if (!force && now - this.lastStateSentAt < STATE_BROADCAST_MS) return;
    this.lastStateSentAt = now;
    this.stateDirty = false;
    if (this.peers.size === 0) return;
    this.broadcast({ t: 'state', state: this.state });
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const [id, peer] of [...this.peers]) {
      if (peer.lastPingSentAt && now - peer.lastPongAt > PING_TIMEOUT_MS) {
        this.bridge.closePeer(id, '心跳超时');
        this.peers.delete(id);
        this.events.emit('peers', this.getPeers());
        this.events.emit('notice', { level: 'warn', message: '大屏端心跳超时，已断开' });
        continue;
      }
      peer.lastPingSentAt = now;
      this.bridge.send(id, JSON.stringify({ t: 'ping', ts: now }));
    }
  }
}

/** Re-exported so the UI can build a request without importing the protocol module. */
export type { LibraryRequestMessage, StorageTarget };
