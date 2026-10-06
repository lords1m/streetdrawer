/** Lokale Projektion (Meter) um einen Ursprung. Für Stadt-Ausschnitte ausreichend genau. */
const R = 6371008.8;
const DEG = Math.PI / 180;

export class LocalProjection {
  readonly ky = R * DEG;
  readonly kx: number;
  constructor(public readonly lng0: number, public readonly lat0: number) {
    this.kx = this.ky * Math.cos(lat0 * DEG);
  }
  x(lng: number) { return (lng - this.lng0) * this.kx; }
  y(lat: number) { return (lat - this.lat0) * this.ky; }
  lng(x: number) { return this.lng0 + x / this.kx; }
  lat(y: number) { return this.lat0 + y / this.ky; }
}

/** Web-Mercator in Einheitsquadrat [0,1] (für Export). */
export function mercator(lng: number, lat: number): [number, number] {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/** Meter pro Pixel bei Zoom (512er-Kacheln wie MapLibre) und Breite. */
export function metersPerPixel(zoom: number, lat: number) {
  return (2 * Math.PI * R * Math.cos(lat * DEG)) / (512 * Math.pow(2, zoom));
}

export interface SegProjection { t: number; x: number; y: number; d: number }

/** Projektion von (px,py) auf Strecke a-b; t in [0,1] geklemmt. */
export function projectOnSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): SegProjection {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx, y = ay + t * dy;
  return { t, x, y, d: Math.hypot(px - x, py - y) };
}

/** Streckenschnitt: liefert Parameter (t,u) oder null (parallel / kein Schnitt). */
export function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): [number, number] | null {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

/** Polylinie (xy-flach) mit festem Abstand neu abtasten, letzter Punkt bleibt erhalten. */
export function resample(xy: ArrayLike<number>, spacing: number): Float64Array {
  const n = xy.length / 2;
  if (n < 2) return Float64Array.from(xy as ArrayLike<number>);
  const out: number[] = [xy[0], xy[1]];
  let carry = 0; // Strecke seit letztem Ausgabepunkt
  for (let i = 1; i < n; i++) {
    const x0 = xy[2 * i - 2], y0 = xy[2 * i - 1], x1 = xy[2 * i], y1 = xy[2 * i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) continue;
    let pos = spacing - carry;
    while (pos <= len) {
      const f = pos / len;
      out.push(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
      pos += spacing;
    }
    carry = len - (pos - spacing);
  }
  const lx = xy[2 * n - 2], ly = xy[2 * n - 1];
  if (out[out.length - 2] !== lx || out[out.length - 1] !== ly) {
    if (Math.hypot(out[out.length - 2] - lx, out[out.length - 1] - ly) > spacing * 0.25) out.push(lx, ly);
  }
  return Float64Array.from(out);
}
