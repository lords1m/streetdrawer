import { describe, expect, it } from 'vitest';
import { buildGraph, polylinesFromArrays } from '../src/core/graph';
import { LocalProjection } from '../src/core/geo';

const proj = new LocalProjection(13.4, 52.5);

describe('Netzaufbau / Planarisierung', () => {
  it('führt Knoten innerhalb der Snap-Toleranz zusammen', () => {
    const g = buildGraph(polylinesFromArrays([[[0, 0], [100, 0]], [[100.2, 0.1], [100, 100]]]), proj, { snap: 0.5 });
    expect(g.nodeCount).toBe(3);
    expect(g.edgeCount).toBe(2);
  });

  it('entfernt doppelte Kanten und Nullkanten', () => {
    const g = buildGraph(polylinesFromArrays([[[0, 0], [10, 0], [10, 0]], [[10, 0], [0, 0]]]), proj);
    expect(g.edgeCount).toBe(1);
  });

  it('teilt sich kreuzende Linien am Schnittpunkt (X-Kreuzung)', () => {
    const g = buildGraph(polylinesFromArrays([[[-50, 0], [50, 0]], [[0, -50], [0, 50]]]), proj, { planarize: true });
    expect(g.nodeCount).toBe(5);
    expect(g.edgeCount).toBe(4);
    // Mittelknoten hat Grad 4
    let maxDeg = 0;
    for (let n = 0; n < g.nodeCount; n++) maxDeg = Math.max(maxDeg, g.adjStart[n + 1] - g.adjStart[n]);
    expect(maxDeg).toBe(4);
  });

  it('ohne planarize bleibt die Kreuzung unverbunden', () => {
    const g = buildGraph(polylinesFromArrays([[[-50, 0], [50, 0]], [[0, -50], [0, 50]]]), proj, { planarize: false });
    expect(g.edgeCount).toBe(2);
  });

  it('bindet T-Stöße an (Ende knapp vor einer Linie)', () => {
    const g = buildGraph(polylinesFromArrays([[[-50, 0], [50, 0]], [[0, 0.8], [0, 60]]]), proj, { planarize: true, tee: 1.5 });
    // horizontale Linie wird bei x=0 geteilt, Querstrich angebunden
    expect(g.edgeCount).toBe(4);
    let maxDeg = 0;
    for (let n = 0; n < g.nodeCount; n++) maxDeg = Math.max(maxDeg, g.adjStart[n + 1] - g.adjStart[n]);
    expect(maxDeg).toBeGreaterThanOrEqual(3);
  });

  it('überbrückt schmale Lücken zwischen zwei Sackgassen-Enden', () => {
    const lines = [[[0, 0], [50, 0]], [[52, 0], [100, 0]]];
    const noGap = buildGraph(polylinesFromArrays(lines), proj, { gap: 0 });
    const gap = buildGraph(polylinesFromArrays(lines), proj, { gap: 3 });
    expect(noGap.edgeCount).toBe(2);
    expect(gap.edgeCount).toBe(3);
  });

  it('lässt breite Lücken offen', () => {
    const g = buildGraph(polylinesFromArrays([[[0, 0], [50, 0]], [[60, 0], [100, 0]]]), proj, { gap: 3 });
    expect(g.edgeCount).toBe(2);
  });

  it('verarbeitet ein Gitter mit 200x200 Linien (40.000 Kreuzungen) zügig', () => {
    const lines: number[][][] = [];
    for (let i = 0; i < 200; i++) {
      lines.push([[i * 10, -10], [i * 10, 2010]]);
      lines.push([[-10, i * 10], [2010, i * 10]]);
    }
    const t0 = performance.now();
    const g = buildGraph(polylinesFromArrays(lines), proj, { planarize: true });
    const dt = performance.now() - t0;
    expect(g.nodeCount).toBe(40000 + 800);
    expect(g.edgeCount).toBe(2 * 200 * 201);
    expect(dt).toBeLessThan(3000);
  });
});
