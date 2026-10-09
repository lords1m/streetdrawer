import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from 'maplibre-gl';
import { CLASS_MAIN, CLASS_PATH, CLASS_STREET } from './core/graph';

export type Theme = 'light' | 'dark';

/**
 * Kachelschema der Quelle. 'protomaps': Layer `roads`, Attribut `kind` (PMTiles aus dem Protomaps-Build, z. B.
 * berlin.pmtiles). 'openmaptiles': Layer `transportation`, Attribut `class` (z. B. OpenFreeMap).
 */
export type Schema = 'protomaps' | 'openmaptiles';

/** Kartenquelle: PMTiles-Datei (Range-Requests) oder TileJSON eines Kachelservers. */
export interface MapSource { kind: 'pmtiles' | 'tilejson'; url: string; schema: Schema }

/** `.pmtiles` → PMTiles im Protomaps-Schema, alles andere → TileJSON im OpenMapTiles-Schema. */
export function sourceFor(url: string): MapSource {
  const path = url.split(/[?#]/)[0];
  return /\.pmtiles$/i.test(path) ? { kind: 'pmtiles', url, schema: 'protomaps' } : { kind: 'tilejson', url, schema: 'openmaptiles' };
}

export const BASE_SOURCE = 'protomaps';
const ASSETS = 'https://protomaps.github.io/basemaps-assets';
const OSM = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap-Mitwirkende</a>';

export function makeStyle(theme: Theme, src: MapSource, labels: boolean): StyleSpecification {
  return src.schema === 'openmaptiles' ? openMapTilesStyle(theme, src.url, labels) : protomapsStyle(theme, src.url, labels);
}

function protomapsStyle(theme: Theme, pmtilesUrl: string, labels: boolean): StyleSpecification {
  const flavor = namedFlavor(theme === 'dark' ? 'dark' : 'light');
  let ls = layers(BASE_SOURCE, flavor, { lang: 'de' }) as LayerSpecification[];
  if (!labels) ls = ls.filter((l) => l.type !== 'symbol');
  const style: StyleSpecification = {
    version: 8,
    sources: {
      [BASE_SOURCE]: {
        type: 'vector',
        url: 'pmtiles://' + pmtilesUrl,
        attribution: `${OSM} · <a href="https://protomaps.com">Protomaps</a>`,
      },
    },
    layers: ls,
  };
  if (labels) {
    style.glyphs = `${ASSETS}/fonts/{fontstack}/{range}.pbf`;
    style.sprite = `${ASSETS}/sprites/v4/${theme === 'dark' ? 'dark' : 'light'}`;
  }
  return style;
}

// ---------------------------------------------------------------- OpenMapTiles-Schema (OpenFreeMap)
const OMT_FONTS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const HIGHWAY = ['motorway', 'trunk'];
const MAJOR = ['primary', 'secondary'];
const MINOR = ['tertiary', 'minor', 'service', 'busway', 'raceway'];
const PATHS = ['path', 'track', 'bridleway'];

const PALETTE = {
  light: {
    bg: '#f2efe9', water: '#aad3df', park: '#d8e8c8', wood: '#cddfbd', building: '#e2dcd2', boundary: '#9e9cab',
    casing: '#c9c1b5', highway: '#f6c27a', major: '#fbe4a6', minor: '#ffffff', path: '#8f8a83', rail: '#b3aca3',
    text: '#3d3d3d', halo: '#ffffff', water_text: '#4a7a96',
  },
  dark: {
    bg: '#1b1f24', water: '#1d2e3d', park: '#1f2a22', wood: '#1d271f', building: '#272c33', boundary: '#5d6470',
    casing: '#111418', highway: '#7a5a32', major: '#5c5140', minor: '#3a4048', path: '#6b7078', rail: '#454b53',
    text: '#c9cdd2', halo: '#111418', water_text: '#6f97b3',
  },
};

const inClass = (list: string[]): ExpressionSpecification => ['match', ['get', 'class'], list, true, false];
const width = (stops: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()] as ExpressionSpecification;

function openMapTilesStyle(theme: Theme, tilejsonUrl: string, labels: boolean): StyleSpecification {
  const c = PALETTE[theme];
  const src = BASE_SOURCE;
  const roadWidths: Record<string, [number, number][]> = {
    highway: [[5, 0.6], [10, 2], [14, 6], [18, 24]],
    major: [[7, 0.4], [10, 1.2], [14, 5], [18, 20]],
    minor: [[11, 0.4], [14, 2.5], [18, 14]],
  };
  const road = (id: string, list: string[], color: string, w: [number, number][], minzoom: number): LayerSpecification[] => [
    {
      id: `${id}_casing`, type: 'line', source: src, 'source-layer': 'transportation', minzoom,
      filter: inClass(list), layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.casing, 'line-width': width(w.map(([z, v]) => [z, v * 1.35 + 0.6])) },
    },
    {
      id, type: 'line', source: src, 'source-layer': 'transportation', minzoom,
      filter: inClass(list), layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width(w) },
    },
  ];
  const ls: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': c.bg } },
    { id: 'landcover_wood', type: 'fill', source: src, 'source-layer': 'landcover', filter: inClass(['wood', 'forest']), paint: { 'fill-color': c.wood } },
    { id: 'park', type: 'fill', source: src, 'source-layer': 'park', paint: { 'fill-color': c.park } },
    { id: 'landuse_green', type: 'fill', source: src, 'source-layer': 'landuse', filter: inClass(['grass', 'cemetery', 'pitch', 'playground']), paint: { 'fill-color': c.park } },
    { id: 'water', type: 'fill', source: src, 'source-layer': 'water', paint: { 'fill-color': c.water } },
    { id: 'waterway', type: 'line', source: src, 'source-layer': 'waterway', paint: { 'line-color': c.water, 'line-width': width([[8, 0.5], [18, 6]]) } },
    { id: 'building', type: 'fill', source: src, 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': c.building } },
    { id: 'boundary_country', type: 'line', source: src, 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': c.boundary, 'line-width': 1, 'line-dasharray': [3, 2] } },
    {
      id: 'roads_rail', type: 'line', source: src, 'source-layer': 'transportation', minzoom: 11,
      filter: inClass(['rail', 'transit']), paint: { 'line-color': c.rail, 'line-width': 1.2, 'line-dasharray': [3, 3] },
    },
    {
      id: 'roads_path', type: 'line', source: src, 'source-layer': 'transportation', minzoom: 13,
      filter: inClass(PATHS), paint: { 'line-color': c.path, 'line-width': width([[13, 0.6], [18, 2.5]]), 'line-dasharray': [2, 1.5] },
    },
    ...road('roads_minor', MINOR, c.minor, roadWidths.minor, 11),
    ...road('roads_major', MAJOR, c.major, roadWidths.major, 7),
    ...road('roads_highway', HIGHWAY, c.highway, roadWidths.highway, 5),
  ];
  if (labels) {
    const name: ExpressionSpecification = ['coalesce', ['get', 'name:de'], ['get', 'name']];
    const text = { 'text-color': c.text, 'text-halo-color': c.halo, 'text-halo-width': 1.4 };
    ls.push(
      {
        id: 'roads_labels', type: 'symbol', source: src, 'source-layer': 'transportation_name', minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 12 }, paint: text,
      },
      {
        id: 'water_labels', type: 'symbol', source: src, 'source-layer': 'water_name',
        layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 12 }, paint: { ...text, 'text-color': c.water_text },
      },
      {
        id: 'places_minor', type: 'symbol', source: src, 'source-layer': 'place', minzoom: 11,
        filter: inClass(['suburb', 'quarter', 'neighbourhood', 'village', 'hamlet']),
        layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 12 }, paint: text,
      },
      {
        id: 'places_major', type: 'symbol', source: src, 'source-layer': 'place',
        filter: inClass(['city', 'town', 'state', 'country']),
        layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 12, 16] }, paint: text,
      },
    );
  }
  return {
    version: 8,
    sources: {
      [src]: {
        type: 'vector', url: tilejsonUrl,
        attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/">© OpenMapTiles</a> · ${OSM}`,
      },
    },
    ...(labels ? { glyphs: OMT_FONTS } : {}),
    layers: ls,
  };
}

