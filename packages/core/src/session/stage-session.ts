/**
 * Stage session — the big-screen half of PodiumCast.
 *
 * It is always the WebSocket client and owns:
 *   - reading the display it is presenting on and reporting it during the handshake
 *     (要求.txt 一：启动配置 — "读取大屏幕的规格……检查 PodiumCast-Cast 应用是否在工作"),
 *   - rendering the live preview stream the Cast pushes,
 *   - forwarding user commands back to the Cast (拍摄 / 变焦 / 回放),
 *   - keeping its own copy of the media library when the user stores files here.
 */
import { Emitter } from '../events';
import {
  decodePreviewFrame,
  parseControlMessage,
  type CommandMessage,
  type ControlCommand,
  type DeviceInfo,
  type DisplaySpec,
  type FileDoneMessage,
  type FileOfferMessage,
  type FileRequestMessage,
  type HelloMessage,
  type LibraryMessage,
  type MediaFile,
  type PreviewInfoMessage,
  type RecordingSpec,
  type SessionState,
  type SpecsMessage,
  type StorageTarget,
  type WelcomeMessage,
} from '../protocol';
import type { MediaStore, StageBridge, DiscoveredPeer } from '../bridge';
import { FileReceiver, FileSender, type ReceiveProgress, type SendProgress } from '../transfer';
import { deviceSummary } from '../discovery';
import { defaultState } from './cast-session';

export type StageStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface StageSessionEvents {
  status: { status: StageStatus; message?: string };
  welcome: { device: DeviceInfo; accept: boolean; reason?: string };
  specs: { specs: RecordingSpec[]; current: string; autoMatched: boolean; matchNote: string };
  state: SessionState;
  library: { files: MediaFile[]; storageTarget: StorageTarget };
  /** One decoded preview frame; `jpeg` is a view into the transport buffer. */
  preview: { frameId: number; jpeg: Uint8Array };
  previewInfo: PreviewInfoMessage;
  /** A file arrived from the Cast and is now on local disk. */
  received: MediaFile;
  transfer: SendProgress | ReceiveProgress;
  notice: { level: 'info' | 'warn' | 'error'; message: string };
  peers: DiscoveredPeer[];
}

export interface StageSessionOptions {
  bridge: StageBridge;
  store: MediaStore;
  identity: DeviceInfo;
  display: () => DisplaySpec;
}

export class StageSession {
  readonly events = new Emitter<StageSessionEvents>();

  private readonly bridge: StageBridge;
  private readonly store: MediaStore;
  private readonly display: () => DisplaySpec;
  readonly identity: DeviceInfo;

  private status: StageStatus = 'idle';
  private host: DeviceInfo | null = null;
  private specList: RecordingSpec[] = [];
  private currentSpecId = '';
  private matchNote = '';
  private autoMatched = false;
  private state: SessionState = defaultState();
  private libraryFiles: MediaFile[] = [];
  private previewInfo: PreviewInfoMessage | null = null;

