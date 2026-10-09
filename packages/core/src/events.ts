/**
 * A dependency-free typed event emitter.
 *
 * The core package is bundled for three very different runtimes (Electron's main process,
 * Electron's renderer and an Android WebView), so it cannot use `node:events` — and pulling
 * a pub/sub library in for ~40 lines would be gratuitous.
 */
export type Listener<T> = (value: T) => void;

/**
 * `Events` is deliberately constrained to `object` rather than `Record<string, unknown>`:
 * every event map in this project is a named interface, and interfaces do not get implicit
 * index signatures.
 */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    set.add(fn as Listener<never>);
    return () => this.off(event, fn);
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (v) => { off(); fn(v) });
    return off;
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy first: handlers are allowed to unsubscribe while being notified.
    for (const fn of [...set]) {
      try { (fn as Listener<Events[K]>)(value) }
      catch (err) { console.error('[podiumcast] listener threw', event, err) }
    }
  }

  removeAll(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }
}
