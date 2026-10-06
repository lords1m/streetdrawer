import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import './style.css';
import { CLASS_MAIN, CLASS_PATH, CLASS_STREET } from './core/graph';
import { metersPerPixel } from './core/geo';
import { GrowF64, GrowU32 } from './core/grow';
import type { LineBatch, Slot, Stroke } from './core/types';
import { exportPng, exportSvg } from './export';
import { kindToClass, makeStyle, roadLayerIds, type Theme } from './map-style';
import { NetClient } from './net-client';
import { eraseStrokes } from './erase';
import { initImport } from './import-ui';

// ---------------------------------------------------------------- Zustand
type Tool = 'pen' | 'eraser' | 'pan';
const SWATCHES = ['#e8590c', '#c2255c', '#7048e8', '#1971c2', '#0c8599', '#2f9e44', '#f08c00', '#212529', '#ffffff'];

export const state = {
  tool: 'pen' as Tool,
  color: SWATCHES[0],
  width: 6,
  snapPx: 28,
  eraserPx: 24,
  classes: { main: true, street: true, path: true },
  netSlot: 'tiles' as Slot,
  theme: (localStorage.getItem('sz-theme') as Theme | null) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  labels: true,
  showNet: false,
  pmtilesUrl: new URL('berlin.pmtiles', location.href).toString(),
  overpass: false,
  thin: true,
};

let strokes: Stroke[] = [];
let history: Stroke[][] = [[]];
let histIdx = 0;
let nextStrokeId = 1;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
export const setStatus = (s: string) => { statusEl.textContent = s; };

// ---------------------------------------------------------------- Karte
if (import.meta.env.PROD) maplibregl.setWorkerUrl(workerUrl);
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const net = new NetClient();

document.documentElement.dataset.theme = state.theme;