  private readonly inbound: FileReceiver;
  private outbound: FileSender | null = null;
  private lastFrameAt = 0;
  private framesInWindow = 0;
  private measuredFps = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: StageSessionOptions) {
    this.bridge = opts.bridge;
    this.store = opts.store;
    this.display = opts.display;
    this.identity = opts.identity;

    this.inbound = new FileReceiver(
      this.store,
      (p) => this.events.emit('transfer', p),
      (file) => {
        this.libraryFiles = [file, ...this.libraryFiles];
        this.events.emit('received', file);
        this.events.emit('library', { files: this.libraryFiles, storageTarget: this.state.storageTarget });
        this.events.emit('notice', { level: 'info', message: `已接收并保存 ${file.name}` });
      },
      (id, message) => this.events.emit('notice', { level: 'error', message: `接收文件失败 #${id}：${message}` }),
      async () => (await this.store.list()).map((f) => f.name),
    );

    this.wire();
  }

  // ------------------------------------------------------------------ lifecycle

  async connect(url: string): Promise<void> {
    this.setStatus('connecting', `正在连接 ${url}`);
    await this.bridge.connect(url);
  }

  async disconnect(): Promise<void> {
    await this.bridge.disconnect();
    this.setStatus('idle', '已断开');
    this.host = null;
  }

  getStatus(): StageStatus { return this.status }
  getHost(): DeviceInfo | null { return this.host }
  getState(): SessionState { return this.state }
  getSpecs(): RecordingSpec[] { return this.specList }
  getCurrentSpecId(): string { return this.currentSpecId }
  getMatchNote(): string { return this.matchNote }
  getLibrary(): MediaFile[] { return this.libraryFiles }
  getPreviewInfo(): PreviewInfoMessage | null { return this.previewInfo }
  getMeasuredFps(): number { return this.measuredFps }

  /** Re-reads the screen and pushes it to the Cast (multi-monitor / fullscreen changes). */
  reportDisplay(): void {
    if (!this.bridge.connected) return;
    this.bridge.send(JSON.stringify({ t: 'display', display: this.display() }));
  }

  /** Scans the LAN for reachable Cast peers. */
  discover(opts: { timeoutMs?: number; port?: number; sweep?: boolean } = {}): Promise<DiscoveredPeer[]> {
    return this.bridge.discover({ timeoutMs: opts.timeoutMs ?? 3500, port: opts.port ?? 8765, sweep: opts.sweep ?? true });
  }

  // ------------------------------------------------------------------ commands

  send(cmd: ControlCommand): void {
    if (!this.bridge.connected) { this.events.emit('notice', { level: 'warn', message: '尚未连接拍摄端' }); return }
    const msg: CommandMessage = { t: 'command', cmd };
    this.bridge.send(JSON.stringify(msg));
  }

  /** Pulls a file that lives on the Cast into this Stage's own library. */
  requestFile(file: MediaFile): void {
    if (!this.bridge.connected) return;
    const req: FileRequestMessage = { t: 'file-request', id: file.id, name: file.name, saveAs: true };
    this.bridge.send(JSON.stringify(req));
    this.events.emit('notice', { level: 'info', message: `正在拉取 ${file.name} …` });
  }

  setStorageTarget(target: StorageTarget): void {
    this.state = { ...this.state, storageTarget: target };
    this.events.emit('state', this.state);
    this.send({ k: 'set-storage', target });
  }

  // ------------------------------------------------------------------ internals

  private setStatus(status: StageStatus, message?: string): void {
    this.status = status;
    this.events.emit('status', { status, message });
  }

  private wire(): void {
    this.bridge.events.on('peer', (info) => {
      this.events.emit('notice', { level: 'info', message: `已建立链路 ${info.address}，等待握手…` });
    });

    this.bridge.events.on('peerGone', ({ reason }) => {
      this.setStatus('idle', `连接已断开（${reason}）`);
      this.host = null;
      this.events.emit('notice', { level: 'warn', message: `与拍摄端断开（${reason}）` });
    });

    this.bridge.events.on('text', ({ message }) => this.onText(message));
    this.bridge.events.on('binary', ({ bytes }) => void this.onBinary(bytes));
    this.bridge.events.on('error', ({ message }) => {
      this.setStatus('error', message);
      this.events.emit('notice', { level: 'error', message });
    });

    // Sliding one-second window so the UI can show an honest "接收帧率".
    this.statusTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastFrameAt > 2000) { this.measuredFps = 0; return }
      this.measuredFps = this.framesInWindow;
      this.framesInWindow = 0;
    }, 1000);
  }

  private onText(raw: unknown): void {
    const msg = typeof raw === 'string' ? parseControlMessage(raw) : parseControlMessage(JSON.stringify(raw));
    if (!msg) return;
    switch (msg.t) {
      case 'hello': {
        // The Cast greets us first; answer with our identity *and* our display.
        const hello: HelloMessage = { t: 'hello', protocol: (msg as HelloMessage).protocol, device: this.identity, display: this.display() };
        this.bridge.send(JSON.stringify(hello));
        return;
      }
      case 'welcome': {
        const w = msg as WelcomeMessage;
        if (!w.accept) {
          this.setStatus('error', w.reason ?? '对端拒绝连接');
          this.events.emit('welcome', { device: w.device, accept: false, reason: w.reason });
          return;
        }
        this.host = w.device;
        this.setStatus('connected', `已连接 ${deviceSummary(w.device)}`);
        this.events.emit('welcome', { device: w.device, accept: true });
        return;
      }
      case 'specs': {
        const s = msg as SpecsMessage;
        this.specList = s.specs;
        this.currentSpecId = s.current;
        this.matchNote = s.matchNote ?? '';
        this.autoMatched = Boolean(s.autoMatched);
        this.events.emit('specs', { specs: s.specs, current: s.current, autoMatched: this.autoMatched, matchNote: this.matchNote });
        return;
      }
      case 'spec-changed': {
        this.currentSpecId = (msg as { spec: RecordingSpec }).spec.id;
        return;
      }
      case 'state': {
        this.state = (msg as { state: SessionState }).state;
        this.events.emit('state', this.state);
        return;
      }
      case 'library': {
        const l = msg as LibraryMessage;
        // Cast listings are authoritative for the remote library; local files stay local.
        this.libraryFiles = this.mergeLibraries(this.libraryFiles, l.files);
        this.events.emit('library', { files: this.libraryFiles, storageTarget: l.storageTarget });
        return;
      }
      case 'preview-info': {
        this.previewInfo = msg as PreviewInfoMessage;
        this.events.emit('previewInfo', this.previewInfo);
        return;
      }
      case 'file-offer': {
        // The Cast is pushing a file (either because we asked, or because 要求.txt's
        // "选择存在 Stage" made it push a fresh recording).
        void this.inbound.begin(msg as FileOfferMessage).catch((err: unknown) => {
          this.events.emit('notice', { level: 'error', message: `无法创建接收文件：${String(err)}` });
        });
        return;
      }
      case 'file-request': {
        void this.serveFile(msg as FileRequestMessage);
        return;
      }
      case 'file-done': {
        void this.inbound.finish(msg as FileDoneMessage);
        this.outbound?.settle(msg as FileDoneMessage);
        return;
      }
      case 'ping': {
        this.bridge.send(JSON.stringify({ t: 'pong', ts: Date.now(), echo: (msg as { ts: number }).ts }));
        return;
      }
      case 'error': {
        this.events.emit('notice', { level: 'error', message: (msg as { message: string }).message });
        return;
      }
      default: return;
    }
  }

  /** Keeps files that only exist locally, while adopting the Cast's newer entries. */
  private mergeLibraries(local: MediaFile[], remote: MediaFile[]): MediaFile[] {
    const byName = new Map<string, MediaFile>();
    for (const f of local) byName.set(`${f.origin}:${f.name}`, f);
    for (const f of remote) {
      const key = `${f.origin}:${f.name}`;
      // A file we already pulled from the Cast keeps its local badge.
      byName.set(key, byName.get(key)?.origin === 'stage' ? byName.get(key)! : f);
    }
    return [...byName.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private async onBinary(bytes: Uint8Array): Promise<void> {
    const frame = decodePreviewFrame(bytes);
    if (frame) {
      const now = Date.now();
      this.lastFrameAt = now;
      this.framesInWindow++;
      this.events.emit('preview', { frameId: frame.frameId, jpeg: frame.jpeg });
      return;
    }
    try { await this.inbound.push(bytes) }
    catch (err) { this.events.emit('notice', { level: 'error', message: `写入接收文件失败：${String(err)}` }) }
  }

  /** The Cast asked *us* for a file — used by "互相拉取". */
  private async serveFile(req: FileRequestMessage): Promise<void> {
    const file = this.libraryFiles.find((f) => f.id === req.id) ?? (await this.store.list()).find((f) => f.id === req.id);
    if (!file) {
      this.events.emit('notice', { level: 'error', message: `本机没有文件 ${req.name}` });
      return;
    }
    if (!this.outbound) {
      this.outbound = new FileSender(
        { send: (d) => this.bridge.send(d), flush: () => this.bridge.flush() },
        this.store,
        (p) => this.events.emit('transfer', p),
      );
    }
    try {
      await this.outbound.send(file);
      this.events.emit('notice', { level: 'info', message: `已发送 ${file.name} 给拍摄端` });
    } catch (err) {
      this.events.emit('notice', { level: 'error', message: `发送 ${file.name} 失败：${String(err)}` });
    }
  }

  dispose(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    void this.bridge.disconnect().catch(() => undefined);
  }
}
