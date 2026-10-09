/**
 * Media library helpers: file naming, byte/duration formatting and the transfer bookkeeping
 * shared by both peers.
 */
import type { CameraKind, MediaFile } from './protocol';

export function pad(n: number, width = 2): string {
  return String(Math.floor(Math.abs(n))).padStart(width, '0');
}

/** `2026-10-09_20-31-07` — filesystem-safe, sorts chronologically, no locale surprises. */
export function timestampSlug(date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

export const MIME_BY_KIND: Record<CameraKind, { ext: string; mime: string }> = {
  photo: { ext: 'jpg', mime: 'image/jpeg' },
  video: { ext: 'webm', mime: 'video/webm' },
};

/**
 * Picks the first container the host actually supports.
 *
 * Android WebView only guarantees WebM/VP8; Electron (Chromium) additionally offers MP4.
 * We probe rather than assume so a Stage receiving the file can play it back.
 */
export function pickVideoMime(candidates: string[] = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
]): string {
  const rec = (globalThis as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder;
  if (!rec || typeof rec.isTypeSupported !== 'function') return 'video/webm';
  for (const c of candidates) { try { if (rec.isTypeSupported(c)) return c } catch { /* keep probing */ } }
  return 'video/webm';
}

export function extForMime(mime: string, kind: CameraKind): string {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  return MIME_BY_KIND[kind].ext;
}

export function mediaFileName(kind: CameraKind, mime: string, date = new Date(), seq = 0): string {
  const suffix = seq > 0 ? `_${seq}` : '';
  const stem = kind === 'photo' ? 'PHOTO' : 'VIDEO';
  return `PodiumCast_${stem}_${timestampSlug(date)}${suffix}.${extForMime(mime, kind)}`;
}

export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** `mm:ss` under an hour, `h:mm:ss` above it — used by both the recorder and the player. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** `true` when every field needed for a remote library card is present. */
export function isTransferable(file: MediaFile): boolean {
  return Boolean(file && file.id && file.name && file.size >= 0 && (file.kind === 'photo' || file.kind === 'video'));
}

/** Ensures a filename is safe to write on Windows, macOS and Android at once. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return `PodiumCast_${timestampSlug()}`;
  return cleaned.length > 180 ? `${cleaned.slice(0, 170)}.${cleaned.split('.').pop() ?? 'bin'}` : cleaned;
}

/**
 * De-duplicates a name against names already in use by appending `_1`, `_2`, …
 * Mirrors what every capture app does so a second take never overwrites the first.
 */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}${ext}`;
}
