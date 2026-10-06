import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PbfWriter } from 'pbf';
import { geojson } from 'flatgeobuf';
import { importGeoJson, importOverpass } from '../src/import/json-formats';
import { importOsmPbf, looksLikeOsmPbf } from '../src/import/osm-pbf';
import { importFlatGeobuf } from '../src/import/flatgeobuf';
import { addTile } from '../src/import/vector-tiles';
import { LineSink, classifyHighway } from '../src/import/sink';
import { scanTopLevelArray } from '../src/import/jsonscan';
import { detectFormat } from '../src/import';
import { OverpassClient, buildQuery, parseOverpass, tilesFor, tilesToBatch } from '../src/overpass';

/** Blob, dessen stream() in winzigen Stücken liefert – prüft Chunk-Grenzen. */
function chunkedBlob(text: string, chunk: number): Blob {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.length,
    stream: () => new ReadableStream({
      start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); },
    }),
  } as unknown as Blob;
}

const fc = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { highway: 'residential', name: 'Straße "mit" {Klammern} [und] \\ Schrägstrich' }, geometry: { type: 'LineString', coordinates: [[13.4, 52.5], [13.401, 52.501]] } },
    { type: 'Feature', properties: { highway: 'motorway' }, geometry: { type: 'MultiLineString', coordinates: [[[13.4, 52.5], [13.41, 52.5]], [[13.41, 52.5], [13.42, 52.51]]] } },
    { type: 'Feature', properties: { highway: 'footway' }, geometry: { type: 'LineString', coordinates: [[13.5, 52.5], [13.5, 52.51]] } },
    { type: 'Feature', properties: { highway: 'construction' }, geometry: { type: 'LineString', coordinates: [[13.6, 52.5], [13.6, 52.51]] } },
    { type: 'Feature', properties: { building: 'yes' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  ],
};

