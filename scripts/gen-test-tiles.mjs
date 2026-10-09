// Erzeugt eine synthetische PMTiles-Datei (Protomaps-Schema, nur Layer `roads`) mit einem Straßenraster über Berlin.
// Für E2E-Tests ohne Netzzugang: Die echte berlin.pmtiles kommt aus dem Protomaps-Build, der nicht immer erreichbar ist.
// Start: node scripts/gen-test-tiles.mjs [Ziel] [minLon,minLat,maxLon,maxLat]
// Jede Kachel einer Zoomstufe hat denselben Inhalt (Raster in Kachelkoordinaten), deshalb bleibt die Datei klein.
// Als Modul liefert testTile(z, schema) einzelne Kacheln, auch im OpenMapTiles-Schema (E2E: OpenFreeMap-Attrappe).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PbfWriter } from 'pbf';
import { zxyToTileId } from 'pmtiles';

const MINZOOM = 12, MAXZOOM = 15, EXTENT = 4096;

// ---------------------------------------------------------------- Kachelinhalt (MVT)
/** Linien je Zoomstufe: Raster aus Haupt- und Nebenstraßen plus Diagonale und Weg, in z15-Kacheln gemessen. */
function roadsFor(z) {
  const s = 2 ** (MAXZOOM - z); // z15-Kacheln je Kachelkante
  const u = EXTENT / s;
  const lines = [];
  for (let i = 0; i < s; i++) {
    for (let j = 0; j < 4; j++) {
      const v = Math.round(i * u + ((j * 1024 + 512) * u) / EXTENT);
      const kind = j === 2 ? 'major_road' : 'minor_road';
      lines.push({ kind, pts: [[0, v], [EXTENT, v]] });
      lines.push({ kind, pts: [[v, 0], [v, EXTENT]] });
    }
    // Diagonale: läuft über die Kachelecken hinweg durch
    lines.push({ kind: 'minor_road', pts: [[Math.round(i * u), 0], [EXTENT, Math.round(EXTENT - i * u)]] });
    if (i) lines.push({ kind: 'minor_road', pts: [[0, Math.round(i * u)], [Math.round(EXTENT - i * u), EXTENT]] });
    // Weg mit Knick in jeder z15-Zelle
    for (let k = 0; k < s; k++) {
      const x0 = i * u, y0 = k * u;
      lines.push({ kind: 'path', pts: [[x0 + u * 0.125, y0 + u * 0.25], [x0 + u * 0.2, y0 + u * 0.45], [x0 + u * 0.375, y0 + u * 0.375]].map(([x, y]) => [Math.round(x), Math.round(y)]) });
    }
  }
  // Stützpunkte alle 128 Einheiten wie bei echten Straßen (Tests suchen Linien mit mehreren Punkten im Bild)
  for (const l of lines) {
    const pts = [l.pts[0]];
    for (let i = 1; i < l.pts.length; i++) {
      const [x0, y0] = l.pts[i - 1], [x1, y1] = l.pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 128));
      for (let k = 1; k <= n; k++) pts.push([Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n)]);
    }
    l.pts = pts;
  }
  return lines;
}

const zigzag = (n) => (n << 1) ^ (n >> 31);

/** Schemata: Layer- und Attributname, Abbildung der Protomaps-Arten. */
const SCHEMAS = {
  protomaps: { layer: 'roads', key: 'kind', value: (k) => k },
  openmaptiles: { layer: 'transportation', key: 'class', value: (k) => ({ major_road: 'primary', minor_road: 'minor', path: 'path' })[k] },
};

function encodeTile(lines, schema = 'protomaps') {
  const sc = SCHEMAS[schema];
  lines = lines.map((l) => ({ ...l, kind: sc.value(l.kind) }));
  const kinds = [...new Set(lines.map((l) => l.kind))];
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_, w) => {
    w.writeVarintField(15, 2);
    w.writeStringField(1, sc.layer);
    lines.forEach((l, id) => {
      w.writeMessage(2, (__, f) => {
        f.writeVarintField(1, id + 1);
        f.writePackedVarint(2, [0, kinds.indexOf(l.kind)]);
        f.writeVarintField(3, 2); // LineString
        const g = [(1 & 7) | (1 << 3)];
        let cx = 0, cy = 0;
        l.pts.forEach(([x, y], i) => {
          if (i === 1) g.push((2 & 7) | ((l.pts.length - 1) << 3));
          g.push(zigzag(x - cx), zigzag(y - cy));
          cx = x; cy = y;
        });
        f.writePackedVarint(4, g);
      });
    });
    w.writeStringField(3, sc.key);
    for (const k of kinds) w.writeMessage(4, (___, v) => v.writeStringField(1, k));
    w.writeVarintField(5, EXTENT);
  });
  return Buffer.from(pbf.finish());
}

