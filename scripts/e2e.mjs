// Headless-Prüfung der Hauptpfade (Playwright). Start: npm run e2e
import { createServer, preview } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makePdf, drawAlong, findRoad, densify, mockNominatim } from './e2e-helpers.mjs';

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

// CHROMIUM_PATH: vorinstalliertes Chromium statt des zur Playwright-Version passenden
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
// Weltkarte gesperrt: prüft den Fallback auf berlin.pmtiles und hält den Test unabhängig vom Bucket
await ctx.route('https://storage.googleapis.com/**', (r) => r.abort());
// Nominatim-Attrappe (Ziele liegen im Berlin-Ausschnitt 13.08,52.33,13.77,52.68 – außer Paris)
const nominatim = await mockNominatim(ctx, {
  'tempelhofer damm': [{ lat: '52.4840', lon: '13.3855', name: 'Tempelhofer Damm', display_name: 'Tempelhofer Damm, Tempelhof, Berlin, Deutschland', boundingbox: ['52.4820', '52.4860', '13.3835', '13.3875'], addresstype: 'road', place_rank: 26 }],
  'paris': [{ lat: '48.8566', lon: '2.3522', name: 'Paris', display_name: 'Paris, Île-de-France, Frankreich', boundingbox: ['48.8155', '48.9021', '2.2241', '2.4697'], addresstype: 'city', place_rank: 12 }],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(base);
  await page.waitForFunction(() => window.__sz && window.__sz.map.loaded(), null, { timeout: 60000 });
  check('Weltkarte nicht erreichbar → Berlin-Fallback', (await page.evaluate(() => window.__sz.state.pmtilesUrl)).endsWith('/berlin.pmtiles'), await page.textContent('#status'));
  await page.evaluate(() => { window.__sz.map.jumpTo({ center: [13.4132, 52.5219], zoom: 15.5 }); });
  await page.waitForFunction(() => window.__sz.netInfo.tiles && window.__sz.netInfo.tiles.includes('Segmente'), null, { timeout: 60000 });
  const info = await page.evaluate(() => window.__sz.netInfo.tiles);
  check('Straßennetz aus PMTiles aufgebaut', true, info);

  // Straße suchen: längste sichtbare Linie
  const road = await findRoad(page);
  check('Straße im Ausschnitt gefunden', !!road && road.length >= 3);
  const rect = await page.evaluate(() => { const r = document.getElementById('map').getBoundingClientRect(); return [r.left, r.top]; });

  // Strich mit Rauschen zeichnen (±8 px)
  const dense = densify(road, 8);
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

  // Zwei Striche direkt hintereinander (ohne Pause): keiner darf Punkte des anderen übernehmen
  {
    const before = await page.evaluate(() => window.__sz.strokes.length);
    const half = Math.floor(dense.length / 2);
    const A = dense.slice(0, half - 3), B = dense.slice(half + 3);
    for (const seg of [A, B]) {
      await page.mouse.move(rect[0] + seg[0][0], rect[1] + seg[0][1]);
      await page.mouse.down();
      for (const [x, y] of seg) await page.mouse.move(rect[0] + x, rect[1] + y);
      await page.mouse.up();
    }
    await page.waitForFunction((n) => window.__sz.strokes.length === n + 2, before, { timeout: 10000 });
    const ok = await page.evaluate(([A, B, n]) => {
      const m = window.__sz.map;
      const box = (seg) => { const xs = seg.map((p) => p[0]), ys = seg.map((p) => p[1]); return [Math.min(...xs) - 40, Math.min(...ys) - 40, Math.max(...xs) + 40, Math.max(...ys) + 40]; };
      const inside = (s, b) => s.parts.every((p) => { for (let i = 0; i < p.length; i += 2) { const q = m.project([p[i], p[i + 1]]); if (q.x < b[0] || q.x > b[2] || q.y < b[1] || q.y > b[3]) return false; } return true; });
      const st = window.__sz.strokes;
      return inside(st[n], box(A)) && inside(st[n + 1], box(B));
    }, [A, B, before]);
    check('Schnelle Folgestriche bleiben getrennt', ok);
    await page.click('#undo'); await page.click('#undo');
  }

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

  // ---------------- Ortssuche: Sprung, Weiterzeichnen am neuen Ort, Striche bleiben erhalten
  await page.click('#import-clear');
  await page.waitForFunction(() => document.getElementById('netsrc-import').disabled);
  const snapshot = () => window.__sz.strokes.map((s) => s.parts.map((p) => Array.from(p).join(',')).join('|'));
  const before = await page.evaluate(snapshot);
  await page.fill('#search-q', 'Tempelhofer Damm');
  await page.press('#search-q', 'Enter');
  await page.waitForFunction(() => /Karte: Tempelhofer Damm/.test(document.getElementById('status').textContent), null, { timeout: 10000 });
  const cam = await page.evaluate(() => { const m = window.__sz.map; return { c: m.getCenter(), z: m.getZoom() }; });
  check('Suche springt zum Treffer', Math.abs(cam.c.lng - 13.3855) < 0.002 && Math.abs(cam.c.lat - 52.484) < 0.002 && cam.z > 15 && cam.z <= 16.01, `${cam.c.lng.toFixed(4)}, ${cam.c.lat.toFixed(4)} z${cam.z.toFixed(2)}`);
  await page.evaluate(() => window.__sz.refreshNet());
  await page.waitForTimeout(500);
  const road2 = await findRoad(page);
  if (!road2) throw new Error('keine Straße am Suchziel');
  const dense2 = densify(road2, 6, 17);
  await page.mouse.move(rect[0] + dense2[0][0], rect[1] + dense2[0][1]);
  await page.mouse.down();
  for (const [x, y] of dense2) await page.mouse.move(rect[0] + x, rect[1] + y);
  await page.mouse.up();
  await page.waitForFunction((n) => window.__sz.strokes.length === n + 1, before.length, { timeout: 10000 });
  const after = await page.evaluate(snapshot);
  check('Strich am neuen Ort rastet ein', after.length === before.length + 1, `Striche ${after.length}`);
  check('Alte Striche nach dem Sprung unverändert', before.every((s, i) => s === after[i]));

  // Ziel außerhalb der aktiven Karte: Hinweis, Export im Ausschnitt leer, Striche bleiben
  await page.fill('#search-q', 'Paris');
  await page.press('#search-q', 'Enter');
  await page.waitForFunction(() => /Karte: Paris/.test(document.getElementById('status').textContent), null, { timeout: 10000 });
  check('Hinweis „keine Daten“ außerhalb der Karte', await page.isVisible('#map-hint'), await page.textContent('#map-hint'));
  await page.click('#ex-png');
  check('Export ohne Striche im Ausschnitt meldet das', /nichts zu exportieren/.test(await page.textContent('#status')));
  check('Striche nach Sprung nach Paris erhalten', (await page.evaluate(() => window.__sz.strokes.length)) === after.length);

  // Koordinaten ohne Netzabfrage, URL-Hash
  const nCalls = nominatim.length;
  await page.fill('#search-q', '52.52, 13.40');
  await page.press('#search-q', 'Enter');
  await page.waitForFunction(() => /Karte: 52\.52000, 13\.40000/.test(document.getElementById('status').textContent), null, { timeout: 10000 });
  check('Koordinaten springen ohne Nominatim-Anfrage', nominatim.length === nCalls && !(await page.isVisible('#map-hint')), `Anfragen: ${nominatim.join(' / ')}`);
  const hash = await page.evaluate(() => location.hash);
  check('URL-Hash enthält die Position', /^#[\d.]+\/52\.52\d*\/13\.4/.test(hash), hash);

  // Zur Zeichnung springen: alle Striche im Bild
  await page.click('#jump-drawing');
  await page.waitForTimeout(1200);
  // sichtbar = im Kartenbild, nicht unter Kopfleiste oder offenem Panel
  const allVisible = await page.evaluate(() => {
    const m = window.__sz.map, c = m.getContainer();
    const top = document.getElementById('bar').getBoundingClientRect().bottom;
    const panel = document.getElementById('panel');
    const right = panel.classList.contains('closed') ? c.clientWidth : panel.getBoundingClientRect().left;
    return window.__sz.strokes.every((s) => s.parts.every((p) => {
      for (let i = 0; i < p.length; i += 2) { const q = m.project([p[i], p[i + 1]]); if (q.x < 0 || q.x > right || q.y < top || q.y > c.clientHeight) return false; }
      return true;
    }));
  });
  check('„Zur Zeichnung springen“ zeigt alle Striche (nicht verdeckt)', allVisible);

  // Neuladen: Zeichnung und Ansicht bleiben
  const nStrokes = await page.evaluate(() => window.__sz.strokes.length);
  await page.waitForTimeout(700);   // entprelltes Speichern abwarten
  await page.reload();
  await page.waitForFunction(() => window.__sz && window.__sz.map.loaded(), null, { timeout: 60000 });
  await page.waitForFunction((n) => window.__sz.strokes.length === n, nStrokes, { timeout: 5000 }).catch(() => {});
  check('Zeichnung übersteht Neuladen', (await page.evaluate(() => window.__sz.strokes.length)) === nStrokes, await page.textContent('#status'));
  await page.screenshot({ path: path.join(out, 'search.png') });

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