describe('Streaming-Scanner / GeoJSON', () => {
  for (const chunk of [1, 3, 7, 64, 100000]) {
    it(`liest FeatureCollection in ${chunk}-Byte-Stücken`, async () => {
      const sink = new LineSink();
      await importGeoJson(chunkedBlob(JSON.stringify(fc, null, 1), chunk), sink);
      expect(sink.lineCount).toBe(4); // 1 + 2 + 1, construction und Gebäude übersprungen
      expect(Array.from(sink.cls)).toEqual([1, 0, 0, 2]);
    });
  }

  it('Ausschnittsfilter verwirft Linien außerhalb', async () => {
    const sink = new LineSink({ minLng: 13.39, minLat: 52.49, maxLng: 13.43, maxLat: 52.52 });
    await importGeoJson(chunkedBlob(JSON.stringify(fc), 50), sink);
    expect(sink.lineCount).toBe(3);
    expect(sink.skipped).toBe(1);
  });

  it('Polygonränder optional', async () => {
    const sink = new LineSink();
    await importGeoJson(chunkedBlob(JSON.stringify(fc), 50), sink, undefined, true);
    expect(sink.lineCount).toBe(5);
  });

  it('einzelnes Feature ohne features-Liste', async () => {
    const sink = new LineSink();
    await importGeoJson(new Blob([JSON.stringify(fc.features[0])]), sink);
    expect(sink.lineCount).toBe(1);
  });

  it('findet das Array auch nach anderen Schlüsseln und ignoriert gleichnamige Werte', async () => {
    const doc = { name: 'features', crs: { features: [1, 2] }, features: fc.features.slice(0, 2) };
    const found: string[] = [];
    const ok = await scanTopLevelArray(chunkedBlob(JSON.stringify(doc), 5), 'features', (j) => found.push(j));
    expect(ok).toBe(true);
    expect(found.length).toBe(2);
  });

  it('liefert false ohne Schlüssel', async () => {
    expect(await scanTopLevelArray(new Blob(['{"a":[1]}']), 'features', () => {})).toBe(false);
  });

  it('streamt 100.000 Features in ordentlicher Zeit', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 100000; i++) parts.push(`{"type":"Feature","properties":{"highway":"residential"},"geometry":{"type":"LineString","coordinates":[[13.${i % 1000},52.5],[13.${(i + 1) % 1000},52.51]]}}`);
    const blob = new Blob(['{"type":"FeatureCollection","features":[' + parts.join(',') + ']}']);
    const sink = new LineSink();
    const t0 = performance.now();
    await importGeoJson(blob, sink);
    expect(sink.lineCount).toBe(100000);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('Overpass', () => {
  it('liest out geom', async () => {
    const doc = { version: 0.6, elements: [
      { type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [{ lat: 52.5, lon: 13.4 }, { lat: 52.51, lon: 13.41 }] },
      { type: 'way', id: 2, tags: { highway: 'footway' }, geometry: [{ lat: 52.5, lon: 13.4 }, { lat: 52.5, lon: 13.41 }] },
      { type: 'way', id: 3, tags: { building: 'yes' }, geometry: [{ lat: 52.5, lon: 13.4 }, { lat: 52.5, lon: 13.41 }] },
    ] };
    const sink = new LineSink();
    await importOverpass(chunkedBlob(JSON.stringify(doc), 9), sink);
    expect(Array.from(sink.cls)).toEqual([0, 2]);
  });

  it('löst Wege über Knoten auf (Knoten nach den Wegen)', async () => {
    const doc = { elements: [
      { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'residential' } },
      { type: 'node', id: 1, lat: 52.5, lon: 13.4 }, { type: 'node', id: 2, lat: 52.5, lon: 13.401 }, { type: 'node', id: 3, lat: 52.501, lon: 13.401 },
    ] };
    const sink = new LineSink();
    await importOverpass(new Blob([JSON.stringify(doc)]), sink);
    expect(sink.lineCount).toBe(1);
    expect(sink.coords.n).toBe(6);
  });

  it('teilt Wege an fehlenden Knoten', async () => {
    const doc = { elements: [
      { type: 'way', id: 10, nodes: [1, 2, 3, 4, 5], tags: { highway: 'residential' } },
      { type: 'node', id: 1, lat: 52.5, lon: 13.4 }, { type: 'node', id: 2, lat: 52.5, lon: 13.401 },
      { type: 'node', id: 4, lat: 52.501, lon: 13.402 }, { type: 'node', id: 5, lat: 52.501, lon: 13.403 },
    ] };
    const sink = new LineSink();
    await importOverpass(new Blob([JSON.stringify(doc)]), sink);
    expect(sink.lineCount).toBe(2);
  });

  it('parseOverpass + tilesToBatch', () => {
    const t = parseOverpass({ elements: [{ type: 'way', tags: { highway: 'service' }, geometry: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }] });
    const b = tilesToBatch([t, t])!;
    expect(b.cls.length).toBe(2);
    expect(Array.from(b.offsets)).toEqual([0, 2, 4]);
  });

  it('Anfrage enthält Box und out geom', () => {
    const q = buildQuery({ s: 52.5, w: 13.4, n: 52.51, e: 13.41 });
    expect(q).toContain('(52.500000,13.400000,52.510000,13.410000)');
    expect(q).toContain('out geom');
  });

  it('tilesFor deckt Ausschnitt ab', () => {
    expect(tilesFor({ west: 13.40, south: 52.51, east: 13.401, north: 52.511 }).length).toBeGreaterThanOrEqual(1);
  });

  it('wartet bei 429 (Retry-After), cached und hält den Mindestabstand', async () => {
    let t = 0;
    const sleeps: number[] = [];
    let calls = 0;
    const ok = { elements: [{ type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: 52.5, lon: 13.4 }, { lat: 52.5, lon: 13.401 }] }] };
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return new Response('busy', { status: 429, headers: { 'Retry-After': '7' } });
      return new Response(JSON.stringify(ok), { status: 200 });
    }) as typeof fetch;
    const store = new Map<string, never>();
    const c = new OverpassClient({
      fetchFn, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, minGapMs: 2000,
      store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v as never); } },
    });
    const a = await c.tiles([[34000, 20000]]);
    expect(a.length).toBe(1);
    expect(sleeps).toContain(7000);
    expect(c.requests).toBe(2);
    const b = await c.tiles([[34000, 20000]]); // aus dem Cache
    expect(b.length).toBe(1);
    expect(c.requests).toBe(2);
    // zweites, neues Tile: Mindestabstand
    sleeps.length = 0;
    await c.tiles([[34001, 20000]]);
    expect(sleeps.some((s) => s > 0)).toBe(true);
  });

  it('fragt fehlgeschlagene Tiles nicht bei jeder Bewegung erneut ab', async () => {
    let t = 0, calls = 0;
    const c = new OverpassClient({
      fetchFn: (async () => { calls++; return new Response('bad', { status: 400 }); }) as typeof fetch,
      now: () => t, sleep: async (ms) => { t += ms; }, minGapMs: 0,
      store: { get: async () => undefined, set: async () => {} },
    });
    expect(await c.tiles([[1, 1]])).toEqual([]);
    expect(await c.tiles([[1, 1]])).toEqual([]);
    expect(calls).toBe(1);
    t += 11 * 60 * 1000; // nach der Sperrzeit wieder erlaubt
    await c.tiles([[1, 1]]);
    expect(calls).toBe(2);
  });
});

