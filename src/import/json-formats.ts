import { scanTopLevelArray } from './jsonscan';
import { addFeature, addGeometry, classifyHighway, classifyProps, type LineSink, type Progress } from './sink';

const SINGLE_LIMIT = 64 * 1024 * 1024;

/** Beginn der Datei als Text (zur Formaterkennung). */
export async function sniffText(blob: Blob, bytes = 65536): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await blob.slice(0, bytes).arrayBuffer()));
}

/** GeoJSON: FeatureCollection streamend, einzelne Feature/Geometrie bis 64 MB am Stück. */
export async function importGeoJson(blob: Blob, sink: LineSink, progress?: Progress, includeRings = false) {
  let n = 0;
  const found = await scanTopLevelArray(blob, 'features', (json) => {
    addFeature(sink, JSON.parse(json), includeRings);
    if (++n % 20000 === 0) progress?.(0, `${n.toLocaleString('de')} Objekte gelesen`);
  }, (f) => progress?.(f, 'GeoJSON wird gelesen'));
  if (found) return;
  if (blob.size > SINGLE_LIMIT) throw new Error('GeoJSON ohne "features"-Liste ist zu groß (> 64 MB).');
  const doc = JSON.parse(await blob.text());
  if (doc.type === 'Feature') addFeature(sink, doc, includeRings);
  else if (doc.type) addGeometry(sink, doc, classifyProps(null)!, includeRings);
  else throw new Error('Kein GeoJSON erkannt.');
}

interface OverpassEl {
  type: string; id: number; lat?: number; lon?: number;
  nodes?: number[]; tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** Overpass-JSON (out geom oder out body + Knoten). */
export async function importOverpass(blob: Blob, sink: LineSink, progress?: Progress) {
  const nodes = new Map<number, [number, number]>();
  const pending: { nodes: number[]; cls: number }[] = [];
  const found = await scanTopLevelArray(blob, 'elements', (json) => {
    const el = JSON.parse(json) as OverpassEl;
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) { nodes.set(el.id, [el.lon, el.lat]); return; }
    if (el.type !== 'way') return;
    const cls = classifyHighway(el.tags?.highway);
    if (cls === null || (el.tags && !('highway' in el.tags) && Object.keys(el.tags).length)) return;
    if (el.geometry) sink.addLine(el.geometry.map((g) => [g.lon, g.lat]), cls);
    else if (el.nodes) pending.push({ nodes: el.nodes, cls });
  }, (f) => progress?.(f, 'Overpass-JSON wird gelesen'));
  if (!found) throw new Error('Kein Overpass-JSON ("elements") erkannt.');
  for (const w of pending) {
    // an fehlenden Knoten teilen statt eine Sehne über die Lücke zu ziehen
    let line: [number, number][] = [];
    for (const id of w.nodes) {
      const p = nodes.get(id);
      if (p) line.push(p);
      else { sink.addLine(line, w.cls); line = []; }
    }
    sink.addLine(line, w.cls);
  }
}

/** Direkt aus bereits geparstem Overpass-Objekt (Online-Abfrage, kleine Mengen). */
export function overpassToSink(doc: { elements?: OverpassEl[] }, sink: LineSink) {
  for (const el of doc.elements ?? []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const cls = classifyHighway(el.tags?.highway);
    if (cls === null) continue;
    sink.addLine(el.geometry.map((g) => [g.lon, g.lat]), cls);
  }
}
