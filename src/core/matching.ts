import { projectOnSegment } from './geo';
import type { Graph } from './graph';
import { Router } from './router';

export interface MatchOptions {
  /** Fangradius in Metern: Kandidaten = Kanten innerhalb dieses Abstands. */
  radius: number;
  /** σ der Emission (Standard radius/2). Kosten (d/σ)². */
  sigma?: number;
  /** β der Transition (Standard max(0.3·spacing, 2)). Kosten |Netzdistanz − Luftlinie| / β. */
  beta?: number;
  /** Abtastabstand in m (Standard radius/2, 1.5 … 40). */
  spacing?: number;
  maxCandidates?: number;
  /** Bitmaske erlaubter Klassen (bit0 Haupt, bit1 Straße, bit2 Pfad). Standard alle. */
  classMask?: number;
}

interface Layer {
  n: number;
  edge: Int32Array;
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  cost: Float64Array;
  back: Int32Array;
  rx: number; ry: number; // abgetasteter Rohpunkt
  start: boolean;         // Kette beginnt hier (kein Vorgänger)
}

/**
 * Inkrementelles HMM-Map-Matching (Viterbi). Punkte können laufend nachgereicht werden,
 * result() liefert jederzeit den besten Pfad (Vorschau); Legs werden zwischengespeichert.
 */
export class MatchSession {
  private layers: Layer[] = [];
  private router: Router;
  private legCache = new Map<number, Float64Array>();
  private pendingBreak = false;
  readonly spacing: number;
  private sigma: number;
  private beta: number;
  private K: number;
  private mask: number;
  private snapToNode: number;
  // inkrementelles Resampling
  private lastX = NaN; private lastY = NaN; private carry = 0;
  private emitX = NaN; private emitY = NaN;

  constructor(private g: Graph, private o: MatchOptions, router?: Router) {
    this.router = router ?? new Router(g);
    this.spacing = o.spacing ?? Math.min(40, Math.max(1.5, o.radius / 2));
    this.sigma = o.sigma ?? o.radius / 2;
    this.beta = o.beta ?? Math.max(this.spacing * 0.3, 2);
    this.K = o.maxCandidates ?? 6;
    this.mask = o.classMask ?? 7;
    this.snapToNode = Math.min(o.radius * 0.25, this.spacing * 0.5);
  }

  get layerCount() { return this.layers.length; }

  /** Roh-Punkt (Meter) hinzufügen; wird intern auf `spacing` abgetastet. */
  feed(x: number, y: number) {
    if (Number.isNaN(this.lastX)) {
      this.lastX = x; this.lastY = y; this.carry = 0;
      this.emit(x, y);
      return;
    }
    const len = Math.hypot(x - this.lastX, y - this.lastY);
    if (len === 0) return;
    let pos = this.spacing - this.carry;
    const x0 = this.lastX, y0 = this.lastY;
    while (pos <= len) {
      const f = pos / len;
      this.emit(x0 + (x - x0) * f, y0 + (y - y0) * f);
      pos += this.spacing;
    }
    this.carry = len - (pos - this.spacing);
    this.lastX = x; this.lastY = y;
  }

  feedAll(xy: ArrayLike<number>) {
    for (let i = 0; i < xy.length; i += 2) this.feed(xy[i], xy[i + 1]);
  }

  /** Abschluss: den letzten Rohpunkt als Layer aufnehmen, falls er noch fehlt. */
  finish() {
    if (Number.isNaN(this.lastX)) return;
    if (Math.hypot(this.lastX - this.emitX, this.lastY - this.emitY) > this.spacing * 0.25) this.emit(this.lastX, this.lastY);
  }