const map = new maplibregl.Map({
  container: 'map',
  style: makeStyle(state.theme, state.pmtilesUrl, state.labels),
  center: [13.405, 52.52],
  zoom: 13,
  maxZoom: 19,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  renderWorldCopies: false,
  attributionControl: { compact: true },
  fadeDuration: 0,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

let roadIds: string[] = [];
let netKey = '';
let netBusy = false;
export const netInfo: Record<Slot, string> = { tiles: '', import: '' };

function installOverlays() {
  const emptyFc = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
  if (!map.getSource('strokes')) map.addSource('strokes', { type: 'geojson', data: strokesToFc(strokes) });
  if (!map.getSource('preview')) map.addSource('preview', { type: 'geojson', data: emptyFc });
  if (!map.getLayer('strokes-line')) {
    map.addLayer({
      id: 'strokes-line', type: 'line', source: 'strokes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
    });
  }
  if (!map.getLayer('preview-line')) {
    map.addLayer({
      id: 'preview-line', type: 'line', source: 'preview',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.75 },
    });
  }
  roadIds = roadLayerIds(map.getStyle() as never);
}

map.on('style.load', () => { installOverlays(); netKey = ''; });
map.on('load', () => { installOverlays(); scheduleNetRefresh(); });

function strokesToFc(list: Stroke[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: list.map((s) => ({
      type: 'Feature', properties: { color: s.color, width: s.width, id: s.id },
      geometry: { type: 'MultiLineString', coordinates: s.parts.map(flatToCoords) },
    })),
  };
}
function flatToCoords(p: Float64Array | number[]): number[][] {
  const out: number[][] = new Array(p.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = [p[2 * i], p[2 * i + 1]];
  return out;
}
const refreshStrokes = () => (map.getSource('strokes') as maplibregl.GeoJSONSource | undefined)?.setData(strokesToFc(strokes));

// ---------------------------------------------------------------- Straßennetz aus Kacheln
let refreshTimer = 0;
export function scheduleNetRefresh(delay = 200) {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshNet(), delay);
}
map.on('idle', () => scheduleNetRefresh(120));
map.on('moveend', () => scheduleNetRefresh(250));

export let extraLines: LineBatch | null = null;
export function setExtraLines(b: LineBatch | null) { extraLines = b; netKey = ''; scheduleNetRefresh(0); }

function collectTileNetwork(): LineBatch | null {
  if (!roadIds.length) return null;
  const feats = map.queryRenderedFeatures(undefined, { layers: roadIds });
  const coords = new GrowF64(1 << 16), offsets = new GrowU32(1 << 12);
  const cls: number[] = [];
  const addLine = (line: number[][], c: number) => {
    if (line.length < 2) return;
    offsets.push(coords.n / 2);
    for (const p of line) { coords.push(p[0]); coords.push(p[1]); }
    cls.push(c);
  };
  for (const f of feats) {
    const c = kindToClass(f.properties?.kind);
    if (c === null) continue;
    const g = f.geometry;
    if (g.type === 'LineString') addLine(g.coordinates as number[][], c);
    else if (g.type === 'MultiLineString') for (const l of g.coordinates as number[][][]) addLine(l, c);
  }
  if (extraLines && extraLines.kind === 'lnglat') {
    for (let i = 0; i < extraLines.cls.length; i++) {
      offsets.push(coords.n / 2);
      for (let k = extraLines.offsets[i]; k < extraLines.offsets[i + 1]; k++) { coords.push(extraLines.coords[2 * k]); coords.push(extraLines.coords[2 * k + 1]); }
      cls.push(extraLines.cls[i]);
    }
  }
  if (!cls.length) return null;
  offsets.push(coords.n / 2);
  return { coords: coords.toArray(), offsets: offsets.toArray(), cls: Uint8Array.from(cls), kind: 'lnglat' };
}

async function refreshNet(force = false) {
  if (netBusy || drawing || !map.loaded()) { if (!drawing) scheduleNetRefresh(300); return; }
  const c = map.getCenter();
  const key = `${c.lng.toFixed(5)},${c.lat.toFixed(5)},${map.getZoom().toFixed(2)},${map.getCanvas().width},${state.pmtilesUrl},${extraLines?.cls.length ?? 0}`;
  if (!force && key === netKey) return;
  const batch = collectTileNetwork();
  netKey = key;
  if (!batch) { netInfo.tiles = 'Keine Straßen im Ausschnitt'; updateNetInfo(); return; }
  netBusy = true;
  try {
    const st = await net.setNetwork('tiles', batch, { snap: 0.6, planarize: true, tee: 1.0, gap: 0 });
    netInfo.tiles = `${st.edges.toLocaleString('de')} Segmente · ${st.nodes.toLocaleString('de')} Knoten · ${st.ms.toFixed(0)} ms`;
    updateNetInfo();
    if (state.showNet && state.netSlot === 'tiles') void showNetOverlay();
  } catch (e) {
    setStatus('Netzaufbau fehlgeschlagen: ' + (e as Error).message);
  } finally { netBusy = false; }
}

function updateNetInfo() {
  $('netinfo').textContent = netInfo[state.netSlot] || 'Netz wird aufgebaut …';
}

// ---------------------------------------------------------------- Netz-Overlay (deck.gl)
let overlay: import('@deck.gl/mapbox').MapboxOverlay | null = null;
async function showNetOverlay() {
  const [{ MapboxOverlay }, { LineLayer }] = await Promise.all([import('@deck.gl/mapbox'), import('@deck.gl/layers')]);
  if (!overlay) {
    overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay as unknown as maplibregl.IControl);
  }
  if (!state.showNet) { overlay.setProps({ layers: [] }); return; }
  const o = await net.overlay(state.netSlot);
  const n = o.cls.length;
  overlay.setProps({
    layers: [new LineLayer({
      id: 'net-overlay',
      data: { length: n, attributes: { getSourcePosition: { value: o.src, size: 2 }, getTargetPosition: { value: o.dst, size: 2 } } } as never,
      getColor: state.theme === 'dark' ? [255, 255, 255, 140] : [20, 20, 20, 140],
      getWidth: 1.2, widthUnits: 'pixels', pickable: false,
    })],
  });
}

// ---------------------------------------------------------------- Zeichnen
let drawing = false;
let pointers = new Set<number>();
let curSid = 0;
let rawLL: number[] = [];       // lng,lat Roh-Punkt
let sentUpTo = 0;
let inFlight = false;
let flushQueued = false;
let chain: Promise<void> = Promise.resolve();
let curParts: Float64Array[] = [];
let eraseWork: Stroke[] | null = null;
let lastEraseCount = 0;
const cont = map.getCanvasContainer();
const rawCanvas = $('raw') as HTMLCanvasElement;
const rawCtx = rawCanvas.getContext('2d')!;
let spaceHeld = false;

function resizeRaw() {
  const r = window.devicePixelRatio || 1;
  rawCanvas.width = Math.round(rawCanvas.clientWidth * r);
  rawCanvas.height = Math.round(rawCanvas.clientHeight * r);
  drawRaw();
}
window.addEventListener('resize', resizeRaw);

