import type { Graph } from './graph';

/** Begrenzter Dijkstra mit wiederverwendbaren Puffern (Zeitstempel statt Neuinitialisierung). */
export class Router {
  private dist: Float64Array;
  private seen: Uint32Array;
  private predEdge: Int32Array;
  private stamp = 0;
  private hk = new Float64Array(256);
  private hv = new Uint32Array(256);
  private hn = 0;

  constructor(private g: Graph) {
    this.dist = new Float64Array(g.nodeCount);
    this.seen = new Uint32Array(g.nodeCount);
    this.predEdge = new Int32Array(g.nodeCount);
  }

  private push(k: number, v: number) {
    if (this.hn === this.hk.length) {
      const nk = new Float64Array(this.hn * 2); nk.set(this.hk); this.hk = nk;
      const nv = new Uint32Array(this.hn * 2); nv.set(this.hv); this.hv = nv;
    }
    let i = this.hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.hk[p] <= k) break;
      this.hk[i] = this.hk[p]; this.hv[i] = this.hv[p]; i = p;
    }
    this.hk[i] = k; this.hv[i] = v;
  }
  private pop() {
    const k = this.hk[this.hn - 1], v = this.hv[this.hn - 1];
    this.hn--;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.hn) break;
      if (c + 1 < this.hn && this.hk[c + 1] < this.hk[c]) c++;
      if (this.hk[c] >= k) break;
      this.hk[i] = this.hk[c]; this.hv[i] = this.hv[c]; i = c;
    }
    this.hk[i] = k; this.hv[i] = v;
  }

  /** Alle Knoten bis `limit` Meter von `src`, nur über Kanten erlaubter Klassen (Bitmaske). Danach: distTo(v). */
  run(src: number, limit: number, mask = 0xff) {
    const g = this.g;
    if (++this.stamp === 0xffffffff) { this.seen.fill(0); this.stamp = 1; }
    const st = this.stamp;
    this.hn = 0;
    this.dist[src] = 0; this.seen[src] = st; this.predEdge[src] = -1;
    this.push(0, src);
    while (this.hn > 0) {
      const d = this.hk[0], u = this.hv[0];
      this.pop();
      if (d > this.dist[u]) continue;
      for (let k = g.adjStart[u]; k < g.adjStart[u + 1]; k++) {
        const e = g.adjEdge[k];
        if (!((mask >> g.edgeCls[e]) & 1)) continue;
        const v = g.edgeA[e] === u ? g.edgeB[e] : g.edgeA[e];
        const nd = d + g.edgeLen[e];
        if (nd > limit) continue;
        if (this.seen[v] !== st || nd < this.dist[v]) {
          this.seen[v] = st; this.dist[v] = nd; this.predEdge[v] = e;
          this.push(nd, v);
        }
      }
    }
  }
  distTo(v: number): number { return this.seen[v] === this.stamp ? this.dist[v] : Infinity; }

  /** Knotenfolge src→v des letzten run(). */
  pathTo(v: number): number[] {
    const out: number[] = [v];
    const g = this.g;
    let cur = v;
    while (this.predEdge[cur] >= 0) {
      const e = this.predEdge[cur];
      cur = g.edgeA[e] === cur ? g.edgeB[e] : g.edgeA[e];
      out.push(cur);
    }
    return out.reverse();
  }
}
