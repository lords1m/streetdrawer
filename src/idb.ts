/**
 * Gemeinsamer Zugriff auf die IndexedDB der App. Eine Datenbank, eine Versionsnummer, alle Stores:
 * öffnet ein Modul die Datenbank mit einer älteren Version als die bereits angelegte, scheitert das mit VersionError.
 * Neue Stores deshalb nur hier eintragen und VERSION erhöhen.
 */
export const DB_NAME = 'strassenzeichner';
export const VERSION = 2;
export const STORES = ['overpass', 'geocode', 'drawing'] as const;
export type StoreName = (typeof STORES)[number];

/** Schlüssel-Wert-Speicher wie in den Clients erwartet (injizierbar für Tests). */
export interface KvStore<T> {
  get(k: string): Promise<T | undefined>;
  set(k: string, v: T): Promise<void>;
  del?(k: string): Promise<void>;
}

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
      };
      r.onsuccess = () => {
        // ein anderer Tab mit neuerer Version: Verbindung freigeben, beim nächsten Zugriff neu öffnen
        r.result.onversionchange = () => { r.result.close(); dbp = null; };
        res(r.result);
      };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('IndexedDB blockiert'));
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

/** Store als KvStore. Alle Fehler werden geschluckt: der Speicher ist optional (privates Fenster, gesperrt …). */
export function idbStore<T>(name: StoreName): KvStore<T> {
  return {
    async get(k) {
      try {
        const db = await open();
        return await new Promise<T | undefined>((res) => {
          const q = db.transaction(name).objectStore(name).get(k);
          q.onsuccess = () => res(q.result as T | undefined);
          q.onerror = () => res(undefined);
        });
      } catch { return undefined; }
    },
    async set(k, v) {
      try {
        const db = await open();
        await new Promise<void>((res) => {
          const tx = db.transaction(name, 'readwrite');
          tx.objectStore(name).put(v, k);
          tx.oncomplete = () => res(); tx.onerror = () => res(); tx.onabort = () => res();
        });
      } catch { /* Speicher ist optional */ }
    },
    async del(k) {
      try {
        const db = await open();
        await new Promise<void>((res) => {
          const tx = db.transaction(name, 'readwrite');
          tx.objectStore(name).delete(k);
          tx.oncomplete = () => res(); tx.onerror = () => res(); tx.onabort = () => res();
        });
      } catch { /* Speicher ist optional */ }
    },
  };
}

/** IndexedDB-Store, falls im Umfeld vorhanden (im Node-Test nicht). */
export const optionalStore = <T>(name: StoreName): KvStore<T> | undefined =>
  typeof indexedDB !== 'undefined' ? idbStore<T>(name) : undefined;
