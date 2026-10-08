import { mercator } from './core/geo';
import type { Stroke } from './core/types';

export interface ExportOptions {
  /** Länge der längeren Bildseite in Pixel. */
  width: number;
  /** 'transparent' oder CSS-Farbe. */
  background: string;
  /** Aktueller Kartenzoom: Strichstärken bleiben optisch wie auf dem Bildschirm. */
  zoom: number;
  /** Bildausschnitt [West, Süd, Ost, Nord] in Grad – in der App der sichtbare Kartenausschnitt. */
  view: [number, number, number, number];
}

export interface ExportLayout {
  w: number;
  h: number;
  strokes: { color: string; width: number; paths: Float64Array[] }[]; // Bildkoordinaten (px)
}

/**
 * Strichdaten in Bildkoordinaten umrechnen (Web-Mercator). Der Rahmen ist der übergebene Ausschnitt, nicht die
 * Ausdehnung aller Striche: liegen Striche an mehreren Orten, wählt der User mit der Karte, was ins Bild kommt.
 * Teile außerhalb werden abgeschnitten. null, wenn nichts im Ausschnitt liegt.
 */
export function layoutExport(strokes: Stroke[], o: ExportOptions): ExportLayout | null {
  const [west, south, east, north] = o.view;
  const [x0, y0] = mercator(west, north);
  const [x1, y1] = mercator(east, south);
  const spanX = x1 - x0, spanY = y1 - y0;
  if (!(spanX > 0 && spanY > 0)) return null;
  const k = o.width / Math.max(spanX, spanY);
  const w = Math.max(1, Math.round(spanX * k));
  const h = Math.max(1, Math.round(spanY * k));
  const widthFactor = k / (512 * Math.pow(2, o.zoom)); // Ausgabe-Pixel je Bildschirm-Pixel
  const out: ExportLayout['strokes'] = [];
  for (const s of strokes) {
    const width = Math.max(0.5, s.width * widthFactor);
    // Rand um die halbe Strichstärke erweitert, damit Linienenden am Bildrand nicht sichtbar gekappt werden
    const m = width / 2 + 1;
    const paths: Float64Array[] = [];
    for (const p of s.parts) {
      const px = new Float64Array(p.length);
      for (let i = 0; i < p.length; i += 2) {
        const [x, y] = mercator(p[i], p[i + 1]);
        px[i] = (x - x0) * k; px[i + 1] = (y - y0) * k;
      }
      paths.push(...clipPolyline(px, -m, -m, w + m, h + m));
    }
    if (paths.length) out.push({ color: s.color, width, paths });
  }
  return out.length ? { w, h, strokes: out } : null;
}

/** Strecke a→b auf das Rechteck beschneiden (Liang-Barsky). Liefert die Parameter t0 ≤ t1 oder null. */
function clipSegment(ax: number, ay: number, bx: number, by: number, minX: number, minY: number, maxX: number, maxY: number): [number, number] | null {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy], q = [ax - minX, maxX - ax, ay - minY, maxY - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}

/** Linienzug (flach x,y) auf das Rechteck beschneiden; ein Zug, der den Rand mehrfach kreuzt, zerfällt in Stücke. */
export function clipPolyline(p: Float64Array, minX: number, minY: number, maxX: number, maxY: number): Float64Array[] {
  const out: Float64Array[] = [];
  let cur: number[] | null = null;
  const flush = () => { if (cur && cur.length >= 4) out.push(Float64Array.from(cur)); cur = null; };
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], ay = p[i - 1], bx = p[i], by = p[i + 1];
    const c = clipSegment(ax, ay, bx, by, minX, minY, maxX, maxY);
    if (!c) { flush(); continue; }
    const [t0, t1] = c;
    if (!cur || t0 > 0) { flush(); cur = [ax + (bx - ax) * t0, ay + (by - ay) * t0]; }
    cur.push(ax + (bx - ax) * t1, ay + (by - ay) * t1);
    if (t1 < 1) flush();
  }
  flush();
  return out;
}

/** Ausdehnung aller Striche [West, Süd, Ost, Nord] oder null ohne Striche. */
export function strokesBounds(strokes: Stroke[]): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const st of strokes) {
    for (const p of st.parts) {
      for (let i = 0; i < p.length; i += 2) {
        const x = p[i], y = p[i + 1];
        if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
      }
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

const NOTHING = 'Im Ausschnitt ist nichts zu exportieren – „Zur Zeichnung springen“ nutzen.';

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
  if (!layout) throw new Error(NOTHING);
  const canvas = toCanvas(layout, o.background);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG-Export fehlgeschlagen'))), 'image/png'));
  download(blob, name);
}

export function exportSvg(strokes: Stroke[], o: ExportOptions, name = 'strassenzeichner.svg') {
  const layout = layoutExport(strokes, o);
  if (!layout) throw new Error(NOTHING);
  download(new Blob([toSvg(layout, o.background)], { type: 'image/svg+xml' }), name);
}
