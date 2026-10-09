/**
 * Minimal DOM helpers. No framework: the two apps are small enough that a 40-line `h()`
 * beats shipping a runtime, and it keeps the Android WebView bundle tiny.
 */

export type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  id?: string;
  style?: string;
  title?: string;
  hidden?: boolean;
  text?: string;
  html?: string;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: never) => void>>;
  [key: string]: unknown;
}

/** Creates an element: `h('div', { class: 'x', on: { click } }, 'hi', child)`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'html') el.innerHTML = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value as Record<string, string>);
    else if (key === 'on') {
      for (const [evt, fn] of Object.entries(value as Record<string, EventListener>)) {
        el.addEventListener(evt, fn as EventListener);
      }
    } else if (key === 'hidden') el.hidden = Boolean(value);
    else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`元素未找到：${selector}`);
  return el;
}

export function svg(paths: string, viewBox = '0 0 24 24', cls = 'ico'): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = paths;
  return el;
}

/** Inline icon set —文字之外的图标全部内联，避免任何字体或网络依赖。 */
export const ICONS = {
  camera: '<circle cx="12" cy="13" r="4"/><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/>',
  record: '<circle cx="12" cy="12" r="8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  photo: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<rect x="7" y="5.5" width="3.6" height="13" rx="1"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M11 8.5v5M8.5 11h5M16 16l4.5 4.5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M8.5 11h5M16 16l4.5 4.5"/>',
  library: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17M8 5v14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.5l1.9 1.1M17.2 15.4l1.9 1.1M4.9 16.5l1.9-1.1M17.2 8.6l1.9-1.1"/>',
  link: '<path d="M9.5 14.5l5-5"/><path d="M11 7.5l1.2-1.2a3.8 3.8 0 015.4 5.4L16.4 13"/><path d="M13 16.5l-1.2 1.2a3.8 3.8 0 01-5.4-5.4L7.6 11"/>',
  cast: '<path d="M4 6.5h16v11H4z"/><path d="M8 20h8"/>',
  stage: '<rect x="3" y="5" width="18" height="12" rx="1.6"/><path d="M8 20h8M12 17v3"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  swap: '<path d="M7 8h10l-2.5-2.5M17 16H7l2.5 2.5"/>',
  usb: '<path d="M12 3v10"/><circle cx="12" cy="15.5" r="3"/><path d="M9 6.5L12 3l3 3.5"/>',
  folder: '<path d="M3.5 7.5h6l1.6 2h8.4v8.5h-16z"/>',
  trash: '<path d="M5.5 7.5h13M9.5 7.5V5.5h5v2M7 7.5l.8 12h8.4l.8-12"/>',
  download: '<path d="M12 4v10M8 10.5l4 4 4-4M5 19.5h14"/>',
  upload: '<path d="M12 15V5M8 8.5l4-4 4 4M5 19.5h14"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  wifi: '<path d="M2.5 9.5a14 14 0 0119 0M5.5 13a10 10 0 0113 0M8.5 16.4a5.6 5.6 0 017 0"/><circle cx="12" cy="19.5" r="1"/>',
} as const;

export function icon(name: keyof typeof ICONS, cls = 'ico'): SVGSVGElement {
  return svg(ICONS[name], '0 0 24 24', cls);
}

/** Button with an icon plus an optional visible label. */
export function iconButton(
  name: keyof typeof ICONS,
  label: string,
  opts: { onclick?: () => void; cls?: string; title?: string; pressed?: boolean; showLabel?: boolean } = {},
): HTMLButtonElement {
  const btn = h('button', {
    class: `btn ${opts.cls ?? ''}`.trim(),
    type: 'button',
    title: opts.title ?? label,
    'aria-label': label,
    on: opts.onclick ? { click: opts.onclick as unknown as EventListener } : undefined,
  }, icon(name), opts.showLabel === false ? null : h('span', { text: label }));
  if (opts.pressed !== undefined) btn.setAttribute('aria-pressed', String(opts.pressed));
  return btn;
}

/** Debounce that also fires on the trailing edge — used for resize/zoom handlers. */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args) }, ms);
  };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Formats seconds as `m:ss`; used by every player in the app. */
export function mmss(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
