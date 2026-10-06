import type { BuildOptions } from './core/graph';
import type { LineBatch } from './core/types';
import type { PdfScan, StyleStat } from './pdf/analyze';
import { guessScale, pdfToNet } from './pdf/net';
import type { PdfIn, PdfOut } from './workers/pdf.worker';

export interface PdfCtx {
  map: import('maplibre-gl').Map;
  setStatus: (s: string) => void;
  adoptBatch: (b: LineBatch, label: string, build?: BuildOptions) => Promise<void>;
  progress: HTMLProgressElement;
  msg: HTMLElement;
  state: { thin?: boolean; [k: string]: unknown };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const css = (rgb: number) => '#' + rgb.toString(16).padStart(6, '0');

function callWorker<T extends PdfOut['op']>(w: Worker, msg: PdfIn, want: T, onProgress: (f: number, t?: string) => void): Promise<Extract<PdfOut, { op: T }>> {
  return new Promise((resolve, reject) => {
    w.onmessage = (ev: MessageEvent<PdfOut>) => {
      const m = ev.data;
      if (m.op === 'progress') onProgress(m.fraction, m.text);
      else if (m.op === 'error') reject(new Error(m.message));
      else if (m.op === want) resolve(m as never);
    };
    w.onerror = (e) => reject(new Error(e.message));
    w.postMessage(msg);
  });
}

/** Zwei Durchgänge: 1) Übersicht + Ebenenstatistik, 2) nur gewählte Ebenen im gewählten Ausschnitt. */
export async function openPdfImport(ctx: PdfCtx, file: File) {
  const dlg = $('pdf-dialog') as HTMLDialogElement;
  const canvas = $('pdf-canvas') as HTMLCanvasElement;
  const table = $('pdf-styles') as HTMLTableSectionElement;
  const prog = $('pdf-progress') as HTMLProgressElement;
  const info = $('pdf-info');
  const scaleIn = $('pdf-scale') as HTMLInputElement;
  const gapIn = $('pdf-gap') as HTMLInputElement;
  const pageIn = $('pdf-page') as HTMLInputElement;
  const widthCls = $('pdf-widthcls') as HTMLInputElement;
  const goBtn = $('pdf-go') as HTMLButtonElement;
  const resetSel = $('pdf-reset-sel') as HTMLButtonElement;

  const worker = new Worker(new URL('./workers/pdf.worker.ts', import.meta.url), { type: 'module' });
  let scan: PdfScan | null = null;
  let region: [number, number, number, number] | null = null;
  const selected = new Set<number>();
  let heat: HTMLCanvasElement | null = null;

  const guess = guessScale(file.name);
  scaleIn.value = String(guess ?? 5000);
  $('pdf-scale-hint').textContent = guess ? `aus Dateiname erkannt: 1:${guess}` : 'nicht erkennbar – bitte eintragen';
  $('pdf-title').textContent = `PDF importieren – ${file.name}`;
  pageIn.value = '1';
  table.innerHTML = '';
  goBtn.disabled = true;
  info.textContent = 'Analysiere …';
  prog.hidden = false; prog.removeAttribute('value');
  region = null;
  drawCanvas();

  async function doScan() {
    goBtn.disabled = true; prog.hidden = false; prog.value = 0;
    try {
      const r = await callWorker(worker, { op: 'scan', file, page: Math.max(0, (Number(pageIn.value) || 1) - 1) }, 'scanned', (f, t) => { prog.value = f * 100; if (t) info.textContent = t; });
      scan = r.scan;
      pageIn.max = String(scan.pageCount);
      info.textContent = `Seite ${scan.page + 1}/${scan.pageCount} · ${(scan.box[2] - scan.box[0]).toFixed(0)} × ${(scan.box[3] - scan.box[1]).toFixed(0)} pt · ${scan.operators.toLocaleString('de')} Operatoren · ${scan.paths.toLocaleString('de')} Pfade · ${(scan.ms / 1000).toFixed(1)} s${scan.recovered ? ' · Struktur wiederhergestellt' : ''}`;
      buildHeat(); fillTable(); drawCanvas();
      goBtn.disabled = selected.size === 0;
    } catch (e) {
      info.textContent = 'Analyse fehlgeschlagen: ' + (e as Error).message;
    } finally { prog.hidden = true; }
  }

  function buildHeat() {
    const d = scan!.density;
    heat = document.createElement('canvas');
    heat.width = d.nx; heat.height = d.ny;
    const g = heat.getContext('2d')!;
    const img = g.createImageData(d.nx, d.ny);
    let max = 1;
    for (const v of d.cells) if (v > max) max = v;
    const lmax = Math.log1p(max);
    for (let cy = 0; cy < d.ny; cy++) {
      for (let cx = 0; cx < d.nx; cx++) {
        const v = d.cells[cy * d.nx + cx];
        const o = ((d.ny - 1 - cy) * d.nx + cx) * 4; // PDF-y zeigt nach oben
        const t = v ? 0.25 + 0.75 * (Math.log1p(v) / lmax) : 0;
        img.data[o] = 255 - Math.round(200 * t); img.data[o + 1] = 255 - Math.round(150 * t); img.data[o + 2] = 255 - Math.round(60 * t); img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  function fillTable() {
    selected.clear();
    const total = scan!.paths || 1;
    const rows: StyleStat[] = scan!.styles;
    table.innerHTML = '';
    rows.forEach((s, i) => {
      const pre = s.kind === 'stroke' && s.paths / total >= 0.01;
      if (pre || (i === 0 && !rows.some((r) => r.kind === 'stroke' && r.paths / total >= 0.01))) selected.add(s.key);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input type="checkbox" ${selected.has(s.key) ? 'checked' : ''} aria-label="Ebene wählen"></td>
        <td><span class="sw" style="background:${css(s.rgb)}"></span></td>
        <td>${s.kind === 'stroke' ? s.width.toFixed(2).replace(/\.?0+$/, '') + ' pt' : 'Fläche'}</td>
        <td>${s.layer ? esc(s.layer) : '–'}</td>
        <td class="num">${s.paths.toLocaleString('de')}</td>`;
      tr.querySelector('input')!.addEventListener('change', (e) => {
        if ((e.target as HTMLInputElement).checked) selected.add(s.key); else selected.delete(s.key);
        goBtn.disabled = selected.size === 0;
      });
      table.appendChild(tr);
    });
  }

  // ---- Übersicht + Ausschnittsauswahl
  function drawCanvas() {
    const r = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 360, ch = canvas.clientHeight || 260;
    canvas.width = Math.round(cw * r); canvas.height = Math.round(ch * r);
    const g = canvas.getContext('2d')!;
    g.setTransform(r, 0, 0, r, 0, 0);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--line') || '#ddd';
    g.fillRect(0, 0, cw, ch);
    if (!scan || !heat) return;
    const lay = layout(cw, ch);
    g.imageSmoothingEnabled = false;
    g.drawImage(heat, lay.x, lay.y, lay.w, lay.h);
    g.strokeStyle = '#888'; g.strokeRect(lay.x + 0.5, lay.y + 0.5, lay.w, lay.h);
    if (region) {
      const [x0, y0] = pageToCanvas(region[0], region[3], lay), [x1, y1] = pageToCanvas(region[2], region[1], lay);
      g.fillStyle = 'rgba(232,89,12,.18)'; g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = '#e8590c'; g.lineWidth = 2; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  function layout(cw: number, ch: number) {
    const b = scan!.box, w = b[2] - b[0], h = b[3] - b[1];
    const k = Math.min(cw / w, ch / h);
    return { x: (cw - w * k) / 2, y: (ch - h * k) / 2, w: w * k, h: h * k, k };
  }
  function pageToCanvas(px: number, py: number, lay: ReturnType<typeof layout>): [number, number] {
    const b = scan!.box;
    return [lay.x + (px - b[0]) * lay.k, lay.y + (b[3] - py) * lay.k];
  }
  function canvasToPage(cx: number, cy: number, lay: ReturnType<typeof layout>): [number, number] {
    const b = scan!.box;
    return [b[0] + (cx - lay.x) / lay.k, b[3] - (cy - lay.y) / lay.k];
  }
  let dragStart: [number, number] | null = null;
  const pos = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.onpointerdown = (e) => { if (!scan) return; dragStart = pos(e); canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = (e) => {
    if (!dragStart || !scan) return;
    const lay = layout(canvas.clientWidth, canvas.clientHeight);
    const a = canvasToPage(...dragStart, lay), b = canvasToPage(...pos(e), lay);
    const bx = scan.box;
    region = [Math.max(bx[0], Math.min(a[0], b[0])), Math.max(bx[1], Math.min(a[1], b[1])), Math.min(bx[2], Math.max(a[0], b[0])), Math.min(bx[3], Math.max(a[1], b[1]))];
    drawCanvas();
  };
  canvas.onpointerup = () => { dragStart = null; if (region && (region[2] - region[0] < 1 || region[3] - region[1] < 1)) region = null; drawCanvas(); };
  resetSel.onclick = () => { region = null; drawCanvas(); };
  pageIn.onchange = () => { void doScan(); };
  // Enter in einem Feld übernimmt nur den Wert (Seite neu analysieren), statt den Dialog abzuschicken
  dlg.querySelector('form')!.onkeydown = (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t instanceof HTMLInputElement) { e.preventDefault(); t.dispatchEvent(new Event('change')); }
  };

  dlg.showModal();
  requestAnimationFrame(drawCanvas);
  void doScan();

  const result = await new Promise<'ok' | 'cancel'>((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? 'ok' : 'cancel');
  });
  const done = scan as PdfScan | null;
  if (result !== 'ok' || !done) { worker.terminate(); return; }

  // ---- Durchgang 2
  ctx.progress.hidden = false; ctx.progress.removeAttribute('value');
  ctx.msg.textContent = 'PDF: gewählte Ebenen werden eingelesen …';
  try {
    const keys = [...selected];
    const r = await callWorker(worker, { op: 'extract', file, page: done.page, keys, region }, 'extracted', (f, t) => { ctx.progress.value = f * 100; if (t) ctx.msg.textContent = 'PDF: ' + t; });
    const c = ctx.map.getCenter();
    const net = pdfToNet(r.ex, {
      scale: Math.max(1, Number(scaleIn.value) || 5000), gapPt: Math.max(0, Number(gapIn.value) || 0),
      classFromWidth: widthCls.checked, center: [c.lng, c.lat],
    });
    if (!net.batch.cls.length) throw new Error('Im gewählten Ausschnitt/Ebenen wurden keine Linien gefunden.');
    ctx.msg.textContent = 'PDF: Netz wird aufgebaut (Kreuzungen, T-Stöße, Lücken) …';
    // PDF-Netze haben keine Straßenhierarchie: Ausdünnung nach Zoom aus
    ctx.state.thin = false;
    const thin = document.getElementById('thin') as HTMLInputElement | null;
    if (thin) thin.checked = false;
    await ctx.adoptBatch(net.batch, 'PDF', net.build);
    ctx.map.easeTo({ zoom: Math.max(ctx.map.getZoom(), 15), duration: 0 });
  } catch (e) {
    ctx.msg.textContent = 'PDF-Import fehlgeschlagen: ' + (e as Error).message;
    ctx.setStatus('PDF-Import fehlgeschlagen');
  } finally {
    worker.terminate();
    ctx.progress.hidden = true;
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
