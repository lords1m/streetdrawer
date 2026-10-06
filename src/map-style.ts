import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';
import { CLASS_MAIN, CLASS_PATH, CLASS_STREET } from './core/graph';

export type Theme = 'light' | 'dark';

export const BASE_SOURCE = 'protomaps';
const ASSETS = 'https://protomaps.github.io/basemaps-assets';

export function makeStyle(theme: Theme, pmtilesUrl: string, labels: boolean): StyleSpecification {
  const flavor = namedFlavor(theme === 'dark' ? 'dark' : 'light');
  let ls = layers(BASE_SOURCE, flavor, { lang: 'de' }) as LayerSpecification[];
  if (!labels) ls = ls.filter((l) => l.type !== 'symbol');
  const style: StyleSpecification = {
    version: 8,
    sources: {
      [BASE_SOURCE]: {
        type: 'vector',
        url: 'pmtiles://' + pmtilesUrl,
        attribution: '<a href="https://openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
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

/** Linien-Layer, die Straßen tatsächlich zeichnen (für queryRenderedFeatures). */
export function roadLayerIds(style: StyleSpecification): string[] {
  return style.layers
    .filter((l) => l.type === 'line' && 'source-layer' in l && l['source-layer'] === 'roads')
    .map((l) => l.id)
    .filter((id) => !/casing|oneway|rail|runway|taxiway|pier|shield|label/.test(id));
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
