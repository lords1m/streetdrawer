import { describe, expect, it } from 'vitest';
import type { Source } from 'pmtiles';
import { chooseSource, covers, probeTileJson, probeTiles } from '../src/tile-source';
import { makeStyle, omtClassToClass, roadClass, roadLayerIds, roadLevel, sourceFor } from '../src/map-style';
import { CLASS_MAIN, CLASS_PATH, CLASS_STREET } from '../src/core/graph';

/** Minimale PMTiles-v3-Datei: Header + leeres, unkomprimiertes Wurzelverzeichnis. */
function pmtilesHeader(b: [number, number, number, number]): ArrayBuffer {
  const buf = new ArrayBuffer(128);
  const v = new DataView(buf);
  new Uint8Array(buf).set([...'PMTiles'].map((c) => c.charCodeAt(0)));
  v.setUint8(7, 3);
  v.setBigUint64(8, 127n, true); v.setBigUint64(16, 1n, true);   // Wurzelverzeichnis: 1 Byte (0 Einträge)
  v.setBigUint64(24, 128n, true); v.setBigUint64(56, 128n, true);
  v.setUint8(97, 1); v.setUint8(98, 1); v.setUint8(99, 1);         // unkomprimiert, MVT
  v.setUint8(101, 15);
  b.forEach((x, i) => v.setInt32(102 + i * 4, Math.round(x * 1e7), true));
  return buf;
}

const source = (key: string, data: () => Promise<ArrayBuffer>): Source => ({
  getKey: () => key,
  getBytes: async (offset, length) => ({ data: (await data()).slice(offset, offset + length) }),
});

describe('Kartenquelle', () => {
  it('liest die Grenzen aus dem Header', async () => {
    const r = await probeTiles(source('a', async () => pmtilesHeader([13.08, 52.33, 13.77, 52.68])), 1000);
    expect(r.ok).toBe(true);
    expect(r.bounds?.minLon).toBeCloseTo(13.08, 6);
    expect(r.bounds?.maxLat).toBeCloseTo(52.68, 6);
  });

  it('Grenzen 0 = unbekannt', async () => {
    const r = await probeTiles(source('b', async () => pmtilesHeader([0, 0, 0, 0])), 1000);
    expect(r).toEqual({ ok: true, bounds: null });
  });

  it('Netzfehler und Zeitüberschreitung → nicht erreichbar', async () => {
    const fail = await probeTiles(source('c', async () => { throw new Error('Failed to fetch'); }), 1000);
    expect(fail.ok).toBe(false);
    const hang = await probeTiles(source('d', () => new Promise(() => {})), 20);
    expect(hang).toMatchObject({ ok: false, error: 'Zeitüberschreitung' });
  });

  it('chooseSource nimmt die erste erreichbare, sonst die letzte', async () => {
    // URLs, die sofort scheitern (kein Server auf Port 9)
    const dead = 'http://127.0.0.1:9/x.pmtiles';
    const r = await chooseSource([sourceFor(dead), sourceFor(dead + '?2')], 500);
    expect(r).toMatchObject({ ok: false, index: 1, source: { url: dead + '?2' }, bounds: null });
  });

  it('covers', () => {
    const b = { minLon: 13.08, minLat: 52.33, maxLon: 13.77, maxLat: 52.68 };
    expect(covers(b, 13.4, 52.5)).toBe(true);
    expect(covers(b, 2.35, 48.85)).toBe(false);
    expect(covers(null, 2.35, 48.85)).toBe(true);
  });
});

describe('TileJSON (OpenFreeMap)', () => {
  const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  it('gültiges TileJSON mit Weltgrenzen', async () => {
    const r = await probeTileJson('https://x/planet', 1000, json({ tiles: ['https://x/{z}/{x}/{y}.pbf'], bounds: [-180, -85.0511, 180, 85.0511] }));
    expect(r).toEqual({ ok: true, bounds: { minLon: -180, minLat: -85.0511, maxLon: 180, maxLat: 85.0511 } });
  });
  it('ohne tiles, HTTP-Fehler, Netzfehler, Zeitüberschreitung → nicht erreichbar', async () => {
    expect((await probeTileJson('u', 1000, json({ name: 'x' }))).ok).toBe(false);
    expect(await probeTileJson('u', 1000, json({}, 503))).toMatchObject({ ok: false, error: 'HTTP 503' });
    expect((await probeTileJson('u', 1000, async () => { throw new TypeError('Failed to fetch'); })).ok).toBe(false);
    const hang = (_: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
    expect(await probeTileJson('u', 20, hang as typeof fetch)).toMatchObject({ ok: false, error: 'Zeitüberschreitung' });
  });
});

describe('Kachelschemata', () => {
  it('sourceFor: .pmtiles → Protomaps, sonst TileJSON/OpenMapTiles', () => {
    expect(sourceFor('https://a/berlin.pmtiles?v=2')).toEqual({ kind: 'pmtiles', url: 'https://a/berlin.pmtiles?v=2', schema: 'protomaps' });
    expect(sourceFor('https://tiles.openfreemap.org/planet')).toMatchObject({ kind: 'tilejson', schema: 'openmaptiles' });
  });

  it('OpenMapTiles: Klassen und Ebenen', () => {
    expect(omtClassToClass('motorway')).toBe(CLASS_MAIN);
    expect(omtClassToClass('secondary')).toBe(CLASS_MAIN);
    expect(omtClassToClass('tertiary')).toBe(CLASS_STREET);
    expect(omtClassToClass('minor')).toBe(CLASS_STREET);
    expect(omtClassToClass('service')).toBe(CLASS_STREET);
    expect(omtClassToClass('path')).toBe(CLASS_PATH);
    expect(omtClassToClass('track')).toBe(CLASS_PATH);
    expect(omtClassToClass('rail')).toBeNull();
    expect(omtClassToClass('ferry')).toBeNull();
    expect(roadClass('openmaptiles', { class: 'primary' })).toBe(CLASS_MAIN);
    expect(roadClass('protomaps', { kind: 'path' })).toBe(CLASS_PATH);
    expect(roadLevel('openmaptiles', { brunnel: 'bridge' })).toBe(1);
    expect(roadLevel('openmaptiles', { brunnel: 'tunnel' })).toBe(-1);
    expect(roadLevel('protomaps', { is_tunnel: true })).toBe(-1);
  });

  it('OpenMapTiles-Stil: Straßen-Layer fürs Netz, keine Gleise/Ränder, Beschriftung abschaltbar', () => {
    const src = sourceFor('https://tiles.openfreemap.org/planet');
    for (const theme of ['light', 'dark'] as const) {
      const st = makeStyle(theme, src, true);
      expect(roadLayerIds(st).sort()).toEqual(['roads_highway', 'roads_major', 'roads_minor', 'roads_path']);
      expect(st.glyphs).toContain('openfreemap');
      expect((st.sources.protomaps as { url: string }).url).toBe('https://tiles.openfreemap.org/planet');
    }
    const plain = makeStyle('light', src, false);
    expect(plain.layers.some((l) => l.type === 'symbol')).toBe(false);
    expect(plain.glyphs).toBeUndefined();
  });

  it('Protomaps-Stil unverändert über pmtiles://', () => {
    const st = makeStyle('light', sourceFor('https://a/berlin.pmtiles'), true);
    expect((st.sources.protomaps as { url: string }).url).toBe('pmtiles://https://a/berlin.pmtiles');
    expect(roadLayerIds(st).length).toBeGreaterThan(3);
  });
});
