import { describe, expect, it } from 'vitest';
import { buildGraph, polylinesFromArrays } from '../src/core/graph';
import { LocalProjection, resample } from '../src/core/geo';
import { MatchSession, matchPath } from '../src/core/matching';

const proj = new LocalProjection(13.4, 52.5);

/** 5x5-Straßengitter, Blocklänge 100 m. */
function gridGraph() {
  const lines: number[][][] = [];
  for (let i = 0; i <= 4; i++) {
    lines.push([[i * 100, 0], [i * 100, 400]]);
    lines.push([[0, i * 100], [400, i * 100]]);
  }
  return buildGraph(polylinesFromArrays(lines), proj, { planarize: true });
}

// deterministisches Rauschen
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff - 0.5; };
}

describe('Map-Matching', () => {
  const g = gridGraph();

  it('rastet einen leicht verwackelten geraden Strich auf der Straße ein', () => {
    const r = rng(1);
    const raw: number[] = [];
    for (let x = 0; x <= 400; x += 8) raw.push(x, 100 + r() * 14);
    const parts = matchPath(g, raw, { radius: 20 });
    expect(parts.length).toBe(1);
    const p = parts[0];
    for (let i = 0; i < p.length; i += 2) expect(Math.abs(p[i + 1] - 100)).toBeLessThan(1e-6);
    expect(p[0]).toBeLessThan(10);
    expect(p[p.length - 2]).toBeGreaterThan(390);
  });

  it('folgt Straßenecken statt diagonal abzukürzen', () => {
    // Diagonale von (0,0) nach (200,200): Treppe über das Gitter
    const raw: number[] = [];
    for (let k = 0; k <= 50; k++) raw.push(k * 4, k * 4);
    const parts = matchPath(g, raw, { radius: 60 });
    expect(parts.length).toBe(1);
    const p = parts[0];
    // jeder Punkt liegt auf einer Gitterlinie
    for (let i = 0; i < p.length; i += 2) {
      const onV = Math.abs(p[i] % 100) < 1e-6 || Math.abs((p[i] % 100) - 100) < 1e-6;
      const onH = Math.abs(p[i + 1] % 100) < 1e-6 || Math.abs((p[i + 1] % 100) - 100) < 1e-6;
      expect(onV || onH).toBe(true);
    }
  });

  it('wählt bei Abweichung die näher liegende Parallelstraße', () => {
    const raw: number[] = [];
    for (let x = 0; x <= 400; x += 8) raw.push(x, 285);
    const parts = matchPath(g, raw, { radius: 30 });
    expect(parts.length).toBe(1);
    const p = parts[0];
    for (let i = 1; i < p.length; i += 2) expect(Math.abs(p[i] - 300)).toBeLessThan(1e-6);
  });

  it('trennt Teilstücke ohne Verbindung (Strich verlässt das Netz)', () => {
    // Strich läuft auf y=100, weicht zwischen x=225 und x=275 auf y=150 aus (>20 m von jeder Straße) und kehrt zurück
    const raw = [0, 100, 180, 100, 225, 150, 275, 150, 320, 100, 400, 100];
    const parts = matchPath(g, raw, { radius: 20 });
    expect(parts.length).toBe(2);
    for (const p of parts) for (let i = 0; i < p.length; i += 2) expect(p[i] < 215 || p[i] > 285).toBe(true);
  });

  it('trennt Teilstücke in unverbundenen Netzkomponenten', () => {
    const g2 = buildGraph(polylinesFromArrays([[[0, 0], [100, 0]], [[0, 30], [100, 30]]]), proj, { planarize: true });
    const raw: number[] = [];
    for (let x = 0; x <= 100; x += 5) raw.push(x, x < 50 ? 2 : 28);
    const parts = matchPath(g2, raw, { radius: 20 });
    expect(parts.length).toBe(2);
  });

  it('respektiert die Klassenmaske', () => {
    const lines = [[[0, 0], [200, 0]], [[0, 10], [200, 10]]];
    const g3 = buildGraph(polylinesFromArrays(lines, [0, 2]), proj);
    const raw: number[] = [];
    for (let x = 0; x <= 200; x += 5) raw.push(x, 9);
    const onlyMain = matchPath(g3, raw, { radius: 20, classMask: 1 });
    expect(onlyMain[0][1]).toBe(0);
    const onlyPath = matchPath(g3, raw, { radius: 20, classMask: 4 });
    expect(onlyPath[0][1]).toBe(10);
  });

  it('inkrementelle Session liefert dasselbe Ergebnis wie Einmal-Matching', () => {
    const raw: number[] = [];
    for (let k = 0; k <= 100; k++) raw.push(k * 4, 100 + Math.sin(k) * 6);
    const once = matchPath(g, raw, { radius: 20 });
    const s = new MatchSession(g, { radius: 20 });
    for (let i = 0; i < raw.length; i += 2) { s.feed(raw[i], raw[i + 1]); if (i % 20 === 0) s.result(); }
    s.finish();
    const inc = s.result();
    expect(inc.length).toBe(once.length);
    expect(Array.from(inc[0])).toEqual(Array.from(once[0]));
  });

  it('Vorschau auf großem Netz bleibt unter 30 ms pro Aufruf', () => {
    const lines: number[][][] = [];
    for (let i = 0; i < 150; i++) {
      lines.push([[i * 50, 0], [i * 50, 7500]]);
      lines.push([[0, i * 50], [7500, i * 50]]);
    }
    const big = buildGraph(polylinesFromArrays(lines), proj, { planarize: true });
    const s = new MatchSession(big, { radius: 25 });
    const times: number[] = [];
    const r = rng(7);
    for (let k = 0; k < 400; k++) {
      s.feed(3000 + k * 6, 3000 + k * 3 + r() * 20);
      const t0 = performance.now();
      s.result();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(30);
  });
});

describe('resample', () => {
  it('tastet gleichmäßig ab und behält das Ende', () => {
    const out = resample([0, 0, 100, 0], 10);
    expect(out.length / 2).toBe(11);
    expect(out[out.length - 2]).toBe(100);
  });
});