function drawRaw() {
  const r = window.devicePixelRatio || 1;
  rawCtx.setTransform(r, 0, 0, r, 0, 0);
  rawCtx.clearRect(0, 0, rawCanvas.clientWidth, rawCanvas.clientHeight);
  if (!drawing || rawLL.length < 2) return;
  if (state.tool === 'eraser') {
    // Radierer: nur Kreis an der letzten Position
    const p = map.project([rawLL[rawLL.length - 2], rawLL[rawLL.length - 1]]);
    rawCtx.strokeStyle = state.theme === 'dark' ? '#fff' : '#000';
    rawCtx.lineWidth = 1.5;
    rawCtx.beginPath(); rawCtx.arc(p.x, p.y, state.eraserPx, 0, Math.PI * 2); rawCtx.stroke();
    return;
  }
  rawCtx.strokeStyle = state.color; rawCtx.globalAlpha = 0.35;
  rawCtx.lineWidth = Math.max(1, state.width); rawCtx.lineCap = 'round'; rawCtx.lineJoin = 'round';
  rawCtx.beginPath();
  for (let i = 0; i < rawLL.length; i += 2) {
    const p = map.project([rawLL[i], rawLL[i + 1]]);
    if (i === 0) rawCtx.moveTo(p.x, p.y); else rawCtx.lineTo(p.x, p.y);
  }
  rawCtx.stroke();
  rawCtx.globalAlpha = 1;
}
map.on('move', () => { if (drawing) drawRaw(); });

function setTool(t: Tool) {
  state.tool = t;
  for (const id of ['pen', 'eraser', 'pan']) $('t-' + id).classList.toggle('active', id === t);
  applyInteraction();
}
function applyInteraction() {
  const panning = state.tool === 'pan' || spaceHeld;
  if (panning) map.dragPan.enable(); else map.dragPan.disable();
  if (panning) map.doubleClickZoom.enable(); else map.doubleClickZoom.disable();
  cont.classList.toggle('draw-pen', !panning && state.tool === 'pen');
  cont.classList.toggle('draw-eraser', !panning && state.tool === 'eraser');
}

/** Klassenmaske aus Auswahl; für Import-Netze mit Hierarchie zusätzlich nach Zoom ausgedünnt (PDF: aus). */
const activeMask = () => {
  const user = (state.classes.main ? 1 << CLASS_MAIN : 0) | (state.classes.street ? 1 << CLASS_STREET : 0) | (state.classes.path ? 1 << CLASS_PATH : 0);
  if (state.netSlot !== 'import' || !state.thin) return user;
  const z = map.getZoom();
  return user & (z < 12.5 ? 1 : z < 14.5 ? 3 : 7);
};

function relPos(e: PointerEvent) {
  const r = cont.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top] as const;
}

function addRawPoint(e: PointerEvent) {
  const [x, y] = relPos(e);
  const ll = map.unproject([x, y]);
  rawLL.push(ll.lng, ll.lat);
  if (state.tool === 'eraser' && eraseWork) {
    eraseWork = eraseStrokes(eraseWork, map, [[x, y]], state.eraserPx);
  }
}

