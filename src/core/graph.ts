import { LocalProjection, projectOnSegment, segIntersect } from './geo';
import { GrowF64, GrowU32, IntPairMap } from './grow';
import { SegGrid } from './grid';

/** Klassen: 0 = Hauptstraße, 1 = Straße, 2 = Pfad. */
export const CLASS_MAIN = 0, CLASS_STREET = 1, CLASS_PATH = 2;

/** Eingabe: Polylinien in Metern (lokale Projektion). */
export interface PolylineSet {
  coords: Float64Array;   // x0,y0,x1,y1,…
  offsets: Uint32Array;   // Punktindex je Polylinie, Länge n+1
  cls: Uint8Array;
}

export interface BuildOptions {
  /** Knoten innerhalb dieser Distanz (m) werden zusammengeführt. */
  snap?: number;
  /** Kreuzungen planarisieren (Schnittpunkte als Knoten einfügen). */
  planarize?: boolean;
  /** T-Stöße: Sackgassen-Enden bis zu dieser Distanz an Strecken anbinden. */
  tee?: number;
  /** Lücken: Sackgassen-Enden bis zu dieser Distanz an Knoten/Strecken anbinden. */
  gap?: number;
}

export interface Graph {
  proj: LocalProjection;
  nodeCount: number;
  nodeX: Float64Array;
  nodeY: Float64Array;
  edgeCount: number;
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  edgeLen: Float64Array;
  edgeCls: Uint8Array;
  /** CSR: an Knoten n hängen die Kanten adjEdge[adjStart[n] .. adjStart[n+1]) */
  adjStart: Uint32Array;
  adjEdge: Uint32Array;
  grid: SegGrid; // über Kanten (ax,ay,bx,by = Kantenenden)
}

/** Knotenspeicher mit Snapping (inkl. Nachbarzellen-Prüfung gegen Zellgrenzen-Artefakte). */
class NodeStore {
  xs = new GrowF64(); ys = new GrowF64();
  private map = new IntPairMap();
  constructor(private snap: number) {}
  get count() { return this.xs.n; }
  get(x: number, y: number): number {
    const ix = Math.round(x / this.snap) | 0, iy = Math.round(y / this.snap) | 0;
    let id = this.map.get(ix, iy);
    if (id >= 0) return id;
    const s2 = this.snap * this.snap;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const o = this.map.get(ix + dx, iy + dy);
        if (o >= 0) {
          const ddx = this.xs.a[o] - x, ddy = this.ys.a[o] - y;
          if (ddx * ddx + ddy * ddy <= s2) { this.map.set(ix, iy, o); return o; }
        }
      }
    }
    id = this.xs.n;
    this.xs.push(x); this.ys.push(y);
    this.map.set(ix, iy, id);
    return id;
  }
}

