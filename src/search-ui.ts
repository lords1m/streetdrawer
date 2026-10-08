import type * as maplibregl from 'maplibre-gl';
import { GeocodeClient, KIND_ZOOM, type Place } from './geocode';
import { loadPref, savePref } from './prefs';

export interface SearchCtx {
  map: maplibregl.Map;
  setStatus: (s: string) => void;
  /** Nach jedem Sprung (Suche, letzte Suche, Standort): z. B. prüfen, ob die Karte dort Daten hat. */
  afterJump?: (lng: number, lat: number) => void;
}

export type Camera =
  | { type: 'bounds'; bounds: [[number, number], [number, number]]; maxZoom: number }
  | { type: 'center'; center: [number, number]; zoom: number };

/** Ausdehnung, ab der fitBounds nichts Sinnvolles mehr zeigt (Überseegebiete, Antimeridian). */
const HUGE_DEG = 60;
const MAX_RECENT = 5;

/** Kamera für einen Treffer: bbox mit Höchstzoom je Ortstyp; Punkt- und Riesen-bboxen über den Mittelpunkt. */
export function placeCamera(p: Place): Camera {
  const [w, s, e, n] = p.bbox;
  const maxZoom = KIND_ZOOM[p.kind];
  if (w > e || e - w > HUGE_DEG || n - s > HUGE_DEG) return { type: 'center', center: [p.lng, p.lat], zoom: Math.min(5, maxZoom) };
  if (e - w < 1e-6 && n - s < 1e-6) return { type: 'center', center: [p.lng, p.lat], zoom: maxZoom };
  return { type: 'bounds', bounds: [[w, s], [e, n]], maxZoom };
}

export function jumpTo(map: maplibregl.Map, p: Place) {
  const c = placeCamera(p);
  if (c.type === 'bounds') map.fitBounds(c.bounds, { padding: 40, maxZoom: c.maxZoom, duration: 800 });
  else map.flyTo({ center: c.center, zoom: c.zoom, duration: 800 });
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initSearch(ctx: SearchCtx) {
  const { map, setStatus } = ctx;
  const form = $('search') as HTMLFormElement;
  const input = $('search-q') as HTMLInputElement;
  const pop = $('search-pop');
  const list = $('search-list');
  const recentEl = $('recent');
  const geo = new GeocodeClient({ onStatus: setStatus });

  let results: Place[] = [];
  let active = -1;
  let busy = false;
  let recent = loadPref<Place[]>('recent', []).filter((p) => p && Array.isArray(p.bbox)).slice(0, MAX_RECENT);

  // ---- Trefferliste (Combobox/Listbox)
  function render() {
    list.replaceChildren(...results.map((p, i) => {
      const li = document.createElement('li');
      li.id = 'search-opt-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.className = i === active ? 'on' : '';
      const b = document.createElement('strong'); b.textContent = p.name;
      const sm = document.createElement('small'); sm.textContent = p.label;
      li.append(b, sm);
      // mousedown statt click: das Feld verliert sonst vorher den Fokus und die Liste schließt sich
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      return li;
    }));
    const open = results.length > 0;
    pop.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', 'search-opt-' + active);
    else input.removeAttribute('aria-activedescendant');
  }
  function close() { results = []; active = -1; render(); }

  function choose(i: number) {
    const p = results[i];
    if (!p) return;
    close();
    go(p);
  }

  /** Meldung erst nach der Kamerafahrt setzen, sonst überschreibt sie die Zoom-Anzeige in main.ts. */
  function arrive(msg: string, lng: number, lat: number) {
    map.once('moveend', () => {
      setStatus(msg);
      ctx.afterJump?.(lng, lat);
    });
  }

  function go(p: Place) {
    arrive(`Karte: ${p.label}`, p.lng, p.lat);
    jumpTo(map, p);
    if (p.name !== 'Koordinaten') remember(p);
  }

  async function search() {
    const q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    form.classList.add('busy');
    setStatus(`Suche „${q}“ …`);
    try {
      const b = map.getBounds();
      const r = await geo.search(q, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      switch (r.status) {
        case 'ok':
          if (r.places.length === 1) { close(); go(r.places[0]); }
          else { results = r.places; active = 0; render(); setStatus(`${r.places.length} Treffer – mit ↑/↓ wählen, Enter übernimmt`); }
          break;
        case 'leer': close(); setStatus(`Keine Treffer für „${q}“`); break;
        case 'offline': close(); setStatus('Offline – Suche nicht möglich'); break;
        case 'ratenlimit': close(); setStatus('Suchdienst ausgelastet, bitte kurz warten'); break;
        default: close(); setStatus(`Suche fehlgeschlagen${r.message ? ` (${r.message})` : ''}`);
      }
    } finally {
      busy = false;
      form.classList.remove('busy');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (results.length && active >= 0) choose(active); else void search();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + d + results.length) % results.length;
      render();
    } else if (e.key === 'Escape') {
      if (results.length) { e.preventDefault(); close(); } else input.blur();
    }
  });
  // geänderter Text: alte Treffer passen nicht mehr, Enter sucht neu
  input.addEventListener('input', () => { if (results.length) close(); });
  input.addEventListener('blur', () => close());

  // ---- Letzte Suchen
  function remember(p: Place) {
    recent = [p, ...recent.filter((r) => r.label !== p.label)].slice(0, MAX_RECENT);
    savePref('recent', recent);
    renderRecent();
  }
  function renderRecent() {
    recentEl.replaceChildren(...recent.map((p) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = p.name; b.title = p.label;
      b.addEventListener('click', () => go(p));
      li.append(b);
      return li;
    }));
    $('recent-wrap').hidden = recent.length === 0;
  }
  renderRecent();

  // ---- Mein Standort
  $('locate').addEventListener('click', () => {
    if (!('geolocation' in navigator)) { setStatus('Standortbestimmung wird von diesem Browser nicht unterstützt'); return; }
    setStatus('Standort wird bestimmt …');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude: lng, latitude: lat } = pos.coords;
        arrive(`Mein Standort (± ${Math.round(pos.coords.accuracy)} m)`, lng, lat);
        map.flyTo({ center: [lng, lat], zoom: 16, duration: 800 });
      },
      (err) => {
        setStatus(err.code === err.PERMISSION_DENIED ? 'Standortzugriff abgelehnt'
          : err.code === err.TIMEOUT ? 'Standortbestimmung dauert zu lange – bitte erneut versuchen'
            : 'Standort nicht verfügbar');
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });

  return { geo, search: (q: string) => { input.value = q; return search(); } };
}
