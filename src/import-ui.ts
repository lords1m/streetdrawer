import type * as maplibregl from 'maplibre-gl';
import type { NetClient } from './net-client';

export interface ImportCtx {
  map: maplibregl.Map;
  net: NetClient;
  state: Record<string, unknown>;
  setStatus: (s: string) => void;
  showNetOverlay: () => void;
  setImportAvailable: (has: boolean, info: string) => void;
}

/** Wird in Schritt 2 mit Import und Overpass gefüllt. */
export function initImport(_ctx: ImportCtx) { /* folgt */ }