/** Unkomprimierte MVT-Kachel der Zoomstufe z (alle Kacheln einer Stufe sind gleich), null außerhalb z12–15. */
export function testTile(z, schema = 'protomaps') {
  return z >= MINZOOM && z <= MAXZOOM ? encodeTile(roadsFor(z), schema) : null;
}

// ---------------------------------------------------------------- PMTiles-Datei schreiben (Aufruf als Skript)
function writePmtiles(out, [minLon, minLat, maxLon, maxLat]) {
  // ---------------------------------------------------------------- Kacheln im Ausschnitt
  const tx = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
  const ty = (lat, z) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
  };

  const blobs = [];
  const entries = [];
  let offset = 0;
  for (let z = MINZOOM; z <= MAXZOOM; z++) {
    const data = gzipSync(encodeTile(roadsFor(z)));
    const at = offset;
    blobs.push(data); offset += data.length;
    for (let x = tx(minLon, z); x <= tx(maxLon, z); x++) {
      for (let y = ty(maxLat, z); y <= ty(minLat, z); y++) entries.push({ id: zxyToTileId(z, x, y), offset: at, length: data.length });
    }
  }
  entries.sort((a, b) => a.id - b.id);
  // gleiche Inhalte an aufeinanderfolgenden IDs zu Läufen zusammenfassen
  const runs = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && last.offset === e.offset && last.id + last.run === e.id) last.run++;
    else runs.push({ ...e, run: 1 });
  }

  // ---------------------------------------------------------------- PMTiles v3
  function varints(nums) {
    const b = [];
    for (let n of nums) {
      while (n >= 0x80) { b.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
      b.push(n);
    }
    return b;
  }
  function serializeDir(rs) {
    const nums = [rs.length];
    let last = 0;
    for (const r of rs) { nums.push(r.id - last); last = r.id; }
    for (const r of rs) nums.push(r.run);
    for (const r of rs) nums.push(r.length);
    for (const r of rs) nums.push(r.offset + 1);
    return gzipSync(Buffer.from(varints(nums)));
  }

  const root = serializeDir(runs);
  if (root.length > 16384 - 127) throw new Error(`Wurzelverzeichnis zu groß (${root.length} Bytes) – Ausschnitt verkleinern`);
  const meta = gzipSync(Buffer.from(JSON.stringify({
    name: 'Synthetisches Testraster', description: 'Nur für Tests – keine echten Straßen',
    vector_layers: [{ id: 'roads', fields: { kind: 'String' }, minzoom: MINZOOM, maxzoom: MAXZOOM }],
  })));
  const tiles = Buffer.concat(blobs);

  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'ascii'); h.writeUInt8(3, 7);
  const u64 = (v, at) => h.writeBigUInt64LE(BigInt(v), at);
  const rootOff = 127, metaOff = rootOff + root.length, dataOff = metaOff + meta.length;
  u64(rootOff, 8); u64(root.length, 16);
  u64(metaOff, 24); u64(meta.length, 32);
  u64(dataOff, 40); u64(0, 48); // keine Blattverzeichnisse
  u64(dataOff, 56); u64(tiles.length, 64);
  u64(entries.length, 72); u64(runs.length, 80); u64(blobs.length, 88);
  h.writeUInt8(1, 96);            // geclustert
  h.writeUInt8(2, 97);            // Verzeichnisse gzip
  h.writeUInt8(2, 98);            // Kacheln gzip
  h.writeUInt8(1, 99);            // MVT
  h.writeUInt8(MINZOOM, 100); h.writeUInt8(MAXZOOM, 101);
  const e7 = (v, at) => h.writeInt32LE(Math.round(v * 1e7), at);
  e7(minLon, 102); e7(minLat, 106); e7(maxLon, 110); e7(maxLat, 114);
  h.writeUInt8(MAXZOOM - 1, 118); e7((minLon + maxLon) / 2, 119); e7((minLat + maxLat) / 2, 123);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([h, root, meta, tiles]));
  return `${out}: ${entries.length} Kacheln (z${MINZOOM}–${MAXZOOM}), ${runs.length} Verzeichniseinträge, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[2] || '.tmp/test.pmtiles';
  const bbox = (process.argv[3] || '13.08,52.33,13.77,52.68').split(',').map(Number);
  console.log(writePmtiles(out, bbox));
}
