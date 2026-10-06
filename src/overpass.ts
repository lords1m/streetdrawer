import type { LineBatch } from './core/types';
import { classifyHighway } from './import/sink';

/**
 * Overpass-Ergänzung für kleine Ausschnitte bei hohem Zoom.
 * Nutzungsrichtlinie: wenige Abfragen, Ergebnisse cachen (Speicher + IndexedDB), nacheinander mit Mindestabstand,
 * bei 429/504 warten. Ein User-Agent lässt sich im Browser nicht setzen; es wird der Referer der Seite mitgeschickt
 * und die App im Abfragekommentar genannt.
 */
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const TILE_ZOOM = 16;
const TTL_MS = 7 * 24 * 3600 * 1000;
const FAIL_BACKOFF_MS = 10 * 60 * 1000;

export interface OverpassTile { lines: number[][]; cls: number[]; t: number } // lines: flache lng/lat-Arrays

export interface OverpassDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
  now?: () => number;
  store?: { get(k: string): Promise<OverpassTile | undefined>; set(k: string, v: OverpassTile): Promise<void> };
  onStatus?: (s: string) => void;
}

export function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z;
  const lng = (xx: number) => (xx / n) * 360 - 180;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return { w: lng(x), e: lng(x + 1), n: lat(y), s: lat(y + 1) };
}
export function tilesFor(bounds: { west: number; south: number; east: number; north: number }, z = TILE_ZOOM) {
  const n = 2 ** z;
  const tx = (lng: number) => Math.floor(((lng + 180) / 360) * n);
  const ty = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  };
  const out: [number, number][] = [];
  for (let y = ty(bounds.north); y <= ty(bounds.south); y++) for (let x = tx(bounds.west); x <= tx(bounds.east); x++) out.push([x, y]);
  return out;
}

export function buildQuery(b: { s: number; w: number; n: number; e: number }) {
  return `[out:json][timeout:25];/* Strassenzeichner (statische Web-App) */way["highway"](${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)});out geom;`;
}

export function parseOverpass(doc: { elements?: { type: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[] }): OverpassTile {
  const lines: number[][] = [], cls: number[] = [];
  for (const el of doc.elements ?? []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const c = classifyHighway(el.tags?.highway);
    if (c === null) continue;
    const flat: number[] = [];
    for (const g of el.geometry) flat.push(g.lon, g.lat);
    lines.push(flat); cls.push(c);
  }
  return { lines, cls, t: Date.now() };
}

export function tilesToBatch(tiles: OverpassTile[]): LineBatch | null {
  let pts = 0, n = 0;
  for (const t of tiles) { n += t.lines.length; for (const l of t.lines) pts += l.length / 2; }
  if (!n) return null;
  const coords = new Float64Array(pts * 2), offsets = new Uint32Array(n + 1), cls = new Uint8Array(n);
  let k = 0, li = 0;
  for (const t of tiles) {
    t.lines.forEach((l, i) => {
      offsets[li] = k; cls[li] = t.cls[i]; li++;
      coords.set(l, k * 2); k += l.length / 2;
    });
  }
  offsets[li] = k;
  return { coords, offsets, cls, kind: 'lnglat' };
}

function idbStore() {
  const open = () => new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('strassenzeichner', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('overpass');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return {
    async get(k: string) {
      try {
        const db = await open();
        return await new Promise<OverpassTile | undefined>((res) => {
          const q = db.transaction('overpass').objectStore('overpass').get(k);
          q.onsuccess = () => res(q.result as OverpassTile | undefined);
          q.onerror = () => res(undefined);
        });
      } catch { return undefined; }
    },
    async set(k: string, v: OverpassTile) {
      try {
        const db = await open();
        await new Promise<void>((res) => {
          const tx = db.transaction('overpass', 'readwrite');
          tx.objectStore('overpass').put(v, k);
          tx.oncomplete = () => res(); tx.onerror = () => res();
        });
      } catch { /* Cache ist optional */ }
    },
  };
}

export class OverpassClient {
  private mem = new Map<string, OverpassTile>();
  /** Fehlgeschlagene Tiles: nicht vor diesem Zeitpunkt erneut abfragen (Nutzungsrichtlinie). */
  private failedUntil = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  requests = 0;
  private d: Required<Omit<OverpassDeps, 'store' | 'onStatus'>> & Pick<OverpassDeps, 'store' | 'onStatus'>;

  constructor(deps: OverpassDeps = {}) {
    this.d = {
      fetchFn: deps.fetchFn ?? ((...a) => fetch(...a)),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      minGapMs: deps.minGapMs ?? 2500,
      now: deps.now ?? (() => Date.now()),
      store: deps.store ?? (typeof indexedDB !== 'undefined' ? idbStore() : undefined),
      onStatus: deps.onStatus,
    };
  }

  /** Liefert (gecacht oder nach Abruf) alle Tiles der Liste; Abrufe laufen strikt nacheinander. */
  tiles(list: [number, number][], z = TILE_ZOOM): Promise<OverpassTile[]> {
    const run = async () => {
      const out: OverpassTile[] = [];
      for (const [x, y] of list) {
        const key = `${z}/${x}/${y}`;
        let t = this.mem.get(key);
        if (!t) {
          const stored = await this.d.store?.get(key);
          if (stored && this.d.now() - stored.t < TTL_MS) t = stored;
        }
        if (!t) {
          const until = this.failedUntil.get(key);
          if (until !== undefined && this.d.now() < until) continue;
          t = await this.fetchTile(z, x, y, key);
          if (!t) this.failedUntil.set(key, this.d.now() + FAIL_BACKOFF_MS);
          else this.failedUntil.delete(key);
        }
        if (t) { this.mem.set(key, t); out.push(t); }
      }
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async fetchTile(z: number, x: number, y: number, key: string): Promise<OverpassTile | undefined> {
    const b = tileBounds(z, x, y);
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = this.lastAt + this.d.minGapMs - this.d.now();
      if (wait > 0) await this.d.sleep(wait);
      this.lastAt = this.d.now();
      this.requests++;
      let res: Response;
      try {
        res = await this.d.fetchFn(OVERPASS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(buildQuery(b)),
          referrerPolicy: 'strict-origin-when-cross-origin',
        });
      } catch (e) {
        this.d.onStatus?.('Overpass nicht erreichbar: ' + (e as Error).message);
        return undefined;
      }
      if (res.status === 429 || res.status === 504) {
        const ra = Number(res.headers.get('Retry-After'));
        const secs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) : res.status === 429 ? 30 : 15;
        this.d.onStatus?.(`Overpass ausgelastet (${res.status}) – warte ${secs} s …`);
        await this.d.sleep(secs * 1000);
        this.lastAt = this.d.now();
        continue;
      }
      if (!res.ok) { this.d.onStatus?.(`Overpass-Fehler ${res.status}`); return undefined; }
      const t = parseOverpass(await res.json());
      await this.d.store?.set(key, t);
      return t;
    }
    this.d.onStatus?.('Overpass: Abruf nach mehreren Versuchen aufgegeben');
    return undefined;
  }
}