export function buildGraph(src: PolylineSet, proj: LocalProjection, o: BuildOptions = {}): Graph {
  const snap = o.snap ?? 0.5;
  const tee = o.tee ?? 0;
  const gap = o.gap ?? 0;
  const doPlanarize = o.planarize ?? true;
  const nodes = new NodeStore(snap);

  // 1. Segmente mit Knoten-Snapping, Duplikate entfernen
  const sa = new GrowU32(), sb = new GrowU32(), sc = new GrowU32();
  const dup = new IntPairMap();
  const nPoly = src.offsets.length - 1;
  for (let p = 0; p < nPoly; p++) {
    let prev = -1;
    for (let k = src.offsets[p]; k < src.offsets[p + 1]; k++) {
      const id = nodes.get(src.coords[2 * k], src.coords[2 * k + 1]);
      if (prev >= 0 && id !== prev) {
        const lo = Math.min(prev, id), hi = Math.max(prev, id);
        const ex = dup.get(lo, hi);
        if (ex >= 0) { if (src.cls[p] < sc.a[ex]) sc.a[ex] = src.cls[p]; }
        else { dup.set(lo, hi, sa.n); sa.push(lo); sb.push(hi); sc.push(src.cls[p]); }
      }
      prev = id;
    }
  }
  const nSeg = sa.n;

  // 2. Planarisieren
  const splitSeg = new GrowU32(), splitNode = new GrowU32(), splitT = new GrowF64();
  const extraA = new GrowU32(), extraB = new GrowU32(), extraC = new GrowU32();
  if ((doPlanarize || tee > 0 || gap > 0) && nSeg > 0) {
    const nx = nodes.xs.a, ny = nodes.ys.a;
    const ax = new Float64Array(nSeg), ay = new Float64Array(nSeg), bx = new Float64Array(nSeg), by = new Float64Array(nSeg);
    const len = new Float64Array(nSeg);
    for (let i = 0; i < nSeg; i++) {
      ax[i] = nx[sa.a[i]]; ay[i] = ny[sa.a[i]]; bx[i] = nx[sb.a[i]]; by[i] = ny[sb.a[i]];
      len[i] = Math.hypot(bx[i] - ax[i], by[i] - ay[i]);
    }
    const grid = new SegGrid(ax, ay, bx, by, nSeg);
    const margin = Math.max(tee, snap);
    const addSplit = (s: number, t: number, node: number) => { splitSeg.push(s); splitT.push(t); splitNode.push(node); };

    if (doPlanarize) {
      for (let i = 0; i < nSeg; i++) {
        const A = sa.a[i], B = sb.a[i];
        grid.query(Math.min(ax[i], bx[i]), Math.min(ay[i], by[i]), Math.max(ax[i], bx[i]), Math.max(ay[i], by[i]), (j) => {
          if (j <= i) return;
          if (sa.a[j] === A || sa.a[j] === B || sb.a[j] === A || sb.a[j] === B) return;
          const r = segIntersect(ax[i], ay[i], bx[i], by[i], ax[j], ay[j], bx[j], by[j]);
          if (!r) return;
          const [t, u] = r;
          const ei = margin / len[i], ej = margin / len[j];
          const iIn = t > ei && t < 1 - ei, jIn = u > ej && u < 1 - ej;
          if (iIn && jIn) {
            const node = nodes.get(ax[i] + (bx[i] - ax[i]) * t, ay[i] + (by[i] - ay[i]) * t);
            addSplit(i, t, node); addSplit(j, u, node);
          } else if (iIn) {
            // Ende von j liegt auf i (T-Stoß): i am vorhandenen Endknoten von j teilen
            addSplit(i, t, u < 0.5 ? sa.a[j] : sb.a[j]);
          } else if (jIn) {
            addSplit(j, u, t < 0.5 ? sa.a[i] : sb.a[i]);
          }
        });
      }
    }

    const R = Math.max(tee, gap);
    if (R > 0) {
      const deg = new Uint32Array(nodes.count);
      const inc = new Int32Array(nodes.count).fill(-1);
      for (let i = 0; i < nSeg; i++) {
        deg[sa.a[i]]++; deg[sb.a[i]]++;
        inc[sa.a[i]] = i; inc[sb.a[i]] = i;
      }
      for (let d = 0; d < deg.length; d++) {
        if (deg[d] !== 1) continue;
        const px = nx[d], py = ny[d], s0 = inc[d];
        let bestD = Infinity, bestJ = -1, bestT = 0;
        grid.query(px - R, py - R, px + R, py + R, (j) => {
          if (j === s0) return;
          const pr = projectOnSegment(px, py, ax[j], ay[j], bx[j], by[j]);
          if (pr.d < bestD) { bestD = pr.d; bestJ = j; bestT = pr.t; }
        });
        if (bestJ < 0 || bestD > R) continue;
        const interior = bestT * len[bestJ] > margin && (1 - bestT) * len[bestJ] > margin;
        if (interior) {
          const P = nodes.get(ax[bestJ] + (bx[bestJ] - ax[bestJ]) * bestT, ay[bestJ] + (by[bestJ] - ay[bestJ]) * bestT);
          addSplit(bestJ, bestT, P);
          if (P !== d) { extraA.push(d); extraB.push(P); extraC.push(sc.a[s0]); }
        } else {
          const m = bestT < 0.5 ? sa.a[bestJ] : sb.a[bestJ];
          if (m !== d) { extraA.push(d); extraB.push(m); extraC.push(sc.a[s0]); }
        }
      }
    }
  }

  // 3. Kanten aufbauen (Splits je Segment nach t sortiert)
  const cnt = new Uint32Array(nSeg + 1);
  for (let k = 0; k < splitSeg.n; k++) cnt[splitSeg.a[k] + 1]++;
  for (let i = 0; i < nSeg; i++) cnt[i + 1] += cnt[i];
  const fill = cnt.slice(0, nSeg);
  const order = new Uint32Array(splitSeg.n);
  for (let k = 0; k < splitSeg.n; k++) order[fill[splitSeg.a[k]]++] = k;

  const ea = new GrowU32(), eb = new GrowU32(), ec = new GrowU32();
  const edup = new IntPairMap();
  const addEdge = (a: number, b: number, c: number) => {
    if (a === b) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const ex = edup.get(lo, hi);
    if (ex >= 0) { if (c < ec.a[ex]) ec.a[ex] = c; return; }
    edup.set(lo, hi, ea.n); ea.push(lo); eb.push(hi); ec.push(c);
  };
  for (let i = 0; i < nSeg; i++) {
    const s = cnt[i], e = cnt[i + 1];
    if (s === e) { addEdge(sa.a[i], sb.a[i], sc.a[i]); continue; }
    const idx = Array.from(order.subarray(s, e)).sort((p, q) => splitT.a[p] - splitT.a[q]);
    let prev = sa.a[i];
    for (const k of idx) { addEdge(prev, splitNode.a[k], sc.a[i]); prev = splitNode.a[k]; }
    addEdge(prev, sb.a[i], sc.a[i]);
  }
  for (let k = 0; k < extraA.n; k++) addEdge(extraA.a[k], extraB.a[k], extraC.a[k]);

  return finishGraph(proj, nodes.xs.toArray(), nodes.ys.toArray(), ea.toArray(), eb.toArray(), ec.toArray());
}

