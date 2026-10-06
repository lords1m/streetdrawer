import { mercator } from './core/geo';
import type { Stroke } from './core/types';

export interface ExportOptions {
  /** Länge der längeren Bildseite in Pixel. */
  width: number;
  /** Rand als Anteil der längeren Seite. */
  padding: number;
  /** 'transparent' oder CSS-Farbe. */
  background: string;
  /** Aktueller Kartenzoom: Strichstärken bleiben optisch wie auf dem Bildschirm. */
  zoom: number;
}

export interface ExportLayout {
  w: number;
  h: number;
  strokes: { color: string; width: number; paths: Float64Array[] }[]; // Bildkoordinaten (px)
}

/** Strichdaten in Bildkoordinaten umrechnen (Web-Mercator, Seitenverhältnis bleibt). */
export function layoutExport(strokes: Stroke[], o: ExportOptions): ExportLayout | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const proj = strokes.map((s) => s.parts.map((p) => {
    const out = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 2) {
      const [x, y] = mercator(p[i], p[i + 1]);
      out[i] = x; out[i + 1] = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return out;
  }));
  if (!Number.isFinite(minX)) return null;
  const world = 512 * Math.pow(2, o.zoom);
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const pad = span * o.padding;
  const k = o.width / (span + 2 * pad);
  const widthFactor = k / world; // Ausgabe-Pixel je Bildschirm-Pixel
  const w = Math.max(1, Math.round((maxX - minX + 2 * pad) * k));
  const h = Math.max(1, Math.round((maxY - minY + 2 * pad) * k));
  return {
    w, h,
    strokes: strokes.map((s, si) => ({
      color: s.color,
      width: Math.max(0.5, s.width * widthFactor),
      paths: proj[si].map((p) => {
        const o2 = new Float64Array(p.length);
        for (let i = 0; i < p.length; i += 2) { o2[i] = (p[i] - minX + pad) * k; o2[i + 1] = (p[i + 1] - minY + pad) * k; }
        return o2;
      }),
    })),
  };
}

const num = (v: number) => (Math.round(v * 100) / 100).toString();

export function toSvg(layout: ExportLayout, background: string): string {
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.w} ${layout.h}" width="${layout.w}" height="${layout.h}">`);
  if (background !== 'transparent') out.push(`<rect width="100%" height="100%" fill="${esc(background)}"/>`);
  for (const s of layout.strokes) {
    let d = '';
    for (const p of s.paths) {
      if (p.length < 4) continue;
      d += `M${num(p[0])} ${num(p[1])}`;
      for (let i = 2; i < p.length; i += 2) d += `L${num(p[i])} ${num(p[i + 1])}`;
    }
    if (!d) continue;
    out.push(`<path d="${d}" fill="none" stroke="${esc(s.color)}" stroke-width="${num(s.width)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

export function toCanvas(layout: ExportLayout, background: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = layout.w; c.height = layout.h;
  const ctx = c.getContext('2d')!;
  if (background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of layout.strokes) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
    ctx.beginPath();
    for (const p of s.paths) {
      if (p.length < 4) continue;
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    }
    ctx.stroke();
  }
  return c;
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export async function exportPng(strokes: Stroke[], o: ExportOptions, name = 'strassenzeichner.png') {
  const layout = layoutExport(strokes, o);
  if (!layout) throw new Error('Nichts zu exportieren');
  const canvas = toCanvas(layout, o.background);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG-Export fehlgeschlagen'))), 'image/png'));
  download(blob, name);
}

export function exportSvg(strokes: Stroke[], o: ExportOptions, name = 'strassenzeichner.svg') {
  const layout = layoutExport(strokes, o);
  if (!layout) throw new Error('Nichts zu exportieren');
  download(new Blob([toSvg(layout, o.background)], { type: 'image/svg+xml' }), name);
}
