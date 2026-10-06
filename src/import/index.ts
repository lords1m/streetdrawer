import type { LineBatch } from '../core/types';
import { importFlatGeobuf } from './flatgeobuf';
import { importGeoJson, importOverpass, sniffText } from './json-formats';
import { importOsmPbf, looksLikeOsmPbf } from './osm-pbf';
import { LineSink, type BBox, type Progress } from './sink';
import { importMvt, importPmtiles, parseTileName } from './vector-tiles';

export type ImportFormat = 'geojson' | 'overpass' | 'pmtiles' | 'mvt' | 'osm-pbf' | 'fgb' | 'pdf';

export const FORMAT_LABEL: Record<ImportFormat, string> = {
  geojson: 'GeoJSON', overpass: 'Overpass-JSON', pmtiles: 'PMTiles', mvt: 'MVT-Kachel', 'osm-pbf': 'OSM-PBF', fgb: 'FlatGeobuf', pdf: 'PDF',
};

export async function detectFormat(file: File): Promise<ImportFormat | null> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = new TextDecoder('latin1').decode(head);
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (name.endsWith('.pmtiles') || ascii.startsWith('PMTiles')) return 'pmtiles';
  if (name.endsWith('.fgb') || (head[0] === 0x66 && head[1] === 0x67 && head[2] === 0x62)) return 'fgb';
  if (name.endsWith('.pbf') || name.endsWith('.osm.pbf')) return (await looksLikeOsmPbf(file)) ? 'osm-pbf' : 'mvt';
  if (name.endsWith('.mvt')) return 'mvt';
  if (name.endsWith('.json') || name.endsWith('.geojson') || ascii.trimStart().startsWith('{')) {
    const text = await sniffText(file);
    if (text.includes('"elements"') && !text.includes('"features"')) return 'overpass';
    return 'geojson';
  }
  return null;
}

export interface ImportOptions {
  format: ImportFormat;
  /** Nur diesen Ausschnitt lesen (empfohlen bei großen Dateien). */
  bbox?: BBox;
  /** PMTiles: gewünschter Zoom. */
  zoom?: number;
  /** Polygonränder als Linien (GeoJSON). */
  includeRings?: boolean;
  /** MVT-Einzelkachel. */
  zxy?: [number, number, number];
}

export interface ImportResult { batch: LineBatch; skipped: number; lines: number }

export async function importFile(file: File, o: ImportOptions, progress: Progress): Promise<ImportResult> {
  const sink = new LineSink(o.bbox);
  switch (o.format) {
    case 'geojson': await importGeoJson(file, sink, progress, o.includeRings); break;
    case 'overpass': await importOverpass(file, sink, progress); break;
    case 'pmtiles': await importPmtiles(file, sink, progress, { bbox: o.bbox, zoom: o.zoom }); break;
    case 'mvt': {
      const zxy = o.zxy ?? parseTileName(file.name);
      if (!zxy) throw new Error('Für MVT-Kacheln wird z/x/y benötigt (Dateiname z-x-y.mvt).');
      await importMvt(file, sink, zxy);
      break;
    }
    case 'osm-pbf': await importOsmPbf(file, sink, progress, o.bbox); break;
    case 'fgb': await importFlatGeobuf(file, sink, progress, o.bbox); break;
    default: throw new Error('Format wird hier nicht unterstützt: ' + o.format);
  }
  if (!sink.lineCount) throw new Error('Keine Linien gefunden' + (o.bbox ? ' (im gewählten Ausschnitt)' : '') + '.');
  return { batch: sink.toBatch(), skipped: sink.skipped, lines: sink.lineCount };
}
