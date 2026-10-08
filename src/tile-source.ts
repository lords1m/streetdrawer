import { PMTiles, type Protocol, type Source } from 'pmtiles';

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

/** Erste erreichbare Quelle der Liste; ist keine erreichbar, die letzte (Fallback) ohne Grenzen. */
export async function chooseSource(urls: string[], timeoutMs: number, protocol?: Protocol) {
  for (let i = 0; i < urls.length; i++) {
    const r = await probeTiles(urls[i], timeoutMs, protocol);
    if (r.ok) return { url: urls[i], index: i, bounds: r.bounds, ok: true };
  }
  return { url: urls[urls.length - 1], index: urls.length - 1, bounds: null, ok: false };
}

/** Liegt der Punkt in der Ausdehnung der Datei? Unbekannte Grenzen gelten als „ja“. */
export function covers(b: TileBounds | null, lng: number, lat: number): boolean {
  return !b || (lng >= b.minLon && lng <= b.maxLon && lat >= b.minLat && lat <= b.maxLat);
}
