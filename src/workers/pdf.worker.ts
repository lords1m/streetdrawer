/// <reference lib="webworker" />
import { extractPdf, scanPdf, type Extracted, type PdfScan } from '../pdf/analyze';

export type PdfIn =
  | { op: 'scan'; file: File; page: number }
  | { op: 'extract'; file: File; page: number; keys: number[]; region: [number, number, number, number] | null };
export type PdfOut =
  | { op: 'progress'; fraction: number; text?: string }
  | { op: 'scanned'; scan: PdfScan }
  | { op: 'extracted'; ex: Extracted }
  | { op: 'error'; message: string };

const post = (m: PdfOut, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

self.onmessage = async (ev: MessageEvent<PdfIn>) => {
  const m = ev.data;
  let last = 0;
  const progress = (fraction: number, text?: string) => {
    const now = performance.now();
    if (now - last < 80 && fraction < 1) return;
    last = now;
    post({ op: 'progress', fraction, text });
  };
  try {
    if (m.op === 'scan') {
      const scan = await scanPdf(m.file, m.page, progress);
      post({ op: 'scanned', scan }, [scan.density.cells.buffer]);
    } else if (m.op === 'extract') {
      const ex = await extractPdf(m.file, m.page, m.keys, m.region, progress);
      post({ op: 'extracted', ex }, [ex.coords.buffer, ex.offsets.buffer, ex.keys.buffer]);
    }
  } catch (e) {
    post({ op: 'error', message: (e as Error).message ?? String(e) });
  }
};
