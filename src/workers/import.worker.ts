/// <reference lib="webworker" />
import { importFile, type ImportOptions } from '../import';
import type { LineBatch } from '../core/types';

export type ImportIn = { op: 'import'; file: File; options: ImportOptions };
export type ImportOut =
  | { op: 'progress'; fraction: number; text?: string }
  | { op: 'done'; batch: LineBatch; skipped: number; lines: number }
  | { op: 'error'; message: string };

const post = (m: ImportOut, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

self.onmessage = async (ev: MessageEvent<ImportIn>) => {
  if (ev.data.op !== 'import') return;
  let last = 0;
  try {
    const r = await importFile(ev.data.file, ev.data.options, (fraction, text) => {
      const now = performance.now();
      if (now - last < 80 && fraction < 1) return; // Fortschritt drosseln
      last = now;
      post({ op: 'progress', fraction, text });
    });
    post({ op: 'done', batch: r.batch, skipped: r.skipped, lines: r.lines }, [r.batch.coords.buffer, r.batch.offsets.buffer, r.batch.cls.buffer]);
  } catch (e) {
    post({ op: 'error', message: (e as Error).message ?? String(e) });
  }
};
