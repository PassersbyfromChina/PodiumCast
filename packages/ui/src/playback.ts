/**
 * Playback overlay — 要求.txt (三): "可以回放视频和照片。回放时可以放大或改变倍速。"
 *
 * Works for both stills and video with one control bar. Zoom is a CSS transform on the media
 * element so it stays GPU-cheap on an Android WebView; the same drag/pinch/wheel gestures are
 * wired up for touch and pointer devices.
 */
import { PLAYBACK_RATES, PLAYBACK_SCALE_MAX, PLAYBACK_SCALE_MIN, type MediaFile } from '@podiumcast/core';
import { clamp, h, iconButton, icon, clear } from './dom';

export interface PlayerCallbacks {
  onClose(): void;
  /** Fired for every meaningful change so the Cast can mirror the state to its Stage. */
  onState?(state: { playing: boolean; positionMs: number; durationMs: number; rate: number; scale: number }): void;
  /** Loads the blob/URL for a file. Called when the album advances. */
  resolveUrl(file: MediaFile): string;
}

export class Player {
  readonly el: HTMLElement;
  private readonly stageWrap: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly scrub: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly rateBox: HTMLElement;
  private readonly zoomLabel: HTMLElement;

  private media: HTMLImageElement | HTMLVideoElement | null = null;
  private current: MediaFile | null = null;
  private playlist: MediaFile[] = [];
  private index = 0;

  private scale = PLAYBACK_SCALE_MIN;
  private offsetX = 0;
  private offsetY = 0;
  private dragging = false;
  private dragStart = { x: 0, y: 0, ox: 0, oy: 0 };
  private rates: number[] = [...PLAYBACK_RATES];

  constructor(private readonly cb: PlayerCallbacks) {
    this.stageWrap = h('div', { class: 'player-canvas-wrap' });
    this.scrub = h('input', {
      class: 'scrub', type: 'range', min: '0', max: '1000', value: '0', step: '1',
      'aria-label': '播放进度',
      on: { input: () => this.onScrub() },
    });
    this.timeLabel = h('span', { class: 'time mono', text: '0:00 / 0:00' });
    this.zoomLabel = h('span', { class: 'val mono', text: '1.0×' });
    this.rateBox = h('div', { class: 'rate-list' });
    this.playToggle = iconButton('play', '播放/暂停', { cls: 'icon', onclick: () => this.toggle() });

    const prev = iconButton('swap', '上一个', { cls: 'sm icon ghost', onclick: () => this.step(-1) });
    const next = iconButton('swap', '下一个', { cls: 'sm icon ghost', onclick: () => this.step(1) });
    (prev.firstElementChild as SVGElement | null)?.setAttribute('style', 'transform: scaleX(-1)');

    this.bar = h('div', { class: 'player-bar' },
      this.playToggle,
      this.timeLabel,
      this.scrub,
      h('div', { class: 'rate-list' }, h('span', { class: 'label', text: '倍速' }), this.rateBox),
      h('div', { class: 'zoom-rail' },
        iconButton('zoomOut', '缩小', { cls: 'icon ghost', onclick: () => this.setScale(this.scale / 1.5) }),
        this.zoomLabel,
        iconButton('zoomIn', '放大', { cls: 'icon ghost', onclick: () => this.setScale(this.scale * 1.5) }),
        iconButton('fullscreen', '复位缩放', { cls: 'icon ghost', onclick: () => this.resetView() }),
      ),
      h('div', { class: 'spacer' }),
      prev, next,
      iconButton('close', '关闭回放', { cls: 'icon ghost', onclick: () => this.close() }),
    );

    this.el = h('div', { class: 'player', hidden: true }, this.stageWrap, this.bar);
    this.bindGestures();
    this.bindKeys();
  }

  private readonly playToggle: HTMLButtonElement;

  // ------------------------------------------------------------------ lifecycle

  open(files: MediaFile[], startIndex: number, _urlFor: (f: MediaFile) => string): void {
    this.playlist = files;
    this.index = clamp(startIndex, 0, Math.max(0, files.length - 1));
    this.el.hidden = false;
    this.load(this.playlist[this.index]);
  }

