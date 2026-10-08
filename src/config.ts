/**
 * Konfiguration der Kartenquelle.
 * Die Welt-.pmtiles liegt in einem öffentlichen Cloud-Storage-Bucket (Firebase Hosting erlaubt höchstens 2 GB pro
 * Datei); Einrichtung: scripts/setup-world-tiles.sh. Der Dateiname trägt das Build-Datum: ein neuer Build bekommt eine
 * neue URL, damit Clients mit gecachtem Header keine ETag-Konflikte sehen.
 * Überschreiben beim Bauen: VITE_WORLD_PMTILES_URL=https://… npm run build
 */
export const WORLD_PMTILES_URL: string =
  import.meta.env.VITE_WORLD_PMTILES_URL || 'https://storage.googleapis.com/strassenzeichner-tiles/planet-20261001.pmtiles';

/** Schneller Start und Fallback: liegt neben der App auf Firebase Hosting. */
export const FALLBACK_PMTILES_FILE = 'berlin.pmtiles';

/** So lange darf das Lesen des Headers beim Start dauern, bevor auf den Fallback gewechselt wird. */
export const PROBE_TIMEOUT_MS = 5000;

/** Startansicht ohne URL-Hash und ohne gespeicherte Position. */
export const DEFAULT_VIEW = { center: [13.405, 52.52] as [number, number], zoom: 13 };
