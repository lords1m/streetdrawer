/// <reference lib="webworker" />
import { LocalProjection } from '../core/geo';
import { buildGraph, type Graph } from '../core/graph';
import { MatchSession } from '../core/matching';
import { Router } from '../core/router';
import type { LineBatch, Slot, WorkerIn, WorkerOut } from '../core/types';

interface NetState { graph: Graph; router: Router }
const nets: Partial<Record<Slot, NetState>> = {};
const sessions = new Map<number, { session: MatchSession; slot: Slot; proj: LocalProjection }>();

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function toMeters(lines: LineBatch): { xy: Float64Array; proj: LocalProjection } {
  const n = lines.coords.length / 2;
  const xy = new Float64Array(lines.coords.length);
  if (lines.kind === 'meters') {
    const o = lines.origin ?? [0, 0];
    xy.set(lines.coords);
    return { xy, proj: new LocalProjection(o[0], o[1]) };
  }
  // Ursprung = Mittelpunkt der Daten
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = lines.coords[2 * i], y = lines.coords[2 * i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const proj = new LocalProjection(n ? (minX + maxX) / 2 : 0, n ? (minY + maxY) / 2 : 0);
  for (let i = 0; i < n; i++) { xy[2 * i] = proj.x(lines.coords[2 * i]); xy[2 * i + 1] = proj.y(lines.coords[2 * i + 1]); }
  return { xy, proj };
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  try {
    switch (m.op) {
      case 'setNetwork': {
        const t0 = performance.now();
        const { xy, proj } = toMeters(m.lines);
        const graph = buildGraph({ coords: xy, offsets: m.lines.offsets, cls: m.lines.cls }, proj, m.build);
        nets[m.slot] = { graph, router: new Router(graph) };
        for (const [sid, s] of sessions) if (s.slot === m.slot) sessions.delete(sid);
        post({ op: 'ready', rid: m.rid, slot: m.slot, stats: { nodes: graph.nodeCount, edges: graph.edgeCount, ms: performance.now() - t0 } });
        break;
      }
      case 'clear': {
        delete nets[m.slot];
        post({ op: 'cleared', rid: m.rid });
        break;
      }
      case 'overlay': {
        const g = nets[m.slot]?.graph;
        if (!g) { post({ op: 'overlay', rid: m.rid, src: new Float64Array(0), dst: new Float64Array(0), cls: new Uint8Array(0) }); break; }
        const src = new Float64Array(g.edgeCount * 2), dst = new Float64Array(g.edgeCount * 2);
        for (let e = 0; e < g.edgeCount; e++) {
          const a = g.edgeA[e], b = g.edgeB[e];
          src[2 * e] = g.proj.lng(g.nodeX[a]); src[2 * e + 1] = g.proj.lat(g.nodeY[a]);
          dst[2 * e] = g.proj.lng(g.nodeX[b]); dst[2 * e + 1] = g.proj.lat(g.nodeY[b]);
        }
        post({ op: 'overlay', rid: m.rid, src, dst, cls: g.edgeCls }, [src.buffer, dst.buffer]);
        break;
      }
      case 'feed': {
        const net = nets[m.slot];
        if (!net) { post({ op: 'result', rid: m.rid, sid: m.sid, parts: [], ms: 0, final: m.final }); break; }
        const t0 = performance.now();
        let s = sessions.get(m.sid);
        if (!s) {
          s = {
            session: new MatchSession(net.graph, { radius: m.radiusM, classMask: m.classMask }, net.router),
            slot: m.slot, proj: net.graph.proj,
          };
          sessions.set(m.sid, s);
        }
        for (let i = 0; i < m.points.length; i += 2) s.session.feed(s.proj.x(m.points[i]), s.proj.y(m.points[i + 1]));
        if (m.final) s.session.finish();
        const parts = s.session.result().map((p) => {
          const o = new Float64Array(p.length);
          for (let i = 0; i < p.length; i += 2) { o[i] = s!.proj.lng(p[i]); o[i + 1] = s!.proj.lat(p[i + 1]); }
          return o;
        });
        if (m.final) sessions.delete(m.sid);
        post({ op: 'result', rid: m.rid, sid: m.sid, parts, ms: performance.now() - t0, final: m.final }, parts.map((p) => p.buffer));
        break;
      }
      case 'drop':
        sessions.delete(m.sid);
        break;
    }
  } catch (err) {
    post({ op: 'error', rid: (m as { rid: number }).rid, message: String((err as Error)?.stack ?? err) });
  }
};