describe('OSM-PBF', () => {
  /** Minimal-PBF: 1 Block mit DenseNodes + 1 Way. */
  function makePbf(pts: number[][] = [[13.4, 52.5], [13.401, 52.5], [13.401, 52.501], [50, 50]], refs: number[] = [1, 2, 3]): Uint8Array {
    const strings = ['', 'highway', 'residential', 'name'];
    const block = new PbfWriter();
    block.writeMessage(1, (_o: null, w: PbfWriter) => { for (const s of strings) w.writeBytesField(1, new TextEncoder().encode(s)); }, null);
    const gran = 100;
    const toI = (deg: number) => Math.round(deg / 1e-9 / gran);
    block.writeMessage(2, (_o: null, g: PbfWriter) => {
      g.writeMessage(2, (_o2: null, d: PbfWriter) => {
        const ids: number[] = [], lats: number[] = [], lons: number[] = [];
        let pid = 0, pla = 0, plo = 0;
        pts.forEach((p, i) => {
          const id = i + 1, la = toI(p[1]), lo = toI(p[0]);
          ids.push(id - pid); lats.push(la - pla); lons.push(lo - plo); pid = id; pla = la; plo = lo;
        });
        d.writePackedSVarint(1, ids); d.writePackedSVarint(8, lats); d.writePackedSVarint(9, lons);
      }, null);
      g.writeMessage(3, (_o2: null, w: PbfWriter) => {
        w.writeVarintField(1, 100);
        w.writePackedVarint(2, [1]); w.writePackedVarint(3, [2]);
        w.writePackedSVarint(8, refs.map((r, i) => r - (i ? refs[i - 1] : 0))); // Referenzen (Delta)
      }, null);
      g.writeMessage(3, (_o2: null, w: PbfWriter) => { // Weg ohne highway
        w.writeVarintField(1, 101); w.writePackedVarint(2, [3]); w.writePackedVarint(3, [3]); w.writePackedSVarint(8, [1, 1]);
      }, null);
    }, null);
    const blockBytes = block.finish();
    const blob = new PbfWriter();
    blob.writeVarintField(2, blockBytes.length);
    blob.writeBytesField(3, deflateSync(blockBytes));
    const blobBytes = blob.finish();
    const hdr = new PbfWriter();
    hdr.writeStringField(1, 'OSMData'); hdr.writeVarintField(3, blobBytes.length);
    const hdrBytes = hdr.finish();
    // Header-Block (OSMHeader) vorneweg
    const hh = new PbfWriter(); hh.writeStringField(1, 'OSMHeader'); hh.writeVarintField(3, 0);
    const hhBytes = hh.finish();
    const out: number[] = [];
    const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...be(hhBytes.length), ...hhBytes);
    out.push(...be(hdrBytes.length), ...hdrBytes, ...blobBytes);
    return Uint8Array.from(out);
  }

  it('erkennt das Format und liest Wege mit Knoten-Auflösung', async () => {
    const blob = new Blob([makePbf() as BlobPart]);
    expect(await looksLikeOsmPbf(blob)).toBe(true);
    const sink = new LineSink();
    await importOsmPbf(blob, sink, () => {});
    expect(sink.lineCount).toBe(1);
    expect(sink.coords.n).toBe(6);
    expect(sink.coords.a[0]).toBeCloseTo(13.4, 6);
    expect(sink.coords.a[1]).toBeCloseTo(52.5, 6);
  });

  it('Ausschnitt filtert Knoten (Weg verliert Punkte)', async () => {
    const sink = new LineSink({ minLng: 13.3, minLat: 52.4, maxLng: 13.4005, maxLat: 52.6 });
    await importOsmPbf(new Blob([makePbf() as BlobPart]), sink, () => {}, { minLng: 13.3, minLat: 52.4, maxLng: 13.4005, maxLat: 52.6 });
    expect(sink.lineCount).toBe(0); // nur 1 Knoten im Ausschnitt -> keine Linie
  });

  it('teilt Wege an Knoten außerhalb des Ausschnitts statt eine Sehne zu ziehen', async () => {
    // Weg 1-2-3-4-5, Knoten 3 liegt außerhalb -> zwei Linien (1-2 und 4-5), keine Verbindung 2-4
    const pts = [[13.40, 52.50], [13.41, 52.50], [13.45, 52.60], [13.42, 52.50], [13.43, 52.50]];
    const bbox = { minLng: 13.3, minLat: 52.4, maxLng: 13.44, maxLat: 52.55 };
    const sink = new LineSink(bbox);
    await importOsmPbf(new Blob([makePbf(pts, [1, 2, 3, 4, 5]) as BlobPart]), sink, () => {}, bbox);
    expect(sink.lineCount).toBe(2);
    expect(Array.from(sink.offsets.a.subarray(0, 2))).toEqual([0, 2]);
  });
});

