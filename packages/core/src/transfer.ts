/**
 * Chunked file transfer, shared by both peers.
 *
 * 要求.txt: "视频文件默认存在 PodiumCast-Cast 应用，可以选择存在 PodiumCast-Stage 应用，
 * 也可以互相拉取" — so transfer has to work in both directions over the same socket:
 *
 *   Stage → Cast : `file-request` → Cast streams `file-offer` + chunks + `file-done`
 *   Cast  → Stage: identical, the Stage streams back from its own store
 *
 * The protocol is deliberately one-transfer-at-a-time per peer. A single camera cannot
 * produce two files at once, and serialising keeps memory bounded — which matters because
 * the Android Stage receives into base64 appends rather than a real file handle.
 */
import {
  FILE_CHUNK_PAYLOAD_BYTES,
  decodeFileChunk,
  encodeFileChunk,
  type FileDoneMessage,
  type FileOfferMessage,
  type MediaFile,
} from './protocol';
import type { MediaStore } from './bridge';
import { sanitizeFileName, uniqueName } from './library';

export interface TransferEndpoint {
  send(data: string | Uint8Array): void;
  flush(): Promise<void>;
}

export interface SendProgress {
  transferId: number;
  name: string;
  sentBytes: number;
  totalBytes: number;
  done: boolean;
  error?: string;
}

export interface ReceiveProgress {
  transferId: number;
  name: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error?: string;
}

export interface TransferEvents {
  progress: SendProgress | ReceiveProgress;
  /** A file finished arriving and is now in the local store. */
  received: MediaFile;
  /** A file finished leaving; the caller can mark it as mirrored on the peer. */
  sent: { file: MediaFile; toPeerId: string };
  error: { transferId: number; message: string };
}

/** Streams stored files to one peer, one transfer at a time. */
export class FileSender {
  private transferId = 0;
  private busy = false;
  private lastTransferId = 0;

  constructor(
    private readonly endpoint: TransferEndpoint,
    private readonly store: MediaStore,
    private readonly onEvent: (e: SendProgress) => void,
    private readonly payloadBytes = FILE_CHUNK_PAYLOAD_BYTES,
  ) {}

  get isBusy(): boolean { return this.busy }

