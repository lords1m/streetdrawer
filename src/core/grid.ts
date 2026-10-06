/** Gleichmäßiges Raster über Strecken (CSR-Layout). Schnell aufgebaut, speichersparsam. */
export class SegGrid {
  readonly cell: number;
  readonly minX: number; readonly minY: number;
  readonly nx: number; readonly ny: number;
  private start: Uint32Array; private items: Uint32Array;
  private stamp: Uint32Array; private mark = 0;

  constructor(
    readonly ax: Float64Array, readonly ay: Float64Array,
    readonly bx: Float64Array, readonly by: Float64Array,
    readonly n: number, cellHint = 0,
  ) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sum = 0;
    for (let i = 0; i < n; i++) {
      const x0 = Math.min(ax[i], bx[i]), x1 = Math.max(ax[i], bx[i]);
      const y0 = Math.min(ay[i], by[i]), y1 = Math.max(ay[i], by[i]);
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
      sum += Math.hypot(ax[i] - bx[i], ay[i] - by[i]);
    }
    if (n === 0) { minX = minY = 0; maxX = maxY = 1; }
    const w = maxX - minX + 1e-9, h = maxY - minY + 1e-9;
    let cell = cellHint > 0 ? cellHint : Math.max((sum / Math.max(n, 1)) * 2, 1e-6);
    cell = Math.max(cell, Math.sqrt((w * h) / 4_000_000), Math.max(w, h) / 4096);
    this.cell = cell; this.minX = minX; this.minY = minY;
    this.nx = Math.max(1, Math.ceil(w / cell)); this.ny = Math.max(1, Math.ceil(h / cell));
    const cells = this.nx * this.ny;
    const count = new Uint32Array(cells + 1);
    for (let i = 0; i < n; i++) this.eachCell(i, (c) => { count[c + 1]++; });
    for (let c = 0; c < cells; c++) count[c + 1] += count[c];
    this.start = count;
    this.items = new Uint32Array(count[cells]);
    const fill = count.slice(0, cells);
    for (let i = 0; i < n; i++) this.eachCell(i, (c) => { this.items[fill[c]++] = i; });
    this.stamp = new Uint32Array(n);
  }
  private cx(x: number) { const c = Math.floor((x - this.minX) / this.cell); return c < 0 ? 0 : c >= this.nx ? this.nx - 1 : c; }
  private cy(y: number) { const c = Math.floor((y - this.minY) / this.cell); return c < 0 ? 0 : c >= this.ny ? this.ny - 1 : c; }

  /**
   * Alle Zellen, die Strecke i berührt. Kurze Strecken: Bounding-Box; lange: Rasterdurchlauf (Amanatides–Woo),
   * damit lange Diagonalen nicht die ganze Box ihrer Zellen belegen. An Ecken werden beide Nachbarzellen genommen.
   */
  private eachCell(i: number, cb: (c: number) => void) {
    const x0 = this.ax[i], y0 = this.ay[i], x1 = this.bx[i], y1 = this.by[i];
    let cx = this.cx(x0), cy = this.cy(y0);
    const ex = this.cx(x1), ey = this.cy(y1);
    const nx = this.nx;
    if ((Math.abs(ex - cx) + 1) * (Math.abs(ey - cy) + 1) <= 4) {
      for (let y = Math.min(cy, ey); y <= Math.max(cy, ey); y++) for (let x = Math.min(cx, ex); x <= Math.max(cx, ex); x++) cb(y * nx + x);
      return;
    }
    const dx = x1 - x0, dy = y1 - y0;
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tdx = sx ? this.cell / Math.abs(dx) : Infinity, tdy = sy ? this.cell / Math.abs(dy) : Infinity;
    let tmx = sx ? ((this.minX + (cx + (sx > 0 ? 1 : 0)) * this.cell) - x0) / dx : Infinity;
    let tmy = sy ? ((this.minY + (cy + (sy > 0 ? 1 : 0)) * this.cell) - y0) / dy : Infinity;
    cb(cy * nx + cx);
    const maxSteps = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
    for (let k = 0; k < maxSteps && (cx !== ex || cy !== ey); k++) {
      if (Math.abs(tmx - tmy) < 1e-12) {
        // genau durch eine Ecke: beide Nachbarn mitnehmen
        if (cx + sx >= 0 && cx + sx < nx) cb(cy * nx + cx + sx);
        if (cy + sy >= 0 && cy + sy < this.ny) cb((cy + sy) * nx + cx);
        cx += sx; cy += sy; tmx += tdx; tmy += tdy;
      } else if (tmx < tmy) { cx += sx; tmx += tdx; }
      else { cy += sy; tmy += tdy; }
      if (cx < 0 || cx >= nx || cy < 0 || cy >= this.ny) break;
      cb(cy * nx + cx);
    }
    // Rundungsfehler: Endzelle muss immer enthalten sein (Abfragen am Streckenende)
    if (cx !== ex || cy !== ey) cb(ey * nx + ex);
  }

  /** Ruft cb für jede Strecke, deren Zellen die Box berühren (jede Strecke höchstens einmal). */
  query(x0: number, y0: number, x1: number, y1: number, cb: (i: number) => void) {
    if (this.n === 0) return;
    const m = ++this.mark;
    if (m === 0xffffffff) { this.stamp.fill(0); this.mark = 1; }
    const cx0 = this.cx(x0), cx1 = this.cx(x1), cy0 = this.cy(y0), cy1 = this.cy(y1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.nx + cx;
        for (let k = this.start[c]; k < this.start[c + 1]; k++) {
          const i = this.items[k];
          if (this.stamp[i] !== m) { this.stamp[i] = m; cb(i); }
        }
      }
    }
  }
}