describe('FlatGeobuf', () => {
  it('liest serialisierte Daten streamend', async () => {
    const bytes = geojson.serialize(fc as never);
    const sink = new LineSink();
    await importFlatGeobuf(new Blob([bytes as BlobPart]), sink, () => {});
    expect(sink.lineCount).toBeGreaterThanOrEqual(3);
  });
});

describe('MVT', () => {
  /** Minimal-Kachel: Layer "roads" mit einer Linie, kind=major_road. */
  function tile(): Uint8Array {
    const w = new PbfWriter();
    w.writeMessage(3, (_o: null, l: PbfWriter) => {
      l.writeVarintField(15, 2); l.writeStringField(1, 'roads');
      l.writeStringField(3, 'kind'); l.writeMessage(4, (_v: null, v: PbfWriter) => v.writeStringField(1, 'major_road'), null);
      l.writeVarintField(5, 4096);
      l.writeMessage(2, (_f: null, f: PbfWriter) => {
        f.writePackedVarint(2, [0, 0]); f.writeVarintField(3, 2);
        const zz = (n: number) => (n << 1) ^ (n >> 31);
        f.writePackedVarint(4, [(1 << 3) | 1, zz(100), zz(100), (2 << 3) | 2, zz(2000), zz(0)]);
      }, null);
    }, null);
    return w.finish();
  }
  it('liest Straßen-Layer und klassifiziert kind', () => {
    const sink = new LineSink();
    expect(addTile(tile(), 14, 8800, 5400, sink)).toBe(1);
    expect(sink.cls).toEqual([0]);
    expect(sink.coords.n).toBe(4);
  });
});

describe('Klassifikation / Formaterkennung', () => {
  it('classifyHighway', () => {
    expect(classifyHighway('trunk')).toBe(0);
    expect(classifyHighway('residential')).toBe(1);
    expect(classifyHighway('cycleway')).toBe(2);
    expect(classifyHighway('construction')).toBeNull();
  });
  it('detectFormat', async () => {
    expect(await detectFormat(new File(['{"type":"FeatureCollection","features":[]}'], 'a.geojson'))).toBe('geojson');
    expect(await detectFormat(new File(['{"elements":[]}'], 'o.json'))).toBe('overpass');
    expect(await detectFormat(new File(['%PDF-1.7'], 'k.pdf'))).toBe('pdf');
    expect(await detectFormat(new File([new Uint8Array([1, 2, 3])], 'x.bin'))).toBeNull();
  });
});
