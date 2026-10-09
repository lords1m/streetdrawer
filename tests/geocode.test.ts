import { describe, expect, it } from 'vitest';
import {
  GeocodeClient, KIND_ZOOM, buildSearchUrl, normalizeQuery, parseCoords, parseNominatim, placeKind,
  type CachedSearch, type NominatimItem, type Place,
} from '../src/geocode';
import { placeCamera } from '../src/search-ui';

const BERLIN: NominatimItem = {
  lat: '52.5170365', lon: '13.3888599', name: 'Berlin', display_name: 'Berlin, Deutschland',
  boundingbox: ['52.3382448', '52.6755087', '13.0883450', '13.7611609'], addresstype: 'city', place_rank: 8,
};

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Uhr und Schlaf als Attrappe: sleep rückt die Uhr vor und merkt sich die Wartezeiten. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
}

const memStore = () => {
  const m = new Map<string, CachedSearch>();
  return { m, store: { get: async (k: string) => m.get(k), set: async (k: string, v: CachedSearch) => { m.set(k, v); } } };
};

describe('Nominatim-Antwort', () => {
  it('bbox wird von [S, N, W, O] nach [W, S, O, N] umgestellt', () => {
    const [p] = parseNominatim([BERLIN]);
    expect(p.bbox).toEqual([13.088345, 52.3382448, 13.7611609, 52.6755087]);
    expect(p.lng).toBeCloseTo(13.38886, 5);
    expect(p.lat).toBeCloseTo(52.51704, 5);
    expect(p.name).toBe('Berlin');
    expect(p.label).toBe('Berlin, Deutschland');
    expect(p.kind).toBe('stadt');
  });

  it('ungültige Einträge werden übersprungen, fehlende bbox wird zum Punkt', () => {
    const ps = parseNominatim([{ lat: 'x', lon: '1' }, { lat: '1', lon: '2', display_name: 'A, B' }]);
    expect(ps).toHaveLength(1);
    expect(ps[0].bbox).toEqual([2, 1, 2, 1]);
    expect(ps[0].name).toBe('A');
  });

  it('Ortstyp aus addresstype, sonst aus place_rank', () => {
    expect(placeKind('country', 4)).toBe('land');
    expect(placeKind('state', 8)).toBe('region');
    expect(placeKind('village', 19)).toBe('ort');
    expect(placeKind('postcode', 21)).toBe('ort');
    expect(placeKind('road', 26)).toBe('strasse');
    expect(placeKind('building', 30)).toBe('adresse');
    expect(placeKind('place', 30)).toBe('adresse');
    expect(placeKind(undefined, 3)).toBe('land');
    expect(placeKind(undefined, 16)).toBe('stadt');
    expect(placeKind(undefined, undefined)).toBe('sonstiges');
  });

  it('URL mit Pflichtparametern und viewbox', () => {
    const u = new URL(buildSearchUrl('  Alexanderplatz ', [13.1, 52.4, 13.7, 52.6]));
    expect(u.origin + u.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(u.searchParams.get('format')).toBe('jsonv2');
    expect(u.searchParams.get('q')).toBe('Alexanderplatz');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('accept-language')).toBe('de');
    expect(u.searchParams.get('viewbox')).toBe('13.100,52.400,13.700,52.600');
    expect(u.searchParams.get('bounded')).toBe('0');
  });
});

describe('Koordinaten-Eingabe', () => {
  it.each([
    ['52.52, 13.40', 52.52, 13.4],
    ['52.52 13.40', 52.52, 13.4],
    ['52.52,13.40', 52.52, 13.4],
    ['52,52; 13,40', 52.52, 13.4],
    ['52,52 13,40', 52.52, 13.4],
    ['-33.86, 151.21', -33.86, 151.21],
    ['  40.7128°, -74.006° ', 40.7128, -74.006],
  ])('%s', (q, lat, lng) => {
    expect(parseCoords(q)).toEqual({ lat, lng });
  });

  it.each(['10115', '10115 Berlin', 'Berlin', '95.0, 13.4', '52.5, 190', '52.5; 13.4; 1', '', 'Hauptstraße 5'])('keine Koordinaten: %s', (q) => {
    expect(parseCoords(q)).toBeNull();
  });

  it('Koordinaten gehen nicht ans Netz', async () => {
    let calls = 0;
    const c = new GeocodeClient({ fetchFn: async () => { calls++; return jsonRes([]); }, store: memStore().store });
    const r = await c.search('52.52, 13.40');
    expect(r.status).toBe('ok');
    expect(r.source).toBe('koordinaten');
    expect(r.places[0]).toMatchObject({ lat: 52.52, lng: 13.4 });
    expect(calls).toBe(0);
  });
});

