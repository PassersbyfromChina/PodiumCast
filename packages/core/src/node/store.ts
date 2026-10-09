/**
 * Node.js media store — where recorded files actually live on Windows and macOS.
 *
 * Layout (shown verbatim in the apps' Settings panel):
 *
 *   <base>/photos/PodiumCast_PHOTO_2026-10-09_20-31-07.jpg
 *   <base>/videos/PodiumCast_VIDEO_2026-10-09_20-31-07.webm
 *   <base>/.podiumcast-index.json      ← metadata sidecar (dimensions, duration, …)
 *
 * Writes are append-only streams rather than whole-file buffers: the recording pipeline
 * hands over one MediaRecorder chunk every couple of seconds, and a file transfer hands over
 * 255 KiB at a time. Nothing ever needs the complete file in memory, so a long recording or a
 * multi-gigabyte pull stays flat in RAM.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { open, stat, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Emitter } from '../events';
import type { MediaStore, MediaStoreEvents } from '../bridge';
import type { CameraKind, MediaFile } from '../protocol';
import { sanitizeFileName, uniqueName } from '../library';

interface IndexEntry {
  id: string;
  name: string;
  kind: CameraKind;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  createdAt: number;
  dir: 'photos' | 'videos';
}

interface PendingWrite {
  handle: FileHandle;
  stream: WriteStream;
  entry: IndexEntry;
  bytes: number;
  /** Resolves when the stream has flushed everything queued so far. */
  drained: Promise<void>;
}

export class NodeMediaStore implements MediaStore {
  readonly events = new Emitter<MediaStoreEvents>();