export function finishGraph(
  proj: LocalProjection, nodeX: Float64Array, nodeY: Float64Array,
  edgeA: Uint32Array, edgeB: Uint32Array, cls: ArrayLike<number>,
): Graph {
  const nodeCount = nodeX.length, edgeCount = edgeA.length;
  const edgeLen = new Float64Array(edgeCount);
  const edgeCls = new Uint8Array(edgeCount);
  const ax = new Float64Array(edgeCount), ay = new Float64Array(edgeCount);
  const bx = new Float64Array(edgeCount), by = new Float64Array(edgeCount);
  const adjStart = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < edgeCount; i++) {
    const a = edgeA[i], b = edgeB[i];
    ax[i] = nodeX[a]; ay[i] = nodeY[a]; bx[i] = nodeX[b]; by[i] = nodeY[b];
    edgeLen[i] = Math.hypot(bx[i] - ax[i], by[i] - ay[i]);
    edgeCls[i] = cls[i];
    adjStart[a + 1]++; adjStart[b + 1]++;
  }
  for (let n = 0; n < nodeCount; n++) adjStart[n + 1] += adjStart[n];
  const adjEdge = new Uint32Array(adjStart[nodeCount]);
  const fill = adjStart.slice(0, nodeCount);
  for (let i = 0; i < edgeCount; i++) { adjEdge[fill[edgeA[i]]++] = i; adjEdge[fill[edgeB[i]]++] = i; }
  const grid = new SegGrid(ax, ay, bx, by, edgeCount);
  return { proj, nodeCount, nodeX, nodeY, edgeCount, edgeA, edgeB, edgeLen, edgeCls, adjStart, adjEdge, grid };
}

/** Bequem: Polylinien aus Arrays von [x,y]-Paaren (nur Tests/kleine Daten). */
export function polylinesFromArrays(lines: number[][][], cls: number | number[] = 1): PolylineSet {
  let n = 0;
  for (const l of lines) n += l.length;
  const coords = new Float64Array(n * 2), offsets = new Uint32Array(lines.length + 1);
  const c = new Uint8Array(lines.length);
  let k = 0;
  lines.forEach((l, i) => {
    offsets[i] = k;
    c[i] = Array.isArray(cls) ? cls[i] : cls;
    for (const [x, y] of l) { coords[2 * k] = x; coords[2 * k + 1] = y; k++; }
  });
  offsets[lines.length] = k;
  return { coords, offsets, cls: c };
}