  /**
   * Sends `file` and resolves with the number of bytes written.
   *
   * Emits `file-offer` → n × binary chunk → `file-done`, so the receiver needs no side
   * channel to know the transfer finished — which matters because on Android the receiving
   * side is a WebView that only sees the WebSocket.
   */
  async send(file: MediaFile): Promise<number> {
    if (this.busy) throw new Error('已有文件正在传输');
    this.busy = true;
    const transferId = ++this.transferId;
    this.lastTransferId = transferId;
    const total = file.size;
    const name = sanitizeFileName(file.name);
    let offset = 0;
    try {
      const offer: FileOfferMessage = {
        t: 'file-offer',
        transferId,
        name,
        kind: file.kind,
        size: total,
        mime: file.mime,
        width: file.width,
        height: file.height,
        durationMs: file.durationMs,
        createdAt: file.createdAt,
      };
      this.endpoint.send(JSON.stringify(offer));
      await this.endpoint.flush();

      let index = 0;
      while (offset < total) {
        const length = Math.min(this.payloadBytes, total - offset);
        // eslint-disable-next-line no-await-in-loop -- sequential by protocol design
        const bytes = await this.store.readRange(file.id, offset, length);
        if (!bytes.byteLength) break;
        this.endpoint.send(encodeFileChunk(transferId, index++, bytes));
        offset += bytes.byteLength;
        this.onEvent({ transferId, name, sentBytes: offset, totalBytes: total, done: false });
        if (index % 8 === 0) {
          // eslint-disable-next-line no-await-in-loop -- backpressure between bursts
          await this.endpoint.flush();
        }
      }
      await this.endpoint.flush();
      this.endpoint.send(JSON.stringify({ t: 'file-done', transferId, ok: true } satisfies FileDoneMessage));
      this.onEvent({ transferId, name, sentBytes: offset, totalBytes: total, done: true });
      return offset;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.endpoint.send(JSON.stringify({ t: 'file-done', transferId, ok: false, error: message } satisfies FileDoneMessage));
      this.onEvent({ transferId, name, sentBytes: offset, totalBytes: total, done: true, error: message });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Handles the peer's `file-done`; only the most recent transfer can be settled. */
  settle(msg: FileDoneMessage): void {
    if (msg.transferId !== this.lastTransferId) return;
    if (!msg.ok) {
      this.onEvent({ transferId: msg.transferId, name: '', sentBytes: 0, totalBytes: 0, done: true, error: msg.error ?? '对端中断了传输' });
    }
  }
}

/** Receives an incoming transfer into the local store. */
export class FileReceiver {
  private active: {
    transferId: number;
    handle: string;
    file: MediaFile;
    received: number;
    nextIndex: number;
  } | null = null;

  constructor(
    private readonly store: MediaStore,
    private readonly onEvent: (e: ReceiveProgress) => void,
    private readonly onReceived: (file: MediaFile) => void,
    private readonly onError: (transferId: number, message: string) => void,
    /** Names already on disk, so a second `VIDEO_…` never clobbers the first. */
    private readonly takenNames: () => Promise<string[]>,
  ) {}

  get isBusy(): boolean { return this.active !== null }

  async begin(offer: FileOfferMessage): Promise<void> {
    if (this.active) await this.abort(this.active.transferId, '新的传输已开始');
    const safe = sanitizeFileName(offer.name);
    const name = uniqueName(safe, await this.takenNames());
    const file: MediaFile = {
      id: `recv-${offer.transferId}-${offer.createdAt}`,
      name,
      kind: offer.kind,
      mime: offer.mime || (offer.kind === 'photo' ? 'image/jpeg' : 'video/webm'),
      size: offer.size,
      width: offer.width,
      height: offer.height,
      durationMs: offer.durationMs,
      createdAt: offer.createdAt || Date.now(),
      origin: 'stage',
    };
    const handle = await this.store.beginWrite(name, offer.kind, {
      mime: file.mime, width: file.width, height: file.height, createdAt: file.createdAt,
    });
    this.active = { transferId: offer.transferId, handle, file, received: 0, nextIndex: 0 };
  }

  /** Feeds a raw binary frame; silently ignores frames for other transfers. */
  async push(bytes: Uint8Array): Promise<void> {
    const chunk = decodeFileChunk(bytes);
    if (!chunk || !this.active || chunk.transferId !== this.active.transferId) return;
    await this.store.appendWrite(this.active.handle, chunk.payload);
    this.active.received += chunk.payload.byteLength;
    this.active.nextIndex = chunk.chunkIndex + 1;
    this.onEvent({
      transferId: chunk.transferId,
      name: this.active.file.name,
      receivedBytes: this.active.received,
      totalBytes: this.active.file.size,
      done: false,
    });
  }

  async finish(msg: FileDoneMessage): Promise<MediaFile | null> {
    if (!this.active || this.active.transferId !== msg.transferId) return null;
    const active = this.active;
    this.active = null;
    if (!msg.ok) {
      await this.store.abortWrite(active.handle);
      this.onError(msg.transferId, msg.error ?? '对端中断了传输');
      return null;
    }
    const complete = await this.store.endWrite(active.handle, active.file.durationMs);
    const size = complete.size || active.received;
    this.onEvent({
      transferId: msg.transferId,
      name: complete.name,
      receivedBytes: size,
      totalBytes: active.file.size || size,
      done: true,
    });
    this.onReceived({ ...complete, size });
    return complete;
  }

  async abort(transferId: number, reason: string): Promise<void> {
    if (!this.active || this.active.transferId !== transferId) return;
    const active = this.active;
    this.active = null;
    await this.store.abortWrite(active.handle);
    this.onError(transferId, reason);
  }
}