  private findCandidates(x: number, y: number) {
    const g = this.g, r = this.o.radius;
    const list: { e: number; t: number; x: number; y: number; d: number }[] = [];
    const gr = g.grid;
    gr.query(x - r, y - r, x + r, y + r, (e) => {
      if (!((this.mask >> g.edgeCls[e]) & 1)) return;
      const p = projectOnSegment(x, y, gr.ax[e], gr.ay[e], gr.bx[e], gr.by[e]);
      if (p.d > r) return;
      // Kandidaten nahe einem Kantenende auf den Knoten setzen: sauberer Verlauf an Kreuzungen
      const len = g.edgeLen[e], tol = this.snapToNode;
      if (p.t * len < tol) { p.t = 0; p.x = gr.ax[e]; p.y = gr.ay[e]; }
      else if ((1 - p.t) * len < tol) { p.t = 1; p.x = gr.bx[e]; p.y = gr.by[e]; }
      list.push({ e, t: p.t, x: p.x, y: p.y, d: Math.hypot(x - p.x, y - p.y) });
    });
    list.sort((a, b) => a.d - b.d);
    return list.length > this.K ? list.slice(0, this.K) : list;
  }

  private emit(x: number, y: number) {
    this.emitX = x; this.emitY = y;
    const cands = this.findCandidates(x, y);
    if (cands.length === 0) { this.pendingBreak = true; return; }
    const n = cands.length;
    const L: Layer = {
      n, edge: new Int32Array(n), t: new Float64Array(n), x: new Float64Array(n), y: new Float64Array(n),
      cost: new Float64Array(n), back: new Int32Array(n).fill(-1), rx: x, ry: y, start: true,
    };
    const s2 = this.sigma * this.sigma;
    for (let j = 0; j < n; j++) {
      const c = cands[j];
      L.edge[j] = c.e; L.t[j] = c.t; L.x[j] = c.x; L.y[j] = c.y;
      L.cost[j] = (c.d * c.d) / s2;
    }
    const prev = this.layers[this.layers.length - 1];
    if (prev && !this.pendingBreak) {
      const air = Math.hypot(x - prev.rx, y - prev.ry);
      if (this.transitions(prev, L, air)) L.start = false;
    }
    this.pendingBreak = false;
    this.layers.push(L);
  }

  /** Füllt cur.cost/back; false, wenn kein Vorgänger erreichbar ist. */
  private transitions(prev: Layer, cur: Layer, air: number): boolean {
    const g = this.g;
    const limit = Math.max(air * 3, this.o.radius * 4);
    const best = new Float64Array(cur.n).fill(Infinity);
    const bestK = new Int32Array(cur.n).fill(-1);
    const beta = this.beta;
    for (let k = 0; k < prev.n; k++) {
      const base = prev.cost[k];
      if (!Number.isFinite(base)) continue;
      const e = prev.edge[k], len = g.edgeLen[e], ta = prev.t[k] * len;
      for (let j = 0; j < cur.n; j++) {
        if (cur.edge[j] === e) {
          const dn = Math.abs(ta - cur.t[j] * len);
          const c = base + Math.abs(dn - air) / beta;
          if (c < best[j]) { best[j] = c; bestK[j] = k; }
        }
      }
      for (let side = 0; side < 2; side++) {
        const u = side === 0 ? g.edgeA[e] : g.edgeB[e];
        const du = side === 0 ? ta : len - ta;
        this.router.run(u, limit, this.mask);
        for (let j = 0; j < cur.n; j++) {
          const f = cur.edge[j];
          if (f === e) continue;
          const lf = g.edgeLen[f], tb = cur.t[j] * lf;
          const da = this.router.distTo(g.edgeA[f]) + tb;
          const db = this.router.distTo(g.edgeB[f]) + (lf - tb);
          const dn = du + Math.min(da, db);
          if (dn === Infinity) continue;
          const c = base + Math.abs(dn - air) / beta;
          if (c < best[j]) { best[j] = c; bestK[j] = k; }
        }
      }
    }
    let any = false;
    for (let j = 0; j < cur.n; j++) {
      if (bestK[j] >= 0) {
        any = true;
        const ex = cur.cost[j]; // enthält bereits Emission
        cur.cost[j] = best[j] + ex;
        cur.back[j] = bestK[j];
      }
    }
    if (!any) return false;
    // Kandidaten ohne Vorgänger sind unerreichbar
    for (let j = 0; j < cur.n; j++) if (bestK[j] < 0) cur.cost[j] = Infinity;
    return true;
  }

