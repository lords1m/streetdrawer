import type * as maplibregl from 'maplibre-gl';
import type { LineBatch } from './core/types';
import { detectFormat, FORMAT_LABEL, type ImportFormat, type ImportOptions } from './import';
import type { ImportOut } from './workers/import.worker';
import type { NetClient } from './net-client';
import { OverpassClient, tilesFor, tilesToBatch } from './overpass';
import { openPdfImport } from './pdf-ui';

export interface ImportCtx {
  map: maplibregl.Map;
  net: NetClient;
  state: { overpass: boolean; [k: string]: unknown };
  setStatus: (s: string) => void;
  showNetOverlay: () => void;
  setImportAvailable: (has: boolean, info: string) => void;
  setExtraLines: (b: LineBatch | null) => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function batchBounds(b: LineBatch): [number, number, number, number] | null {
  if (b.kind !== 'lnglat' || !b.coords.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < b.coords.length; i += 2) {
    const x = b.coords[i], y = b.coords[i + 1];
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

export function initImport(ctx: ImportCtx) {
  const { map, net, setStatus } = ctx;
  const fileInput = $('file') as HTMLInputElement;
  const progress = $('progress') as HTMLProgressElement;
  const msg = $('import-msg');
  const dlg = $('import-dialog') as HTMLDialogElement;

  $('import-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) await startImport(f);
  });
  // Drag & Drop auf die Seite
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void startImport(f);
  });

  $('import-clear').addEventListener('click', async () => {
    await net.clear('import');
    ctx.setImportAvailable(false, '');
    msg.textContent = '';
    setStatus('Import entfernt');
  });

  /** Eine fertige Linien-Menge als Import-Netz übernehmen. */
  async function adoptBatch(batch: LineBatch, label: string, build = { snap: 0.5, planarize: true, tee: 1.0, gap: 0 }) {
    const bounds = batchBounds(batch);
    const st = await net.setNetwork('import', batch, build);
    ctx.setImportAvailable(true, `${label}: ${st.edges.toLocaleString('de')} Segmente · ${st.nodes.toLocaleString('de')} Knoten · ${st.ms.toFixed(0)} ms`);
    if (bounds) {
      const v = map.getBounds();
      const inside = bounds[0] >= v.getWest() && bounds[2] <= v.getEast() && bounds[1] >= v.getSouth() && bounds[3] <= v.getNorth();
      if (!inside) map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 60, maxZoom: 17, duration: 600 });
    }
    msg.textContent = `${label}: fertig.`;
    setStatus(`${label} importiert – Netzquelle „Import“ aktiv`);
  }

  async function startImport(file: File) {
    msg.textContent = '';
    const fmt = await detectFormat(file);
    if (!fmt) { msg.textContent = 'Dateityp nicht erkannt.'; return; }
    if (fmt === 'pdf') { await openPdfImport({ ...ctx, adoptBatch, progress, msg }, file); return; }
    const opts = await askOptions(file, fmt);
    if (!opts) return;
    progress.hidden = false; progress.removeAttribute('value');
    msg.textContent = `${FORMAT_LABEL[fmt]} wird gelesen …`;
    const w = new Worker(new URL('./workers/import.worker.ts', import.meta.url), { type: 'module' });
    try {
      const batch = await new Promise<LineBatch>((resolve, reject) => {
        w.onmessage = (ev: MessageEvent<ImportOut>) => {
          const m = ev.data;
          if (m.op === 'progress') {
            if (m.fraction > 0) progress.value = m.fraction * 100; else progress.removeAttribute('value');
            if (m.text) msg.textContent = m.text;
          } else if (m.op === 'done') resolve(m.batch);
          else reject(new Error(m.message));
        };
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage({ op: 'import', file, options: opts });
      });
      await adoptBatch(batch, FORMAT_LABEL[fmt]);
    } catch (e) {
      msg.textContent = 'Import fehlgeschlagen: ' + (e as Error).message;
      setStatus('Import fehlgeschlagen');
    } finally {
      w.terminate();
      progress.hidden = true;
    }
  }

  function askOptions(file: File, fmt: ImportFormat): Promise<ImportOptions | null> {
    $('imp-title').textContent = `${FORMAT_LABEL[fmt]} importieren`;
    $('imp-info').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB – wird streamend gelesen, nie komplett im Speicher.`;
    $('imp-zoom-row').hidden = fmt !== 'pmtiles';
    $('imp-rings-row').hidden = fmt !== 'geojson';
    const big = file.size > 50 * 1048576 || fmt === 'osm-pbf';
    (dlg.querySelector(`input[name=imp-area][value=${big ? 'view' : 'all'}]`) as HTMLInputElement).checked = true;
    return new Promise((resolve) => {
      dlg.onclose = () => {
        if (dlg.returnValue !== 'ok') { resolve(null); return; }
        const area = (dlg.querySelector('input[name=imp-area]:checked') as HTMLInputElement).value;
        const b = map.getBounds();
        resolve({
          format: fmt,
          bbox: area === 'view' ? { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() } : undefined,
          zoom: Number(($('imp-zoom') as HTMLInputElement).value) || 14,
          includeRings: ($('imp-rings') as HTMLInputElement).checked,
        });
      };
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  // ---- Overpass-Ergänzung
  const ovp = new OverpassClient({ onStatus: setStatus });
  let ovpBusy = false;
  async function refreshOverpass() {
    if (!ctx.state.overpass) return;
    if (map.getZoom() < 17) { setStatus('Overpass: erst ab Zoom 17 aktiv'); ctx.setExtraLines(null); return; }
    if (ovpBusy) return;
    ovpBusy = true;
    try {
      const b = map.getBounds();
      const list = tilesFor({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
      if (list.length > 9) { setStatus('Overpass: Ausschnitt zu groß – weiter hineinzoomen'); return; }
      setStatus('Overpass: Ergänzung wird geladen …');
      ctx.setExtraLines(tilesToBatch(await ovp.tiles(list)));
      setStatus('Overpass-Ergänzung aktiv');
    } finally { ovpBusy = false; }
  }
  $('overpass').addEventListener('change', (e) => {
    ctx.state.overpass = (e.target as HTMLInputElement).checked;
    if (ctx.state.overpass) void refreshOverpass(); else ctx.setExtraLines(null);
  });
  map.on('moveend', () => { void refreshOverpass(); });
}

export type { ImportOptions };