  close(): void {
    this.stopMedia();
    this.el.hidden = true;
    this.current = null;
    this.resetView();
    this.cb.onClose();
  }

  get isOpen(): boolean { return !this.el.hidden }
  get file(): MediaFile | null { return this.current }

  /** Jumps to a file by id without reopening the overlay; used for remote control. */
  show(file: MediaFile): void {
    const idx = this.playlist.findIndex((f) => f.id === file.id);
    if (idx >= 0) this.index = idx;
    else { this.playlist = [...this.playlist, file]; this.index = this.playlist.length - 1 }
    this.load(this.playlist[this.index]);
  }

  // ------------------------------------------------------------------ media

  private load(file: MediaFile | undefined): void {
    this.stopMedia();
    if (!file) return;
    this.current = file;
    const url = this.cb.resolveUrl(file);
    if (file.kind === 'photo') {
      const img = h('img', { src: url, alt: file.name, draggable: false });
      this.media = img;
      this.stageWrap.appendChild(img);
      this.scrub.disabled = true;
      this.rateBox.hidden = true;
      this.timeLabel.textContent = file.name;
      this.updatePlayButton(false);
    } else {
      const video = h('video', { src: url, playsinline: true, preload: 'metadata', controls: false });
      video.addEventListener('timeupdate', () => this.syncProgress());
      video.addEventListener('loadedmetadata', () => { this.applyRate(); this.syncProgress() });
      video.addEventListener('play', () => this.updatePlayButton(true));
      video.addEventListener('pause', () => this.updatePlayButton(false));
      video.addEventListener('ended', () => this.updatePlayButton(false));
      this.media = video;
      this.stageWrap.appendChild(video);
      this.scrub.disabled = false;
      this.rateBox.hidden = false;
      if (!this.rateBox.childElementCount) this.buildRates();
    }
    this.resetView();
    this.emitState();
  }

  private buildRates(): void {
    clear(this.rateBox);
    for (const r of this.rates) {
      this.rateBox.appendChild(h('button', {
        class: 'btn sm ghost', type: 'button', text: `${r}×`,
        'aria-pressed': String(r === 1),
        on: { click: () => { this.setRate(r) } },
      }));
    }
  }

  private stopMedia(): void {
    if (this.media instanceof HTMLVideoElement) {
      try { this.media.pause() } catch { /* already paused */ }
      this.media.removeAttribute('src');
      this.media.load();
    }
    clear(this.stageWrap);
    this.media = null;
  }

  // ------------------------------------------------------------------ controls

  toggle(): void {
    const v = this.media;
    if (!(v instanceof HTMLVideoElement)) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
    this.emitState();
  }

  setRate(rate: number): void {
    this.rates = [...new Set([...this.rates, rate])].sort((a, b) => a - b);
    for (const btn of Array.from(this.rateBox.children)) {
      const label = btn.textContent ?? '';
      btn.setAttribute('aria-pressed', String(label === `${rate}×`));
    }
    this.applyRate(rate);
    this.emitState();
  }

  private applyRate(rate?: number): void {
    if (!(this.media instanceof HTMLVideoElement)) return;
    const target = rate ?? Number((this.rateBox.querySelector('[aria-pressed="true"]')?.textContent ?? '1×').replace('×', ''));
    if (isFinite(target) && target > 0) this.media.playbackRate = target;
  }

  seekMs(positionMs: number): void {
    if (!(this.media instanceof HTMLVideoElement) || !isFinite(this.media.duration)) return;
    this.media.currentTime = clamp(positionMs / 1000, 0, this.media.duration);
    this.syncProgress();
  }

  private onScrub(): void {
    if (!(this.media instanceof HTMLVideoElement) || !isFinite(this.media.duration)) return;
    const ratio = Number(this.scrub.value) / 1000;
    this.media.currentTime = ratio * this.media.duration;
    this.syncProgress();
  }

  private syncProgress(): void {
    const v = this.media;
    if (!(v instanceof HTMLVideoElement)) return;
    const dur = isFinite(v.duration) ? v.duration : 0;
    this.scrub.value = String(dur ? Math.round((v.currentTime / dur) * 1000) : 0);
    this.timeLabel.textContent = `${fmt(v.currentTime)} / ${fmt(dur)}`;
    this.emitState();
  }

