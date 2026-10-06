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
    for (let i = 0; i < n; i++) {
      const cx0 = this.cx(Math.min(ax[i], bx[i])), cx1 = this.cx(Math.max(ax[i], bx[i]));
      const cy0 = this.cy(Math.min(ay[i], by[i])), cy1 = this.cy(Math.max(ay[i], by[i]));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) count[cy * this.nx + cx + 1]++;
    }
    for (let c = 0; c < cells; c++) count[c + 1] += count[c];
    this.start = count;
    this.items = new Uint32Array(count[cells]);
    const fill = count.slice(0, cells);
    for (let i = 0; i < n; i++) {
      const cx0 = this.cx(Math.min(ax[i], bx[i])), cx1 = this.cx(Math.max(ax[i], bx[i]));
      const cy0 = this.cy(Math.min(ay[i], by[i])), cy1 = this.cy(Math.max(ay[i], by[i]));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.items[fill[cy * this.nx + cx]++] = i;
    }
    this.stamp = new Uint32Array(n);
  }
  private cx(x: number) { const c = Math.floor((x - this.minX) / this.cell); return c < 0 ? 0 : c >= this.nx ? this.nx - 1 : c; }
  private cy(y: number) { const c = Math.floor((y - this.minY) / this.cell); return c < 0 ? 0 : c >= this.ny ? this.ny - 1 : c; }

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
