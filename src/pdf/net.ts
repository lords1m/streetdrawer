import type { BuildOptions } from '../core/graph';
import { CLASS_MAIN, CLASS_PATH, CLASS_STREET } from '../core/graph';
import type { LineBatch } from '../core/types';
import { decodeKey } from './interpreter';
import type { Extracted } from './analyze';

/** 1 pt = 1/72 inch = 0,352778 mm. */
export const PT_MM = 25.4 / 72;

/** Maßstabs-Nenner aus Dateiname raten: "stadt_1_5000.pdf", "1:25000", "M10000", "1-2500". */
export function guessScale(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, '');
  const pats = [
    /(?:^|[^0-9])1\s*[:_\-/]\s*(\d{3,6})(?!\d)/,
    /(?:^|[^a-z])(?:m|ma[sß]stab|scale|massstab)\s*[:_\-=]?\s*(?:1\s*[:_\-/]\s*)?(\d{3,6})(?!\d)/i,
  ];
  for (const p of pats) {
    const m = base.match(p);
    if (m) { const v = Number(m[1]); if (v >= 100 && v <= 5_000_000) return v; }
  }
  return null;
}

export interface PdfNetOptions {
  /** Maßstab 1:N */
  scale: number;
  /** Lücken bis zu dieser Größe (pt) überbrücken */
  gapPt: number;
  /** Klassen aus Strichstärke ableiten (dicker = wichtiger); sonst alles "Straße". */
  classFromWidth: boolean;
  /** Georeferenz: Mitte der eingelesenen Daten liegt hier. */
  center: [number, number];
}

export interface PdfNet { batch: LineBatch; build: BuildOptions; metersPerPoint: number }

export function pdfToNet(ex: Extracted, o: PdfNetOptions): PdfNet {
  const mpp = (o.scale * PT_MM) / 1000; // Meter je Punkt
  const n = ex.offsets.length - 1;
  // Mittelpunkt der Daten
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ex.coords.length; i += 2) {
    const x = ex.coords[i], y = ex.coords[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const coords = new Float64Array(ex.coords.length);
  for (let i = 0; i < coords.length; i += 2) { coords[i] = (ex.coords[i] - cx) * mpp; coords[i + 1] = (ex.coords[i + 1] - cy) * mpp; }

  const cls = new Uint8Array(n).fill(CLASS_STREET);
  if (o.classFromWidth && n) {
    const widths = Array.from(new Set(Array.from(ex.keys, (k) => decodeKey(k).width))).sort((a, b) => a - b);
    if (widths.length > 1) {
      const lo = widths[Math.floor((widths.length - 1) / 3)], hi = widths[Math.floor(((widths.length - 1) * 2) / 3)];
      for (let i = 0; i < n; i++) {
        const w = decodeKey(ex.keys[i]).width;
        cls[i] = w > hi ? CLASS_MAIN : w > lo ? CLASS_STREET : CLASS_PATH;
      }
    }
  }
  return {
    batch: { coords, offsets: ex.offsets, cls, kind: 'meters', origin: o.center },
    build: { snap: Math.max(0.05, 0.2 * mpp), planarize: true, tee: 0.7 * mpp, gap: o.gapPt * mpp },
    metersPerPoint: mpp,
  };
}