describe('GeocodeClient', () => {
  it('Cache: zweite Anfrage (auch anders geschrieben) ohne Netz, Store wird befüllt', async () => {
    const clock = fakeClock();
    const { m, store } = memStore();
    let calls = 0;
    const c = new GeocodeClient({ fetchFn: async () => { calls++; return jsonRes([BERLIN]); }, store, ...clock });
    const a = await c.search('Berlin');
    const b = await c.search('  berlin ');
    expect(a.status).toBe('ok');
    expect(a.source).toBe('netz');
    expect(b.source).toBe('cache');
    expect(calls).toBe(1);
    expect(m.has(normalizeQuery('Berlin'))).toBe(true);
  });

  it('Treffer aus dem Store (z. B. nach Neuladen) ohne Netz, abgelaufene nicht', async () => {
    const clock = fakeClock();
    const { m, store } = memStore();
    m.set('berlin', { places: parseNominatim([BERLIN]), t: clock.now() - 1000 });
    m.set('paris', { places: [], t: clock.now() - 40 * 24 * 3600 * 1000 });
    let calls = 0;
    const c = new GeocodeClient({ fetchFn: async () => { calls++; return jsonRes([]); }, store, ...clock });
    expect((await c.search('Berlin')).source).toBe('cache');
    expect(calls).toBe(0);
    expect((await c.search('Paris')).source).toBe('netz');
    expect(calls).toBe(1);
  });

  it('keine Treffer → leer (und wird gecacht)', async () => {
    let calls = 0;
    const c = new GeocodeClient({ fetchFn: async () => { calls++; return jsonRes([]); }, store: memStore().store, ...fakeClock() });
    expect((await c.search('xyzzy')).status).toBe('leer');
    expect((await c.search('xyzzy')).status).toBe('leer');
    expect(calls).toBe(1);
  });

  it('Mindestabstand ≥ 1100 ms zwischen Anfragen', async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const c = new GeocodeClient({ fetchFn: async () => { times.push(clock.now()); return jsonRes([BERLIN]); }, store: memStore().store, ...clock });
    await Promise.all([c.search('a'), c.search('b'), c.search('c')]);
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1100);
  });

  it('429 mit Retry-After: wartet und versucht erneut', async () => {
    const clock = fakeClock();
    const res = [jsonRes({}, 429, { 'Retry-After': '3' }), jsonRes([BERLIN])];
    const status: string[] = [];
    const c = new GeocodeClient({ fetchFn: async () => res.shift()!, store: memStore().store, onStatus: (s) => status.push(s), ...clock });
    const r = await c.search('Berlin');
    expect(r.status).toBe('ok');
    expect(clock.sleeps).toContain(3000);
    expect(status[0]).toMatch(/ausgelastet/);
  });

  it('429 ohne Retry-After: 5 s, nach zwei Wiederholungen ratenlimit', async () => {
    const clock = fakeClock();
    let calls = 0;
    const c = new GeocodeClient({ fetchFn: async () => { calls++; return jsonRes({}, 429); }, store: memStore().store, ...clock });
    const r = await c.search('Berlin');
    expect(r.status).toBe('ratenlimit');
    expect(calls).toBe(3);
    expect(clock.sleeps.filter((s) => s === 5000)).toHaveLength(2);
  });

  it('Ratenlimit wird nicht gecacht', async () => {
    const clock = fakeClock();
    const res = [jsonRes({}, 429), jsonRes({}, 429), jsonRes({}, 429), jsonRes([BERLIN])];
    const c = new GeocodeClient({ fetchFn: async () => res.shift()!, store: memStore().store, ...clock });
    expect((await c.search('Berlin')).status).toBe('ratenlimit');
    expect((await c.search('Berlin')).status).toBe('ok');
  });

  it('Netzfehler → offline, HTTP-Fehler → fehler', async () => {
    const c1 = new GeocodeClient({ fetchFn: async () => { throw new TypeError('Failed to fetch'); }, store: memStore().store, ...fakeClock() });
    expect((await c1.search('Berlin')).status).toBe('offline');
    const c2 = new GeocodeClient({ fetchFn: async () => jsonRes({}, 500), store: memStore().store, ...fakeClock() });
    expect(await c2.search('Berlin')).toMatchObject({ status: 'fehler', message: 'HTTP 500' });
  });
});

describe('Kamera für Treffer', () => {
  const place = (bbox: [number, number, number, number], kind: Place['kind'], lng = 0, lat = 0): Place =>
    ({ name: 'x', label: 'x', lng, lat, bbox, kind });

  it('bbox mit Höchstzoom je Ortstyp', () => {
    expect(placeCamera(parseNominatim([BERLIN])[0])).toEqual({
      type: 'bounds', bounds: [[13.088345, 52.3382448], [13.7611609, 52.6755087]], maxZoom: KIND_ZOOM.stadt,
    });
    expect(placeCamera(place([13.4, 52.5, 13.41, 52.51], 'adresse'))).toMatchObject({ type: 'bounds', maxZoom: 18 });
  });

  it('Punkt-bbox → Mittelpunkt mit Zoom des Ortstyps', () => {
    expect(placeCamera(place([13.4, 52.5, 13.4, 52.5], 'adresse', 13.4, 52.5))).toEqual({ type: 'center', center: [13.4, 52.5], zoom: 18 });
  });

  it('riesige bbox oder Antimeridian → Mittelpunkt mit Zoom 5', () => {
    // Frankreich mit Überseegebieten
    expect(placeCamera(place([-178.3, -50.2, 172.3, 51.1], 'land', 2.3, 46.6))).toEqual({ type: 'center', center: [2.3, 46.6], zoom: 5 });
    // über den Antimeridian (West > Ost)
    expect(placeCamera(place([177, -21, -178, -12], 'land', 178, -17))).toMatchObject({ type: 'center', zoom: 5 });
  });
});