function onDown(e: PointerEvent) {
  if (state.tool === 'pan' || spaceHeld) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  pointers.add(e.pointerId);
  if (pointers.size > 1) { cancelStroke(); return; }   // zweiter Finger: Zoom-Geste
  e.preventDefault();
  try { cont.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  drawing = true;
  rawLL = []; sentUpTo = 0; curParts = [];
  curSid = ++nextStrokeId;
  if (state.tool === 'eraser') { eraseWork = strokes; lastEraseCount = 0; }
  addRawPoint(e);
  if (state.tool === 'eraser') applyErase();
  else scheduleFlush();
  drawRaw();
}

function onMove(e: PointerEvent) {
  if (!drawing || !pointers.has(e.pointerId)) return;
  const evs = (e.getCoalescedEvents?.() ?? []).filter(Boolean);
  for (const ev of evs.length ? evs : [e]) addRawPoint(ev);
  if (state.tool === 'eraser') applyErase();
  else scheduleFlush();
  drawRaw();
}

function onUp(e: PointerEvent) {
  if (!pointers.delete(e.pointerId) || !drawing) return;
  try { cont.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (state.tool === 'eraser') { finishErase(); return; }
  finishStroke();
}

function onCancel(e: PointerEvent) {
  pointers.delete(e.pointerId);
  if (drawing) cancelStroke();
}

cont.addEventListener('pointerdown', onDown);
cont.addEventListener('pointermove', onMove);
cont.addEventListener('pointerup', onUp);
cont.addEventListener('pointercancel', onCancel);

function cancelStroke() {
  if (!drawing) return;
  drawing = false;
  rawLL = [];
  if (state.tool === 'pen') { net.drop(curSid); setPreview([]); }
  eraseWork = null;
  drawRaw();
}

function setPreview(parts: Float64Array[]) {
  const src = map.getSource('preview') as maplibregl.GeoJSONSource | undefined;
  src?.setData({
    type: 'FeatureCollection',
    features: parts.length ? [{
      type: 'Feature', properties: { color: state.color, width: state.width },
      geometry: { type: 'MultiLineString', coordinates: parts.map(flatToCoords) },
    }] : [],
  });
}

function scheduleFlush() {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => { flushQueued = false; void flush(false); });
}

/** Neue Rohpunkte an den Worker schicken; höchstens eine Anfrage gleichzeitig (Pipelining). */
async function flush(final: boolean) {
  if (inFlight && !final) return;
  if (!drawing && !final) return;
  const sid = curSid;
  const pts = Float64Array.from(rawLL.slice(sentUpTo));
  sentUpTo = rawLL.length;
  if (!pts.length && !final) return;
  inFlight = true;
  const radiusM = state.snapPx * metersPerPixel(map.getZoom(), map.getCenter().lat);
  try {
    const r = await net.feed(state.netSlot, sid, pts, radiusM, activeMask(), final);
    if (sid !== curSid) return;
    curParts = r.parts;
    lastMs = r.ms;
    if (!final) setPreview(r.parts);
  } catch (err) {
    setStatus('Matching-Fehler: ' + (err as Error).message);
  } finally {
    inFlight = false;
    if (!final && drawing && sentUpTo < rawLL.length) scheduleFlush();
  }
}
let lastMs = 0;

function finishStroke() {
  const sid = curSid;
  drawing = false;
  chain = chain.then(async () => {
    while (inFlight) await new Promise((r) => setTimeout(r, 2));
    // Rest senden und Session abschließen
    const radiusM = state.snapPx * metersPerPixel(map.getZoom(), map.getCenter().lat);
    const rest = Float64Array.from(rawLL.slice(sentUpTo));
    sentUpTo = rawLL.length;
    const r = await net.feed(state.netSlot, sid, rest, radiusM, activeMask(), true);
    if (r.parts.length) commit([...strokes, { id: sid, color: state.color, width: state.width, parts: r.parts }]);
    else setStatus('Kein Straßennetz in Fangreichweite – Fangradius erhöhen oder näher heranzoomen.');
    setPreview([]);
    rawLL = [];
    drawRaw();
  }).catch((e) => setStatus('Fehler: ' + e.message));
}

function applyErase() {
  if (!eraseWork) return;
  const src = map.getSource('strokes') as maplibregl.GeoJSONSource | undefined;
  src?.setData(strokesToFc(eraseWork));
  lastEraseCount++;
}
function finishErase() {
  drawing = false;
  const w = eraseWork; eraseWork = null;
  rawLL = [];
  drawRaw();
  if (w && w !== strokes) commit(w); else refreshStrokes();
}

// ---------------------------------------------------------------- Verlauf
function commit(next: Stroke[]) {
  strokes = next;
  history = history.slice(0, histIdx + 1);
  history.push(strokes);
  if (history.length > 200) history.shift();
  histIdx = history.length - 1;
  refreshStrokes(); updateButtons();
}
function undo() { if (histIdx > 0) { histIdx--; strokes = history[histIdx]; refreshStrokes(); updateButtons(); } }
function redo() { if (histIdx < history.length - 1) { histIdx++; strokes = history[histIdx]; refreshStrokes(); updateButtons(); } }
function updateButtons() {
  ($('undo') as HTMLButtonElement).disabled = histIdx === 0;
  ($('redo') as HTMLButtonElement).disabled = histIdx === history.length - 1;
  setStatus(`${strokes.length} ${strokes.length === 1 ? 'Strich' : 'Striche'}`);
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
  if (e.code === 'Space' && !spaceHeld) { spaceHeld = true; applyInteraction(); e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceHeld = false; applyInteraction(); } });

// ---------------------------------------------------------------- UI
function bindRange(id: string, out: string, key: 'width' | 'snapPx' | 'eraserPx') {
  const el = $(id) as HTMLInputElement;
  el.value = String(state[key]);
  $(out).textContent = el.value;
  el.addEventListener('input', () => { state[key] = Number(el.value); $(out).textContent = el.value; });
}
bindRange('width', 'o-width', 'width');
bindRange('snap', 'o-snap', 'snapPx');
bindRange('eraser', 'o-eraser', 'eraserPx');

