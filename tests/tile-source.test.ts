import { describe, expect, it } from 'vitest';
import type { Source } from 'pmtiles';
import { chooseSource, covers, probeTiles } from '../src/tile-source';

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
    const r = await chooseSource([dead, dead + '?2'], 500);
    expect(r).toMatchObject({ ok: false, index: 1, url: dead + '?2', bounds: null });
  });

  it('covers', () => {
    const b = { minLon: 13.08, minLat: 52.33, maxLon: 13.77, maxLat: 52.68 };
    expect(covers(b, 13.4, 52.5)).toBe(true);
    expect(covers(b, 2.35, 48.85)).toBe(false);
    expect(covers(null, 2.35, 48.85)).toBe(true);
  });
});
