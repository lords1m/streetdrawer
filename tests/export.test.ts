import { describe, expect, it } from 'vitest';
import { clipPolyline, layoutExport, strokesBounds, toSvg } from '../src/export';
import type { Stroke } from '../src/core/types';

const stroke = (id: number, ...parts: number[][]): Stroke => ({ id, color: '#e8590c', width: 6, parts: parts.map((p) => Float64Array.from(p)) });
const VIEW: [number, number, number, number] = [13.39, 52.51, 13.41, 52.53];
const opts = { width: 1000, background: 'transparent', zoom: 15, view: VIEW };

describe('Export im Kartenausschnitt', () => {
  it('Bildgröße folgt dem Ausschnitt, längere Seite = Breite', () => {
    const l = layoutExport([stroke(1, [13.395, 52.52, 13.405, 52.52])], opts)!;
    expect(Math.max(l.w, l.h)).toBe(1000);
    // 0,02° Länge vs. 0,02° Breite bei 52,5° N: in Mercator ist die Breite ca. 1/cos(52,5°) ≈ 1,64× höher
    expect(l.h / l.w).toBeCloseTo(1.64, 1);
  });

  it('Strich halb außerhalb wird am Rand geschnitten', () => {
    const l = layoutExport([stroke(1, [13.40, 52.52, 13.45, 52.52])], opts)!;
    const [p] = l.strokes[0].paths;
    expect(p[0]).toBeCloseTo(l.w / 2, 0);
    // endet am (um die halbe Strichstärke erweiterten) rechten Rand, nicht weit außerhalb
    expect(p[p.length - 2]).toBeGreaterThan(l.w);
    expect(p[p.length - 2]).toBeLessThan(l.w + l.strokes[0].width);
  });

  it('Striche ganz außerhalb fehlen; nichts im Ausschnitt → null', () => {
    const inside = stroke(1, [13.395, 52.52, 13.405, 52.52]);
    const paris = stroke(2, [2.35, 48.85, 2.36, 48.86]);
    expect(layoutExport([inside, paris], opts)!.strokes).toHaveLength(1);
    expect(layoutExport([paris], opts)).toBeNull();
    expect(layoutExport([], opts)).toBeNull();
  });

  it('SVG enthält nur die sichtbaren Teile', () => {
    const svg = toSvg(layoutExport([stroke(1, [13.395, 52.52, 13.405, 52.52]), stroke(2, [2.35, 48.85, 2.36, 48.86])], opts)!, '#fff');
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain('fill="#fff"');
  });
});

describe('clipPolyline', () => {
  const rect = [0, 0, 10, 10] as const;
  it('ganz innen bleibt unverändert', () => {
    expect(clipPolyline(Float64Array.from([1, 1, 5, 5, 9, 1]), ...rect).map((p) => [...p])).toEqual([[1, 1, 5, 5, 9, 1]]);
  });
  it('raus und wieder rein ergibt zwei Stücke', () => {
    const r = clipPolyline(Float64Array.from([5, 5, 15, 5, 15, 8, 5, 8]), ...rect).map((p) => [...p]);
    expect(r).toEqual([[5, 5, 10, 5], [10, 8, 5, 8]]);
  });
  it('quer durch ohne Stützpunkt innen', () => {
    expect(clipPolyline(Float64Array.from([-5, 5, 15, 5]), ...rect).map((p) => [...p])).toEqual([[0, 5, 10, 5]]);
  });
  it('ganz außen ergibt nichts', () => {
    expect(clipPolyline(Float64Array.from([-5, -5, -1, -1]), ...rect)).toEqual([]);
  });
});

describe('strokesBounds', () => {
  it('umfasst alle Striche an allen Orten', () => {
    expect(strokesBounds([stroke(1, [13.4, 52.5, 13.5, 52.6]), stroke(2, [2.3, 48.8, 2.4, 48.9])])).toEqual([2.3, 48.8, 13.5, 52.6]);
    expect(strokesBounds([])).toBeNull();
  });
});
