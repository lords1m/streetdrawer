import type { LineBatch } from './core/types';

export interface PdfCtx {
  map: import('maplibre-gl').Map;
  setStatus: (s: string) => void;
  adoptBatch: (b: LineBatch, label: string, build?: { snap: number; planarize: boolean; tee: number; gap: number }) => Promise<void>;
  progress: HTMLProgressElement;
  msg: HTMLElement;
}

/** PDF-Import (Schritt 3). */
export async function openPdfImport(ctx: PdfCtx, _file: File) {
  ctx.msg.textContent = 'PDF-Import folgt.';
}