  /** Geometrie vom Punkt auf Kante e (Layer i-1, Kandidat k) zum Kandidaten j in Layer i (ohne Startpunkt). */
  private leg(i: number, k: number, j: number): Float64Array {
    const key = (i * 16 + k) * 16 + j;
    const hit = this.legCache.get(key);
    if (hit) return hit;
    const g = this.g, prev = this.layers[i - 1], cur = this.layers[i];
    const e = prev.edge[k], f = cur.edge[j];
    let out: Float64Array;
    if (e === f) {
      out = Float64Array.of(cur.x[j], cur.y[j]);
    } else {
      const air = Math.hypot(cur.rx - prev.rx, cur.ry - prev.ry);
      const limit = Math.max(air * 3, this.o.radius * 4);
      const le = g.edgeLen[e], lf = g.edgeLen[f];
      const ta = prev.t[k] * le, tb = cur.t[j] * lf;
      let bestD = Infinity, bu = -1, bv = -1;
      for (let s = 0; s < 2; s++) {
        const u = s === 0 ? g.edgeA[e] : g.edgeB[e], du = s === 0 ? ta : le - ta;
        this.router.run(u, limit, this.mask);
        for (let t = 0; t < 2; t++) {
          const v = t === 0 ? g.edgeA[f] : g.edgeB[f], dv = t === 0 ? tb : lf - tb;
          const d = du + this.router.distTo(v) + dv;
          if (d < bestD) { bestD = d; bu = u; bv = v; }
        }
      }
      if (bu < 0) {
        out = Float64Array.of(cur.x[j], cur.y[j]);
      } else {
        this.router.run(bu, limit, this.mask);
        const nodes = this.router.pathTo(bv);
        out = new Float64Array(nodes.length * 2 + 2);
        nodes.forEach((nd, q) => { out[2 * q] = g.nodeX[nd]; out[2 * q + 1] = g.nodeY[nd]; });
        out[nodes.length * 2] = cur.x[j]; out[nodes.length * 2 + 1] = cur.y[j];
      }
    }
    this.legCache.set(key, out);
    return out;
  }

  /** Bester Pfad als Liste zusammenhängender Teilstücke (xy-flach, Meter). */
  result(): Float64Array[] {
    const L = this.layers, parts: Float64Array[] = [];
    let s = 0;
    while (s < L.length) {
      let e = s + 1;
      while (e < L.length && !L[e].start) e++;
      e--; // Kette s..e
      // bester Endzustand
      let bj = 0, bc = Infinity;
      for (let j = 0; j < L[e].n; j++) if (L[e].cost[j] < bc) { bc = L[e].cost[j]; bj = j; }
      const choice = new Int32Array(e - s + 1);
      choice[e - s] = bj;
      for (let i = e; i > s; i--) choice[i - 1 - s] = L[i].back[choice[i - s]];
      const pts: number[] = [L[s].x[choice[0]], L[s].y[choice[0]]];
      for (let i = s + 1; i <= e; i++) {
        const leg = this.leg(i, choice[i - 1 - s], choice[i - s]);
        for (let q = 0; q < leg.length; q += 2) {
          const n = pts.length;
          if (pts[n - 2] === leg[q] && pts[n - 1] === leg[q + 1]) continue;
          pts.push(leg[q], leg[q + 1]);
        }
      }
      if (pts.length >= 4) parts.push(Float64Array.from(pts));
      s = e + 1;
    }
    return parts;
  }
}

/** Einmal-Matching eines kompletten Strichs (xy-flach, Meter). */
export function matchPath(g: Graph, xy: ArrayLike<number>, o: MatchOptions): Float64Array[] {
  const s = new MatchSession(g, o);
  s.feedAll(xy);
  s.finish();
  return s.result();
}
