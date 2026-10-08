/**
 * Kleine Einstellungen in localStorage (JSON, Schlüssel mit Präfix „sz-“). Jeder Zugriff kann scheitern
 * (privates Fenster, gesperrte Website-Daten, Kontingent) – dann gilt der Standardwert bzw. es wird nichts gespeichert.
 */
const PREFIX = 'sz-';

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch { return fallback; }
}

export function savePref(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* optional */ }
}
