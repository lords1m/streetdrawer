import type { BuildOptions } from './core/graph';
import type { LineBatch, NetStats, Slot, WorkerIn, WorkerOut } from './core/types';

type Distribute<T> = T extends unknown ? Omit<T, 'rid'> : never;

/**
 * Promise-Fassade für den Netz-Worker. Stürzt der Worker ab (z. B. Speicher), werden alle offenen
 * Anfragen abgewiesen, ein neuer Worker gestartet und `onRestart` gerufen, damit Netze neu aufgebaut werden.
 */
export class NetClient {
  private w!: Worker;
  private rid = 0;
  private pending = new Map<number, { resolve: (m: WorkerOut) => void; reject: (e: Error) => void }>();
  onRestart: ((reason: string) => void) | null = null;

  constructor() { this.start(); }

  private start() {
    this.w = new Worker(new URL('./workers/net.worker.ts', import.meta.url), { type: 'module' });
    this.w.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const p = this.pending.get(ev.data.rid);
      if (!p) return;
      this.pending.delete(ev.data.rid);
      if (ev.data.op === 'error') p.reject(new Error(ev.data.message));
      else p.resolve(ev.data);
    };
    const crash = (reason: string) => {
      const err = new Error('Netz-Worker abgestürzt: ' + reason);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.w.terminate();
      this.start();
      this.onRestart?.(reason);
    };
    this.w.onerror = (e) => { e.preventDefault(); crash(e.message || 'unbekannter Fehler'); };
    this.w.onmessageerror = () => crash('Nachricht nicht lesbar');
  }

  private call(msg: Distribute<WorkerIn>, transfer: Transferable[] = []): Promise<WorkerOut> {
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.w.postMessage({ ...msg, rid }, transfer);
    });
  }

  async setNetwork(slot: Slot, lines: LineBatch, build: BuildOptions): Promise<NetStats> {
    const transfer: Transferable[] = [lines.coords.buffer, lines.offsets.buffer, lines.cls.buffer];
    if (lines.level) transfer.push(lines.level.buffer);
    const r = await this.call({ op: 'setNetwork', slot, lines, build }, transfer);
    if (r.op !== 'ready') throw new Error('unerwartete Antwort');
    return r.stats;
  }
  async clear(slot: Slot) { await this.call({ op: 'clear', slot }); }
  async overlay(slot: Slot) {
    const r = await this.call({ op: 'overlay', slot });
    if (r.op !== 'overlay') throw new Error('unerwartete Antwort');
    return { src: r.src, dst: r.dst, cls: r.cls };
  }
  async feed(slot: Slot, sid: number, points: Float64Array, radiusM: number, classMask: number, final: boolean) {
    const r = await this.call({ op: 'feed', slot, sid, points, radiusM, classMask, final }, [points.buffer]);
    if (r.op !== 'result') throw new Error('unerwartete Antwort');
    return { parts: r.parts, ms: r.ms };
  }
  drop(sid: number) { this.w.postMessage({ op: 'drop', rid: 0, sid } satisfies WorkerIn); }
}
