/**
 * Reusable panels and the toast strip.
 *
 * `Panel` is a shell (title bar + scrollable body + optional footer). Both apps fill the body
 * with their own settings, which is how the Cast and the Stage stay visually consistent while
 * exposing different controls.
 */
import { formatBytes, formatDuration, type MediaFile } from '@podiumcast/core';
import { clear, h, icon, iconButton } from './dom';

export class Panel {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly foot: HTMLElement;
  private readonly titleEl: HTMLElement;

  constructor(opts: { title: string; position?: 'center' | 'bottom-right' | 'bottom-left'; width?: 'wide' | 'narrow'; onClose?: () => void }) {
    this.titleEl = h('h2', { text: opts.title });
    this.body = h('div', { class: 'panel-body' });
    this.foot = h('div', { class: 'panel-foot', hidden: true });
    this.el = h('div', {
      class: `panel ${opts.width ?? 'narrow'} ${opts.position ?? 'center'}`,
      hidden: true,
      role: 'dialog',
      'aria-label': opts.title,
    },
      h('div', { class: 'panel-head' },
        this.titleEl,
        h('div', { class: 'spacer' }),
        iconButton('close', '关闭', { cls: 'icon ghost', onclick: () => { this.close(); opts.onClose?.() } }),
      ),
      this.body,
      this.foot,
    );
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.isOpen) { this.close(); opts.onClose?.() }
    });
  }

  setTitle(text: string): void { this.titleEl.textContent = text }
  get isOpen(): boolean { return !this.el.hidden }
  open(): void { this.el.hidden = false }
  close(): void { this.el.hidden = true }
  toggle(): void { this.el.hidden = !this.el.hidden }
  setFooter(...children: Array<Node | null>): void {
    clear(this.foot);
    const items = children.filter(Boolean) as Node[];
    if (!items.length) { this.foot.hidden = true; return }
    this.foot.hidden = false;
    for (const c of items) this.foot.appendChild(c);
  }
}

export interface LibraryCallbacks {
  onPlay(files: MediaFile[], index: number): void;
  /** Pull a file that currently only exists on the peer. */
  onPull?(file: MediaFile): void;
  onDelete?(file: MediaFile): void;
  onOpen?(files: MediaFile[]): void;
  urlFor(file: MediaFile): string;
  /** `cast` when this panel belongs to the Cast app, `stage` for the Stage app. */
  localRole: 'cast' | 'stage';
}

export class LibraryPanel {
  readonly panel: Panel;
  private readonly grid: HTMLElement;
  private readonly countLabel: HTMLElement;
  private files: MediaFile[] = [];

  constructor(private readonly cb: LibraryCallbacks) {
    this.grid = h('div', { class: 'lib-grid' });
    this.countLabel = h('span', { class: 'chip', text: '0 个文件' });
    this.panel = new Panel({ title: '拍摄库', width: 'wide', position: 'center' });
    this.panel.body.appendChild(this.grid);
    this.panel.body.appendChild(this.emptyState());
    this.panel.setFooter(
      this.countLabel,
      h('div', { class: 'spacer' }),
      iconButton('folder', '打开存储目录', { cls: 'sm', onclick: () => this.cb.onOpen?.(this.files) }),
    );
  }

  private emptyState(): HTMLElement {
    return h('div', { class: 'empty', text: '还没有照片或视频。拍摄后会出现在这里。' });
  }

  setFiles(files: MediaFile[]): void {
    this.files = [...files].sort((a, b) => b.createdAt - a.createdAt);
    this.countLabel.textContent = `${this.files.length} 个文件`;
    this.render();
  }

  get list(): MediaFile[] { return this.files }

  private render(): void {
    clear(this.grid);
    const empty = this.panel.body.querySelector('.empty') as HTMLElement | null;
    if (!this.files.length) { if (empty) empty.hidden = false; return }
    if (empty) empty.hidden = true;

    this.files.forEach((file, index) => {
      const url = this.cb.urlFor(file);
      const thumb = h('div', { class: 'lib-thumb' });
      if (file.kind === 'photo') {
        thumb.appendChild(h('img', { src: url, alt: file.name, loading: 'lazy', draggable: false }));
      } else {
        const video = h('video', { src: url, preload: 'metadata', muted: true, playsinline: true });
        // A poster frame is nice-to-have; never let it block the grid.
        video.addEventListener('loadeddata', () => { try { video.currentTime = 0.1 } catch { /* not seekable */ } }, { once: true });
        thumb.appendChild(video);
      }
      thumb.appendChild(h('span', { class: 'kind', text: file.kind === 'photo' ? '照片' : '视频' }));
      if (file.origin !== this.cb.localRole) thumb.appendChild(h('span', { class: 'origin', text: '远端' }));

      const sub = `${formatBytes(file.size)} · ${file.width}×${file.height}${file.kind === 'video' ? ` · ${formatDuration(file.durationMs)}` : ''}`;
      const card = h('button', {
        class: 'lib-card', type: 'button',
        on: { click: () => this.cb.onPlay(this.files, index) },
      },
        thumb,
        h('div', { class: 'lib-meta' },
          h('span', { class: 'name', text: file.name }),
          h('span', { class: 'sub', text: sub }),
        ),
      );

      const actions = h('div', { class: 'lib-actions' });
      if (this.cb.onPull && file.origin !== this.cb.localRole) {
        actions.appendChild(iconButton('download', '拉取到本机', {
          cls: 'sm ghost', showLabel: false, title: '拉取到本机',
          onclick: () => this.cb.onPull?.(file),
        }));
      }
      if (this.cb.onDelete && file.origin === this.cb.localRole) {
        actions.appendChild(iconButton('trash', '删除', {
          cls: 'sm ghost danger', showLabel: false, title: '删除',
          onclick: () => this.cb.onDelete?.(file),
        }));
      }
      if (actions.childElementCount) card.appendChild(actions);

      this.grid.appendChild(card);
    });
  }
}

/** Bottom-centre toast strip. Oldest entries fade out on their own. */
export class Toaster {
  readonly el: HTMLElement;
  private readonly limit = 4;

  constructor() {
    this.el = h('div', { class: 'status-strip', role: 'status', 'aria-live': 'polite' });
  }

  show(message: string, level: 'info' | 'warn' | 'error' = 'info', ttlMs = 3200): void {
    const node = h('div', { class: `toast ${level}`, title: message, text: message });
    this.el.appendChild(node);
    while (this.el.childElementCount > this.limit) this.el.removeChild(this.el.firstElementChild!);
    setTimeout(() => {
      node.classList.add('fade');
      setTimeout(() => node.remove(), 200);
    }, ttlMs);
  }

  /** Persistent badge (e.g. "已连接") that stays until cleared. */
  badge(text: string, tone: 'ok' | 'warn' | 'err' = 'ok'): HTMLElement {
    const node = h('div', { class: `chip ${tone}` }, h('span', { class: 'dot' }), h('span', { text }));
    this.el.appendChild(node);
    return node;
  }
}

export function connectionChip(): { el: HTMLElement; set(text: string, tone: 'ok' | 'warn' | 'err' | ''): void } {
  const label = h('span', { text: '未连接' });
  const el = h('span', { class: 'chip' }, h('span', { class: 'dot' }), label);
  return {
    el,
    set(text, tone) {
      label.textContent = text;
      el.className = `chip ${tone}`.trim();
    },
  };
}

export { icon };
