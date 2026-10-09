import { PMTiles, type Protocol, type Source } from 'pmtiles';
import type { MapSource } from './map-style';

/** Ausdehnung einer PMTiles-Datei laut Header (Grad). */
export interface TileBounds { minLon: number; minLat: number; maxLon: number; maxLat: number }

export interface ProbeResult { ok: boolean; bounds: TileBounds | null; error?: string }

/**
 * Liest den Header einer PMTiles-Datei mit Zeitlimit. Bei Erfolg wird die Instanz beim Protokoll registriert,
 * damit MapLibre den Header nicht noch einmal lädt.
 */
export async function probeTiles(src: string | Source, timeoutMs: number, protocol?: Protocol): Promise<ProbeResult> {
  const p = new PMTiles(src);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const h = await Promise.race([
      p.getHeader(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('Zeitüberschreitung')), timeoutMs); }),
    ]);
    protocol?.add(p);
    // Dateien ohne gesetzte Grenzen (alles 0) gelten als „überall“
    const unknown = h.minLon === h.maxLon && h.minLat === h.maxLat;
    return { ok: true, bounds: unknown ? null : { minLon: h.minLon, minLat: h.minLat, maxLon: h.maxLon, maxLat: h.maxLat } };
  } catch (e) {
    return { ok: false, bounds: null, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liest das TileJSON eines Kachelservers (z. B. OpenFreeMap) mit Zeitlimit. Erreichbar heißt: gültiges JSON mit
 * Kachel-URLs. Grenzen aus `bounds`, sonst unbekannt.
 */
export async function probeTileJson(url: string, timeoutMs: number, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<ProbeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, bounds: null, error: `HTTP ${res.status}` };
    const tj = await res.json() as { tiles?: unknown; bounds?: unknown };
    if (!Array.isArray(tj.tiles) || !tj.tiles.length) return { ok: false, bounds: null, error: 'kein TileJSON' };
    const b = Array.isArray(tj.bounds) && tj.bounds.length === 4 && tj.bounds.every(Number.isFinite) ? tj.bounds as number[] : null;
    return { ok: true, bounds: b ? { minLon: b[0], minLat: b[1], maxLon: b[2], maxLat: b[3] } : null };
  } catch (e) {
    return { ok: false, bounds: null, error: ctl.signal.aborted ? 'Zeitüberschreitung' : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export function probeSource(src: MapSource, timeoutMs: number, protocol?: Protocol): Promise<ProbeResult> {
  return src.kind === 'pmtiles' ? probeTiles(src.url, timeoutMs, protocol) : probeTileJson(src.url, timeoutMs);
}

/** Erste erreichbare Quelle der Liste; ist keine erreichbar, die letzte (Fallback) ohne Grenzen. */
export async function chooseSource(sources: MapSource[], timeoutMs: number, protocol?: Protocol) {
  for (let i = 0; i < sources.length; i++) {
    const r = await probeSource(sources[i], timeoutMs, protocol);
    if (r.ok) return { source: sources[i], index: i, bounds: r.bounds, ok: true };
  }
  return { source: sources[sources.length - 1], index: sources.length - 1, bounds: null, ok: false };
}

/** Liegt der Punkt in der Ausdehnung der Datei? Unbekannte Grenzen gelten als „ja“. */
export function covers(b: TileBounds | null, lng: number, lat: number): boolean {
  return !b || (lng >= b.minLon && lng <= b.maxLon && lat >= b.minLat && lat <= b.maxLat);
}