// ---------------------------------------------------------------- Straßen für das Einrast-Netz
/** Linien-Layer, die Straßen tatsächlich zeichnen (für queryRenderedFeatures). */
export function roadLayerIds(style: StyleSpecification): string[] {
  return style.layers
    .filter((l) => l.type === 'line' && 'source-layer' in l && (l['source-layer'] === 'roads' || l['source-layer'] === 'transportation'))
    .map((l) => l.id)
    .filter((id) => !/casing|oneway|rail|runway|taxiway|pier|shield|label/.test(id));
}

/** Klasse einer Straße je Schema. null = nicht befahrbar/ignorieren. */
export function roadClass(schema: Schema, props: Record<string, unknown>): number | null {
  return schema === 'openmaptiles' ? omtClassToClass(props.class) : kindToClass(props.kind);
}

/** Ebene einer Straße (Brücke 1, Boden 0, Tunnel -1). */
export function roadLevel(schema: Schema, props: Record<string, unknown>): number {
  if (schema === 'openmaptiles') return props.brunnel === 'bridge' ? 1 : props.brunnel === 'tunnel' ? -1 : 0;
  return props.is_bridge ? 1 : props.is_tunnel ? -1 : 0;
}

/** Protomaps-Schema: roads.kind → Klasse. null = nicht befahrbar/ignorieren. */
export function kindToClass(kind: unknown): number | null {
  switch (kind) {
    case 'highway': case 'major_road': return CLASS_MAIN;
    case 'medium_road': case 'minor_road': return CLASS_STREET;
    case 'path': return CLASS_PATH;
    case 'other': return CLASS_STREET;
    case 'rail': case 'ferry': case 'aeroway': return null;
    default: return CLASS_STREET;
  }
}

/** OpenMapTiles-Schema: transportation.class → Klasse. */
export function omtClassToClass(cls: unknown): number | null {
  if (typeof cls === 'string') {
    if (HIGHWAY.includes(cls) || MAJOR.includes(cls)) return CLASS_MAIN;
    if (PATHS.includes(cls)) return CLASS_PATH;
  }
  switch (cls) {
    case 'rail': case 'transit': case 'ferry': case 'aerialway': case 'pier': return null;
    default: return CLASS_STREET;
  }
}
