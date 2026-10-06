import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { FileSource, PMTiles } from 'pmtiles';
import { addGeometry, classifyProps, type BBox, type LineSink, type Progress } from './sink';

const ROAD_LAYERS = ['roads', 'transportation', 'road', 'highway', 'streets', 'transport'];

function lngToTileX(lng: number, z: number) { return Math.floor(((lng + 180) / 360) * 2 ** z); }
function latToTileY(lat: number, z: number) {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
}

/** Straßen-Layer einer Kachel in den Sink. Gibt Anzahl gelesener Features zurück. */
export function addTile(data: Uint8Array, z: number, x: number, y: number, sink: LineSink, layerName?: string): number {
  const vt = new VectorTile(new PbfReader(data));
  const names = Object.keys(vt.layers);
  const pick = layerName && vt.layers[layerName] ? layerName : ROAD_LAYERS.find((n) => vt.layers[n]);
  if (!pick) return 0;
  const layer = vt.layers[pick];
  let n = 0;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue; // nur Linien
    const cls = classifyProps(f.properties as Record<string, unknown>);
    if (cls === null) continue;
    const g = f.toGeoJSON(x, y, z).geometry;
    addGeometry(sink, g as never, cls);
    n++;
  }
  void names;
  return n;
}

export interface PmtilesImportOptions { bbox?: BBox; zoom?: number; maxTiles?: number }

/** Lokale .pmtiles-Datei lesen: Kacheln im Ausschnitt per Range-Reads, nichts wird komplett geladen. */
export async function importPmtiles(file: File, sink: LineSink, progress: Progress, o: PmtilesImportOptions = {}) {
  const pm = new PMTiles(new FileSource(file));
  const h = await pm.getHeader();
  const bbox: BBox = o.bbox ?? { minLng: h.minLon, minLat: h.minLat, maxLng: h.maxLon, maxLat: h.maxLat };
  let z = Math.min(o.zoom ?? 14, h.maxZoom);
  const maxTiles = o.maxTiles ?? 4000;
  const range = (zz: number) => {
    const x0 = lngToTileX(bbox.minLng, zz), x1 = lngToTileX(bbox.maxLng, zz);
    const y0 = latToTileY(bbox.maxLat, zz), y1 = latToTileY(bbox.minLat, zz);
    return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  while (z > h.minZoom && range(z).count > maxTiles) z--;
  const r = range(z);
  progress(0, `PMTiles: Zoom ${z}, ${r.count} Kacheln`);
  let done = 0, features = 0;
  const jobs: [number, number][] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) jobs.push([x, y]);
  const conc = 6;
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) {
      const k = next++;
      if (k >= jobs.length) return;
      const [x, y] = jobs[k];
      const t = await pm.getZxy(z, x, y);
      if (t) features += addTile(new Uint8Array(t.data), z, x, y, sink);
      if (++done % 8 === 0 || done === jobs.length) progress(done / jobs.length, `Kacheln ${done}/${jobs.length}`);
    }
  }));
  if (!features) throw new Error('Keine Straßen-Layer in den Kacheln gefunden (erwartet: roads/transportation).');
}

/** Einzelne MVT-Kachel; z/x/y aus dem Dateinamen (z-x-y, z_x_y, z/x/y). */
export function parseTileName(name: string): [number, number, number] | null {
  const m = name.match(/(\d{1,2})[-_/.](\d+)[-_/.](\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export async function importMvt(file: File, sink: LineSink, zxy: [number, number, number]) {
  const data = new Uint8Array(await file.arrayBuffer());
  const n = addTile(data, zxy[0], zxy[1], zxy[2], sink);
  if (!n) throw new Error('Keine Straßen-Layer in der Kachel gefunden.');
}
