import { optionalStore, type KvStore } from './idb';

/**
 * Ortssuche über Nominatim (OpenStreetMap).
 * Nutzungsrichtlinie: höchstens 1 Anfrage pro Sekunde, kein Autocomplete (nur bei Enter/Klick suchen), Ergebnisse
 * cachen, Attribution anzeigen. Ein User-Agent lässt sich im Browser nicht setzen; es wird der Referer gesendet.
 */
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_RETRIES = 2;
const DEFAULT_WAIT_S = 5;

export type PlaceKind = 'land' | 'region' | 'stadt' | 'ort' | 'strasse' | 'adresse' | 'sonstiges';

export interface Place {
  /** Kurzname (erste Zeile in der Trefferliste). */
  name: string;
  /** Vollständige Bezeichnung von Nominatim. */
  label: string;
  lng: number;
  lat: number;
  /** [West, Süd, Ost, Nord] in Grad – MapLibre-Reihenfolge. */
  bbox: [number, number, number, number];
  kind: PlaceKind;
}

export type GeocodeStatus = 'ok' | 'leer' | 'offline' | 'ratenlimit' | 'fehler';

export interface GeocodeResult {
  status: GeocodeStatus;
  places: Place[];
  /** Herkunft bei 'ok'/'leer': Netz, Cache oder direkt eingegebene Koordinaten. */
  source?: 'netz' | 'cache' | 'koordinaten';
  message?: string;
}

export interface CachedSearch { places: Place[]; t: number }

export interface GeocodeDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
  now?: () => number;
  store?: KvStore<CachedSearch>;
  onStatus?: (s: string) => void;
}

/** Eintrag aus der jsonv2-Antwort (nur die genutzten Felder). */
export interface NominatimItem {
  lat: string; lon: string;
  boundingbox?: [string, string, string, string]; // Süd, Nord, West, Ost (!)
  display_name?: string; name?: string;
  addresstype?: string; type?: string; category?: string;
  place_rank?: number;
}

/** Normalisierte Anfrage als Cache-Schlüssel. */
export const normalizeQuery = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Koordinaten-Eingabe erkennen, immer Breite vor Länge: „52.52, 13.40“, „52.52 13.40“, „52,52; 13,40“, „52,52 13,40“.
 * Liefert null bei allem anderen oder bei Werten außerhalb des gültigen Bereichs.
 */