  private readonly baseDir: string;
  private readonly urlPrefix: string;
  private index: IndexEntry[] = [];
  private readonly pending = new Map<string, PendingWrite>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string, urlPrefix = 'podiumcast://media') {
    this.baseDir = baseDir;
    this.urlPrefix = urlPrefix;
  }

  async init(): Promise<void> {
    await mkdir(this.photoDir, { recursive: true });
    await mkdir(this.videoDir, { recursive: true });
    try {
      const raw = await readFile(this.indexFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) this.index = parsed.filter(isIndexEntry);
    } catch { this.index = [] }
    // Drop entries whose file was deleted outside the app.
    const alive: IndexEntry[] = [];
    for (const e of this.index) {
      try { await stat(this.pathFor(e)); alive.push(e) } catch { /* gone */ }
    }
    this.index = alive;
    this.loaded = true;
    this.emitChanged();
  }

  private get photoDir(): string { return path.join(this.baseDir, 'photos') }
  private get videoDir(): string { return path.join(this.baseDir, 'videos') }
  private get indexFile(): string { return path.join(this.baseDir, '.podiumcast-index.json') }

  private pathFor(entry: IndexEntry): string {
    return path.join(entry.dir === 'photos' ? this.photoDir : this.videoDir, entry.name);
  }

  private dirFor(kind: CameraKind): 'photos' | 'videos' { return kind === 'photo' ? 'photos' : 'videos' }

  async location(): Promise<string> { return this.baseDir }

  async list(): Promise<MediaFile[]> {
    if (!this.loaded) await this.init();
    const out: MediaFile[] = [];
    for (const e of this.index) {
      try {
        const st = await stat(this.pathFor(e));
        out.push(this.toMediaFile(e, st.size));
      } catch { /* deleted underneath us */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  private toMediaFile(e: IndexEntry, size: number): MediaFile {
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      mime: e.mime,
      size,
      width: e.width,
      height: e.height,
      durationMs: e.durationMs,
      createdAt: e.createdAt,
      origin: 'cast',
      localPath: this.pathFor(e),
      url: this.urlFor({ id: e.id } as MediaFile),
    };
  }

  urlFor(file: MediaFile): string { return `${this.urlPrefix}/${encodeURIComponent(file.id)}` }

  async beginWrite(
    name: string,
    kind: CameraKind,
    meta: { mime: string; width: number; height: number; createdAt: number },
  ): Promise<string> {
    if (!this.loaded) await this.init();
    const dir = this.dirFor(kind);
    const safe = uniqueName(sanitizeFileName(name), this.index.filter((e) => e.dir === dir).map((e) => e.name));
    const entry: IndexEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: safe,
      kind,
      mime: meta.mime,
      width: meta.width,
      height: meta.height,
      durationMs: 0,
      createdAt: meta.createdAt || Date.now(),
      dir,
    };
    const full = this.pathFor(entry);
    const handle = await open(full, 'w');
    const stream = createWriteStream(full, { flags: 'a' });
    this.pending.set(entry.id, { handle, stream, entry, bytes: 0, drained: Promise.resolve() });
    return entry.id;
  }

  appendWrite(handleId: string, bytes: Uint8Array): Promise<void> {
    const pending = this.pending.get(handleId);
    if (!pending) return Promise.reject(new Error(`未知写入句柄 ${handleId}`));
    // Chain onto the previous write so ordering is guaranteed without a lock.
    pending.drained = pending.drained.then(() => new Promise<void>((resolve, reject) => {
      const ok = pending.stream.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), (err) => {
        if (err) reject(err); else resolve();
      });
      if (!ok) pending.stream.once('drain', () => undefined);
    }));
    pending.bytes += bytes.byteLength;
    return pending.drained;
  }

  async endWrite(handleId: string, durationMs: number): Promise<MediaFile> {
    const pending = this.pending.get(handleId);
    if (!pending) throw new Error(`未知写入句柄 ${handleId}`);
    this.pending.delete(handleId);
    await pending.drained.catch(() => undefined);
    await new Promise<void>((resolve) => pending.stream.end(() => resolve()));
    await pending.handle.close().catch(() => undefined);
    pending.entry.durationMs = durationMs;
    this.index = [pending.entry, ...this.index.filter((e) => e.id !== pending.entry.id)];
    await this.persistIndex();
    const st = await stat(this.pathFor(pending.entry)).catch(() => null);
    this.emitChanged();
    return this.toMediaFile(pending.entry, st?.size ?? pending.bytes);
  }

  async abortWrite(handleId: string): Promise<void> {
    const pending = this.pending.get(handleId);
    if (!pending) return;
    this.pending.delete(handleId);
    await new Promise<void>((resolve) => pending.stream.end(() => resolve())).catch(() => undefined);
    await pending.handle.close().catch(() => undefined);
    await rm(this.pathFor(pending.entry), { force: true }).catch(() => undefined);
  }

  async readAll(id: string): Promise<Uint8Array> {
    const entry = this.entryFor(id);
    if (!entry) throw new Error(`未知文件 ${id}`);
    return new Uint8Array(await readFile(this.pathFor(entry)));
  }

  async readRange(id: string, offset: number, length: number): Promise<Uint8Array> {
    const entry = this.entryFor(id);
    if (!entry) throw new Error(`未知文件 ${id}`);
    const full = this.pathFor(entry);
    const st = await stat(full);
    const start = Math.max(0, Math.min(offset, st.size));
    const end = Math.max(start, Math.min(offset + length, st.size));
    if (end === start) return new Uint8Array(0);
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(full, { start, end: end - 1 })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('error', reject)
        .on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
  }

  async remove(id: string): Promise<void> {
    const entry = this.entryFor(id);
    if (!entry) return;
    await rm(this.pathFor(entry), { force: true });
    this.index = this.index.filter((e) => e.id !== id);
    await this.persistIndex();
    this.emitChanged();
  }

  /** Absolute path for `<id>`; used by the `podiumcast://` protocol handler in the main process. */
  resolvePath(id: string): string | null {
    const entry = this.entryFor(id);
    return entry ? this.pathFor(entry) : null;
  }

  mimeFor(id: string): string { return this.entryFor(id)?.mime ?? 'application/octet-stream' }

  private entryFor(id: string): IndexEntry | undefined {
    return this.index.find((e) => e.id === id || e.name === id);
  }

  private async persistIndex(): Promise<void> {
    // Serialise index writes: several recordings can finish within the same tick.
    this.queue = this.queue.then(() => writeFile(this.indexFile, JSON.stringify(this.index, null, 2), 'utf8')).catch(() => undefined);
    await this.queue;
  }

  private emitChanged(): void {
    void this.list().then((files) => this.events.emit('changed', files)).catch(() => undefined);
  }
}

function isIndexEntry(v: unknown): v is IndexEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<IndexEntry>;
  return typeof e.id === 'string' && typeof e.name === 'string' && typeof e.mime === 'string'
    && (e.kind === 'photo' || e.kind === 'video') && (e.dir === 'photos' || e.dir === 'videos');
}