  private step(delta: number): void {
    if (this.playlist.length < 2) return;
    this.index = (this.index + delta + this.playlist.length) % this.playlist.length;
    this.load(this.playlist[this.index]);
  }

  private updatePlayButton(playing: boolean): void {
    clear(this.playToggle);
    this.playToggle.appendChild(icon(playing ? 'pause' : 'play'));
    this.playToggle.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  // ------------------------------------------------------------------ zoom

  setScale(scale: number): void {
    this.scale = clamp(scale, PLAYBACK_SCALE_MIN, PLAYBACK_SCALE_MAX);
    if (this.scale === PLAYBACK_SCALE_MIN) { this.offsetX = 0; this.offsetY = 0 }
    this.applyTransform();
    this.emitState();
  }

  getScale(): number { return this.scale }

  resetView(): void {
    this.scale = PLAYBACK_SCALE_MIN;
    this.offsetX = 0;
    this.offsetY = 0;
    this.applyTransform();
  }

  private applyTransform(): void {
    if (!this.media) return;
    this.media.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
    this.zoomLabel.textContent = `${this.scale.toFixed(1)}×`;
  }

  private bindGestures(): void {
    const wrap = this.stageWrap;
    wrap.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.setScale(this.scale * (ev.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });

    wrap.addEventListener('pointerdown', (ev) => {
      if (this.scale <= 1) return;
      this.dragging = true;
      this.dragStart = { x: ev.clientX, y: ev.clientY, ox: this.offsetX, oy: this.offsetY };
      wrap.setPointerCapture(ev.pointerId);
    });
    wrap.addEventListener('pointermove', (ev) => {
      if (!this.dragging) return;
      this.offsetX = this.dragStart.ox + (ev.clientX - this.dragStart.x);
      this.offsetY = this.dragStart.oy + (ev.clientY - this.dragStart.y);
      this.applyTransform();
    });
    const end = (ev: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      try { wrap.releasePointerCapture(ev.pointerId) } catch { /* already released */ }
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);

    // Two-finger pinch on touch devices.
    let pinchStart = 0;
    let pinchScale = 1;
    wrap.addEventListener('touchstart', (ev) => {
      if (ev.touches.length !== 2) return;
      pinchStart = distance(ev.touches[0], ev.touches[1]);
      pinchScale = this.scale;
    }, { passive: true });
    wrap.addEventListener('touchmove', (ev) => {
      if (ev.touches.length !== 2 || !pinchStart) return;
      ev.preventDefault();
      const d = distance(ev.touches[0], ev.touches[1]);
      this.setScale(pinchScale * (d / pinchStart));
    }, { passive: false });
    wrap.addEventListener('touchend', () => { pinchStart = 0 });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (ev) => {
      if (!this.isOpen) return;
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      switch (ev.key) {
        case 'Escape': this.close(); break;
        case ' ': ev.preventDefault(); this.toggle(); break;
        case 'ArrowLeft': this.seekMs(Math.max(0, this.positionMs() - 5000)); break;
        case 'ArrowRight': this.seekMs(this.positionMs() + 5000); break;
        case '+': case '=': this.setScale(this.scale * 1.25); break;
        case '-': this.setScale(this.scale / 1.25); break;
        case '0': this.resetView(); break;
        default: break;
      }
    });
  }

  private positionMs(): number {
    return this.media instanceof HTMLVideoElement ? this.media.currentTime * 1000 : 0;
  }

  private durationMs(): number {
    return this.media instanceof HTMLVideoElement && isFinite(this.media.duration) ? this.media.duration * 1000 : 0;
  }

  private emitState(): void {
    const playing = this.media instanceof HTMLVideoElement ? !this.media.paused : false;
    const rate = this.media instanceof HTMLVideoElement ? this.media.playbackRate : 1;
    this.cb.onState?.({
      playing,
      positionMs: this.positionMs(),
      durationMs: this.durationMs(),
      rate,
      scale: this.scale,
    });
  }
}

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function fmt(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