export function parseCoords(q: string): { lat: number; lng: number } | null {
  const s = q.trim();
  const dot = /^([-+]?\d+(?:\.\d+)?)°?\s*(?:[,;]\s*|\s+)([-+]?\d+(?:\.\d+)?)°?$/.exec(s);
  const comma = /^([-+]?\d+(?:,\d+)?)°?\s*(?:;\s*|\s+)([-+]?\d+(?:,\d+)?)°?$/.exec(s);
  const m = dot ?? comma;
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.')), lng = Number(m[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Ortstyp aus addresstype und place_rank (Nominatim-Rangskala 0–30). */
export function placeKind(addresstype: string | undefined, rank: number | undefined): PlaceKind {
  switch (addresstype) {
    case 'country': return 'land';
    case 'state': case 'region': case 'province': case 'county': case 'state_district': return 'region';
    case 'city': case 'municipality': return 'stadt';
    case 'town': case 'village': case 'hamlet': case 'suburb': case 'borough': case 'quarter':
    case 'neighbourhood': case 'city_district': case 'postcode': return 'ort';
    case 'road': return 'strasse';
  }
  if (rank === undefined || !Number.isFinite(rank)) return 'sonstiges';
  if (rank <= 4) return 'land';
  if (rank <= 12) return 'region';
  if (rank <= 16) return 'stadt';
  if (rank <= 25) return 'ort';
  if (rank <= 27) return 'strasse';
  return 'adresse';
}

/** Höchster Zoom beim Sprung je Ortstyp. */
export const KIND_ZOOM: Record<PlaceKind, number> = { land: 6, region: 9, stadt: 12, ort: 14, strasse: 16, adresse: 18, sonstiges: 16 };

export function parseNominatim(items: NominatimItem[]): Place[] {
  const out: Place[] = [];
  for (const it of items ?? []) {
    const lat = Number(it.lat), lng = Number(it.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    let bbox: [number, number, number, number] = [lng, lat, lng, lat];
    if (it.boundingbox?.length === 4) {
      const [s, n, w, e] = it.boundingbox.map(Number);
      if ([s, n, w, e].every(Number.isFinite)) bbox = [w, s, e, n];
    }
    const label = it.display_name ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    out.push({ name: it.name || label.split(',')[0], label, lng, lat, bbox, kind: placeKind(it.addresstype, it.place_rank) });
  }
  return out;
}

export function buildSearchUrl(q: string, viewbox?: [number, number, number, number]) {
  const p = new URLSearchParams({ format: 'jsonv2', q: q.trim(), limit: '5', 'accept-language': 'de', addressdetails: '0' });
  if (viewbox) {
    p.set('viewbox', viewbox.map((v) => v.toFixed(3)).join(','));
    p.set('bounded', '0');
  }
  return `${NOMINATIM_ENDPOINT}?${p}`;
}

/** Treffer für eingegebene Koordinaten (ohne Netzabfrage). */
export function coordPlace(c: { lat: number; lng: number }): Place {
  const label = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
  return { name: 'Koordinaten', label, lat: c.lat, lng: c.lng, bbox: [c.lng, c.lat, c.lng, c.lat], kind: 'adresse' };
}

export class GeocodeClient {
  private mem = new Map<string, CachedSearch>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = -Infinity;
  requests = 0;
  private d: Required<Omit<GeocodeDeps, 'store' | 'onStatus'>> & Pick<GeocodeDeps, 'store' | 'onStatus'>;

  constructor(deps: GeocodeDeps = {}) {
    this.d = {
      fetchFn: deps.fetchFn ?? ((...a) => fetch(...a)),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      minGapMs: deps.minGapMs ?? 1100,
      now: deps.now ?? (() => Date.now()),
      store: deps.store ?? optionalStore<CachedSearch>('geocode'),
      onStatus: deps.onStatus,
    };
  }

  /** Sucht nach Adresse/Ort/Land/PLZ oder erkennt Koordinaten. Anfragen laufen strikt nacheinander. */
  search(q: string, viewbox?: [number, number, number, number]): Promise<GeocodeResult> {
    const c = parseCoords(q);
    if (c) return Promise.resolve({ status: 'ok', places: [coordPlace(c)], source: 'koordinaten' });
    const key = normalizeQuery(q);
    if (!key) return Promise.resolve({ status: 'leer', places: [] });
    const run = async (): Promise<GeocodeResult> => {
      const cached = await this.cached(key);
      if (cached) return { status: cached.places.length ? 'ok' : 'leer', places: cached.places, source: 'cache' };
      const r = await this.fetchPlaces(q, viewbox);
      if (r.status === 'ok' || r.status === 'leer') {
        const entry = { places: r.places, t: this.d.now() };
        this.mem.set(key, entry);
        await this.d.store?.set(key, entry);
      }
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async cached(key: string): Promise<CachedSearch | undefined> {
    const fresh = (e?: CachedSearch) => (e && this.d.now() - e.t < TTL_MS ? e : undefined);
    let e = fresh(this.mem.get(key));
    if (!e) {
      e = fresh(await this.d.store?.get(key));
      if (e) this.mem.set(key, e);
    }
    return e;
  }

  private async fetchPlaces(q: string, viewbox?: [number, number, number, number]): Promise<GeocodeResult> {
    const url = buildSearchUrl(q, viewbox);
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastAt + this.d.minGapMs - this.d.now();
      if (wait > 0) await this.d.sleep(wait);
      this.lastAt = this.d.now();
      this.requests++;
      let res: Response;
      try {
        res = await this.d.fetchFn(url, { headers: { Accept: 'application/json' }, referrerPolicy: 'strict-origin-when-cross-origin' });
      } catch (e) {
        return { status: 'offline', places: [], message: (e as Error).message };
      }
      if (res.status === 429 || res.status === 503) {
        if (attempt >= MAX_RETRIES) return { status: 'ratenlimit', places: [] };
        const ra = Number(res.headers.get('Retry-After'));
        const secs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) : DEFAULT_WAIT_S;
        this.d.onStatus?.(`Suchdienst ausgelastet – neuer Versuch in ${secs} s …`);
        await this.d.sleep(secs * 1000);
        this.lastAt = this.d.now();
        continue;
      }
      if (!res.ok) return { status: 'fehler', places: [], message: `HTTP ${res.status}` };
      try {
        const places = parseNominatim(await res.json());
        return { status: places.length ? 'ok' : 'leer', places, source: 'netz' };
      } catch (e) {
        return { status: 'fehler', places: [], message: (e as Error).message };
      }
    }
  }
}
