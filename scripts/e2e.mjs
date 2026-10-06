// Headless-Prüfung der Hauptpfade (Playwright). Start: npm run e2e
import { createServer, preview } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makePdf, drawAlong } from './e2e-helpers.mjs';

const out = process.env.E2E_OUT || path.join(os.tmpdir(), 'sz-e2e');
fs.mkdirSync(out, { recursive: true });
// E2E_PROD=1: gebautes Bundle (dist/) prüfen statt Dev-Server
const server = process.env.E2E_PROD
  ? await preview({ preview: { port: 5198, strictPort: false }, logLevel: 'warn' })
  : await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'warn' });
if (!process.env.E2E_PROD) await server.listen();
const base = (server.resolvedUrls ?? { local: ['http://localhost:5198/'] }).local[0];



const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(base);
  await page.waitForFunction(() => window.__sz && window.__sz.map.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => { window.__sz.map.jumpTo({ center: [13.4132, 52.5219], zoom: 15.5 }); });
  await page.waitForFunction(() => window.__sz.netInfo.tiles && window.__sz.netInfo.tiles.includes('Segmente'), null, { timeout: 60000 });
  const info = await page.evaluate(() => window.__sz.netInfo.tiles);
  check('Straßennetz aus PMTiles aufgebaut', true, info);

  // Straße suchen: längste sichtbare Linie
  const road = await page.evaluate(() => {
    const m = window.__sz.map;
    const ids = m.getStyle().layers.filter((l) => l['source-layer'] === 'roads' && l.type === 'line' && /major|highway|minor/.test(l.id) && !/casing/.test(l.id)).map((l) => l.id);
    const feats = m.queryRenderedFeatures(undefined, { layers: ids });
    let best = null, bl = 0;
    for (const f of feats) {
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      for (const l of lines) {
        const pts = l.map((c) => m.project(c));
        const inside = pts.filter((p) => p.x > 360 && p.x < 1100 && p.y > 150 && p.y < 700);
        if (inside.length < 3) continue;
        let len = 0;
        for (let i = 1; i < inside.length; i++) len += Math.hypot(inside[i].x - inside[i - 1].x, inside[i].y - inside[i - 1].y);
        if (len > bl) { bl = len; best = inside.map((p) => [p.x, p.y]); }
      }
    }
    return best;
  });
  check('Straße im Ausschnitt gefunden', !!road && road.length >= 3);
  const rect = await page.evaluate(() => { const r = document.getElementById('map').getBoundingClientRect(); return [r.left, r.top]; });

  // Strich mit Rauschen zeichnen (±8 px)
  let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff - 0.5; };
  const dense = [];
  for (let i = 1; i < road.length; i++) {
    const [x0, y0] = road[i - 1], [x1, y1] = road[i];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 6));
    for (let k = 0; k < n; k++) dense.push([x0 + ((x1 - x0) * k) / n + rnd() * 16, y0 + ((y1 - y0) * k) / n + rnd() * 16]);
  }
  await page.mouse.move(rect[0] + dense[0][0], rect[1] + dense[0][1]);
  await page.mouse.down();
  let maxPreview = 0;
  for (const [x, y] of dense) {
    await page.mouse.move(rect[0] + x, rect[1] + y);
    maxPreview = Math.max(maxPreview, await page.evaluate(() => window.__sz.lastMs));
  }
  await page.mouse.up();
  await page.waitForFunction(() => window.__sz.strokes.length === 1, null, { timeout: 10000 });
  check('Strich eingerastet und übernommen', true, `Vorschau max ${maxPreview.toFixed(1)} ms im Worker`);
  check('Vorschau < 30 ms (Worker)', maxPreview < 30, maxPreview.toFixed(1));

  // Abstand der eingerasteten Punkte zum Straßenverlauf (px)
  const dev = await page.evaluate((road) => {
    const m = window.__sz.map;
    const pts = window.__sz.strokes[0].parts.flatMap((p) => { const o = []; for (let i = 0; i < p.length; i += 2) o.push(m.project([p[i], p[i + 1]])); return o; });
    const seg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy; let t = l2 ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy)); };
    let worst = 0;
    for (const p of pts) { let best = Infinity; for (let i = 1; i < road.length; i++) best = Math.min(best, seg(p, road[i - 1], road[i])); worst = Math.max(worst, best); }
    return { n: pts.length, worst };
  }, road);
  check('Eingerastete Linie liegt auf der Straße', dev.n >= 2 && dev.worst < 14, `Punkte ${dev.n}, max. Abstand ${dev.worst.toFixed(2)} px`);

  await page.screenshot({ path: path.join(out, 'stroke.png') });

  // Export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ex-png')]);
  const pngPath = path.join(out, 'export.png'); await dl.saveAs(pngPath);
  const png = fs.readFileSync(pngPath);
  check('PNG-Export', png.length > 1000 && png.subarray(1, 4).toString() === 'PNG', `${png.length} Bytes`);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#ex-svg')]);
  const svgPath = path.join(out, 'export.svg'); await dl2.saveAs(svgPath);
  const svg = fs.readFileSync(svgPath, 'utf8');
  check('SVG-Export', svg.includes('<svg') && svg.includes('<path'), `${svg.length} Zeichen`);

  // Undo / Redo
  await page.click('#undo');
  check('Undo entfernt den Strich', (await page.evaluate(() => window.__sz.strokes.length)) === 0);
  await page.click('#redo');
  check('Redo stellt ihn wieder her', (await page.evaluate(() => window.__sz.strokes.length)) === 1);

  // Radierer
  await page.click('#t-eraser');
  const mid = dense[Math.floor(dense.length / 2)];
  await page.mouse.move(rect[0] + mid[0], rect[1] + mid[1]);
  await page.mouse.down();
  await page.mouse.move(rect[0] + mid[0] + 2, rect[1] + mid[1] + 2, { steps: 4 });
  await page.mouse.up();
  const parts = await page.evaluate(() => window.__sz.strokes.reduce((a, s) => a + s.parts.length, 0));
  check('Radierer teilt den Strich', parts >= 2, `Teile: ${parts}`);


  // ---------------- Import: GeoJSON-Gitter
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { window.__sz.map.jumpTo({ center: [13.4, 52.52], zoom: 15 }); });
  const feats = [];
  for (let i = -5; i <= 5; i++) {
    feats.push({ type: 'Feature', properties: { highway: 'residential' }, geometry: { type: 'LineString', coordinates: [[13.4 + i * 0.0025, 52.52 - 0.0125], [13.4 + i * 0.0025, 52.52 + 0.0125]] } });
    feats.push({ type: 'Feature', properties: { highway: 'residential' }, geometry: { type: 'LineString', coordinates: [[13.4 - 0.0125, 52.52 + i * 0.0015], [13.4 + 0.0125, 52.52 + i * 0.0015]] } });
  }
  await page.setInputFiles('#file', { name: 'raster.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: feats })) });
  await page.waitForSelector('#import-dialog[open]');
  await page.click('#imp-go');
  await page.waitForFunction(() => !document.getElementById('netsrc-import').disabled, null, { timeout: 30000 });
  const impInfo = await page.evaluate(() => window.__sz.netInfo.import);
  check('GeoJSON-Import erzeugt Netz', /Segmente/.test(impInfo), impInfo);
  await page.click('#t-pen');
  await drawAlong(page, rect, [[13.4 - 0.005, 52.52 + 0.0015], [13.4 + 0.005, 52.52 + 0.0015]], 7);
  const g1 = await page.evaluate(() => window.__sz.strokes.length);
  const gridOk = await page.evaluate(() => {
    const s = window.__sz.strokes[window.__sz.strokes.length - 1];
    return s.parts.every((p) => { for (let i = 1; i < p.length; i += 2) if (Math.abs((p[i] - 52.52) / 0.0015 - Math.round((p[i] - 52.52) / 0.0015)) > 1e-3 && Math.abs((p[i - 1] - 13.4) / 0.0025 - Math.round((p[i - 1] - 13.4) / 0.0025)) > 1e-3) return false; return true; });
  });
  check('Strich rastet im importierten Netz ein', g1 === 2 && gridOk, `Striche ${g1}`);
  await page.click('#import-clear');
  await page.waitForFunction(() => document.getElementById('netsrc-import').disabled);

  // ---------------- Import: PDF (Vektorgrafik) mit Maßstab aus dem Dateinamen
  await page.evaluate(() => { window.__sz.map.jumpTo({ center: [13.4, 52.52], zoom: 15 }); });
  const pdfBuf = makePdf();
  await page.setInputFiles('#file', { name: 'stadtplan_1_5000.pdf', mimeType: 'application/pdf', buffer: pdfBuf });
  await page.waitForSelector('#pdf-dialog[open]');
  await page.waitForFunction(() => !document.getElementById('pdf-go').disabled, null, { timeout: 30000 });
  const rows = await page.evaluate(() => document.querySelectorAll('#pdf-styles tr').length);
  const scaleVal = await page.inputValue('#pdf-scale');
  check('PDF: Ebenenstatistik und Maßstab erkannt', rows >= 2 && scaleVal === '5000', `${rows} Ebenen, 1:${scaleVal}`);
  await page.screenshot({ path: path.join(out, 'pdf-dialog.png') });
  await page.click('#pdf-go');
  await page.waitForFunction(() => !document.getElementById('netsrc-import').disabled, null, { timeout: 30000 });
  const pdfInfo = await page.evaluate(() => window.__sz.netInfo.import);
  check('PDF-Import erzeugt Netz', /PDF/.test(pdfInfo), pdfInfo);
  await page.waitForTimeout(800);
  // PDF-Gitter: Linien alle 40 pt bei 1:5000 (= 70,6 m); Strich entlang einer horizontalen Linie
  const pdfStroke = await page.evaluate(async () => {
    const m = window.__sz.map; const c = m.getCenter();
    return { c: [c.lng, c.lat] };
  });
  await drawAlong(page, rect, [[pdfStroke.c[0] - 0.0004, pdfStroke.c[1]], [pdfStroke.c[0] + 0.0004, pdfStroke.c[1]]], 5);
  check('Strich rastet im PDF-Netz ein', (await page.evaluate(() => window.__sz.strokes.length)) === 3);
  await page.screenshot({ path: path.join(out, 'pdf-net.png') });

  // Dunkelmodus
  await page.click('#theme');
  await page.waitForTimeout(1500);
  check('Dunkelmodus', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.screenshot({ path: path.join(out, 'dark.png') });

  // Handy-Ansicht
  await page.setViewportSize({ width: 390, height: 760 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'mobile.png') });

  check('Keine Konsolenfehler', errors.filter((e) => !/glyph|sprite|Failed to load resource|Could not compile fragment shader|protomaps\.github\.io/i.test(e)).length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('Ablauf', false, String(e) + ' | ' + errors.slice(-3).join(' ; ') + ' | ' + (await page.evaluate(() => document.getElementById('import-msg').textContent).catch(() => '')));
}
await browser.close();
if (server.close) await server.close(); else await new Promise((r) => server.httpServer.close(r));
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Ausgabe: ${out}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
