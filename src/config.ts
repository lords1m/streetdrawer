/**
 * Konfiguration der Kartenquelle.
 * Standard ist OpenFreeMap: freie OpenStreetMap-Vektorkacheln der ganzen Welt (OpenMapTiles-Schema), ohne Schlüssel,
 * ohne Anmeldung, ohne Nutzungsgrenzen und ohne Kosten; Bedingung ist die Namensnennung (steht in der Kartenecke).
 * https://openfreemap.org
 * Überschreiben beim Bauen: VITE_WORLD_TILES_URL=https://… npm run build (TileJSON-URL oder .pmtiles-Datei)
 */
export const WORLD_TILES_URL: string = import.meta.env.VITE_WORLD_TILES_URL || 'https://tiles.openfreemap.org/planet';

/** Schneller Start und Fallback (OSM-Daten aus dem Protomaps-Build): liegt neben der App auf Firebase Hosting. */
export const FALLBACK_PMTILES_FILE = 'berlin.pmtiles';

/** So lange darf die Prüfung der Kartenquelle beim Start dauern, bevor auf den Fallback gewechselt wird. */
export const PROBE_TIMEOUT_MS = 5000;

/** Startansicht ohne URL-Hash und ohne gespeicherte Position. */
export const DEFAULT_VIEW = { center: [13.405, 52.52] as [number, number], zoom: 13 };
