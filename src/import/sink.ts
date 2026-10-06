import { CLASS_MAIN, CLASS_PATH, CLASS_STREET } from '../core/graph';
import { GrowF64, GrowU32 } from '../core/grow';
import type { LineBatch } from '../core/types';

export interface BBox { minLng: number; minLat: number; maxLng: number; maxLat: number }
export type Progress = (fraction: number, text?: string) => void;

/** Sammelt Linien (lng/lat) als flache Puffer; filtert optional nach Ausschnitt. */
export class LineSink {
  readonly coords = new GrowF64(1 << 16);
  readonly offsets = new GrowU32(1 << 12);
  readonly cls: number[] = [];
  skipped = 0;
  constructor(readonly bbox?: BBox) {}

  get lineCount() { return this.cls.length; }

  /** line: [[lng,lat], …] */
  addLine(line: ArrayLike<ArrayLike<number>>, cls: number) {
    if (line.length < 2) return;
    if (this.bbox) {
      const b = this.bbox;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < line.length; i++) {
        const x = line[i][0], y = line[i][1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (maxX < b.minLng || minX > b.maxLng || maxY < b.minLat || minY > b.maxLat) { this.skipped++; return; }
    }
    this.offsets.push(this.coords.n / 2);
    for (let i = 0; i < line.length; i++) { this.coords.push(line[i][0]); this.coords.push(line[i][1]); }
    this.cls.push(cls);
  }

  /** Flaches xy-Array (lng,lat,lng,lat …). */
  addFlat(xy: ArrayLike<number>, cls: number) {
    const n = xy.length / 2;
    const line: number[][] = new Array(n);
    for (let i = 0; i < n; i++) line[i] = [xy[2 * i], xy[2 * i + 1]];
    this.addLine(line, cls);
  }

  toBatch(): LineBatch {
    this.offsets.push(this.coords.n / 2);
    const batch: LineBatch = {
      coords: this.coords.toArray(), offsets: this.offsets.toArray(), cls: Uint8Array.from(this.cls), kind: 'lnglat',
    };
    this.offsets.n--; // wiederholbar
    return batch;
  }
}

const MAIN = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'highway', 'major_road']);
const PATH = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'track', 'steps', 'bridleway', 'corridor', 'bridge', 'pier', 'trail']);
const SKIP = new Set(['proposed', 'construction', 'razed', 'abandoned', 'platform', 'rail', 'ferry', 'raceway']);

/** highway=*, kind=*, class=* … → Klasse; null = überspringen. */
export function classifyHighway(v: unknown): number | null {
  if (typeof v !== 'string') return CLASS_STREET;
  if (SKIP.has(v)) return null;
  if (MAIN.has(v)) return CLASS_MAIN;
  if (PATH.has(v)) return CLASS_PATH;
  return CLASS_STREET;
}

export function classifyProps(p: Record<string, unknown> | null | undefined): number | null {
  if (!p) return CLASS_STREET;
  for (const k of ['highway', 'kind', 'class', 'fclass', 'type']) {
    if (typeof p[k] === 'string') {
      // Protomaps/OpenMapTiles-Werte nur aus "kind"/"class", "type" ist oft Geometrietyp
      if (k === 'type' && !PATH.has(p[k] as string) && !MAIN.has(p[k] as string)) continue;
      return classifyHighway(p[k]);
    }
  }
  return CLASS_STREET;
}

/** GeoJSON-Geometrie → Linien in den Sink. Polygone nur mit includeRings. */
export function addGeometry(sink: LineSink, g: { type: string; coordinates?: unknown; geometries?: unknown[] } | null | undefined, cls: number, includeRings = false) {
  if (!g) return;
  switch (g.type) {
    case 'LineString': sink.addLine(g.coordinates as number[][], cls); break;
    case 'MultiLineString': for (const l of g.coordinates as number[][][]) sink.addLine(l, cls); break;
    case 'Polygon': if (includeRings) for (const r of g.coordinates as number[][][]) sink.addLine(r, cls); break;
    case 'MultiPolygon': if (includeRings) for (const p of g.coordinates as number[][][][]) for (const r of p) sink.addLine(r, cls); break;
    case 'GeometryCollection': for (const sub of g.geometries ?? []) addGeometry(sink, sub as never, cls, includeRings); break;
  }
}

export function addFeature(sink: LineSink, f: { geometry?: never; properties?: Record<string, unknown> | null } & Record<string, unknown>, includeRings = false) {
  const cls = classifyProps(f.properties);
  if (cls === null) return;
  addGeometry(sink, f.geometry as never, cls, includeRings);
}