const sw = $('swatches');
function setColor(c: string) {
  state.color = c;
  ($('color') as HTMLInputElement).value = c;
  sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.c === c));
}
for (const c of SWATCHES) {
  const b = document.createElement('button');
  b.style.background = c; b.dataset.c = c; b.title = c; b.setAttribute('aria-label', 'Farbe ' + c);
  b.addEventListener('click', () => setColor(c));
  sw.appendChild(b);
}
setColor(state.color);
$('color').addEventListener('input', (e) => setColor((e.target as HTMLInputElement).value));

for (const t of ['pen', 'eraser', 'pan'] as const) $('t-' + t).addEventListener('click', () => setTool(t));
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('clear').addEventListener('click', () => { if (strokes.length && confirm('Alle Striche löschen?')) commit([]); });
for (const [id, k] of [['c-main', 'main'], ['c-street', 'street'], ['c-path', 'path']] as const) {
  $(id).addEventListener('change', (e) => { state.classes[k] = (e.target as HTMLInputElement).checked; });
}

function applyTheme(t: Theme, reload = true) {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('sz-theme', t); } catch { /* ignore */ }
  if (reload) map.setStyle(makeStyle(t, state.pmtilesUrl, state.labels), { diff: false });
  if (state.showNet) void showNetOverlay();
}
$('theme').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
$('panel-toggle').addEventListener('click', () => $('panel').classList.toggle('closed'));
if (matchMedia('(max-width: 720px)').matches) $('panel').classList.add('closed');

$('labels').addEventListener('change', (e) => {
  state.labels = (e.target as HTMLInputElement).checked;
  map.setStyle(makeStyle(state.theme, state.pmtilesUrl, state.labels), { diff: false });
});
$('pm-load').addEventListener('click', () => {
  const v = ($('pm-url') as HTMLInputElement).value.trim();
  if (!v) return;
  state.pmtilesUrl = new URL(v, location.href).toString();
  map.setStyle(makeStyle(state.theme, state.pmtilesUrl, state.labels), { diff: false });
  setStatus('Karte: ' + state.pmtilesUrl);
});
$('shownet').addEventListener('change', (e) => { state.showNet = (e.target as HTMLInputElement).checked; void showNetOverlay(); });
document.querySelectorAll<HTMLInputElement>('input[name=netsrc]').forEach((r) => r.addEventListener('change', () => {
  state.netSlot = r.value as Slot; updateNetInfo(); if (state.showNet) void showNetOverlay();
}));

$('ex-png').addEventListener('click', () => void doExport('png'));
$('ex-svg').addEventListener('click', () => void doExport('svg'));
async function doExport(kind: 'png' | 'svg') {
  const o = {
    width: Number(($('ex-width') as HTMLInputElement).value) || 2000,
    padding: 0.06,
    background: ($('ex-bg') as HTMLSelectElement).value,
    zoom: map.getZoom(),
  };
  try {
    if (kind === 'png') await exportPng(strokes, o); else exportSvg(strokes, o);
    setStatus(`${kind.toUpperCase()} exportiert`);
  } catch (e) { setStatus((e as Error).message); }
}

// Overpass-Schalter und Import werden in import-ui verdrahtet
initImport({
  map, net, state, setStatus,
  showNetOverlay: () => void showNetOverlay(),
  setExtraLines,
  setImportAvailable(has: boolean, info: string) {
    ($('netsrc-import') as HTMLInputElement).disabled = !has;
    $('import-clear').hidden = !has;
    netInfo.import = info;
    if (has) { state.netSlot = 'import'; (document.querySelector('input[name=netsrc][value=import]') as HTMLInputElement).checked = true; }
    else { state.netSlot = 'tiles'; (document.querySelector('input[name=netsrc][value=tiles]') as HTMLInputElement).checked = true; }
    updateNetInfo();
    if (state.showNet) void showNetOverlay();
  },
});

setTool('pen');
resizeRaw();
updateButtons();
setStatus('Karte lädt …');
map.on('zoomend', () => { if (!drawing) setStatus(`${strokes.length} Striche · Zoom ${map.getZoom().toFixed(1)}`); });

// Testschnittstelle für Playwright
(window as unknown as { __sz: unknown }).__sz = {
  map, state, net,
  get strokes() { return strokes; },
  get lastMs() { return lastMs; },
  get netInfo() { return netInfo; },
  refreshNet: () => refreshNet(true),
};
void lastEraseCount;
