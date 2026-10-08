/** Hilfen für das E2E-Skript: Test-PDF und Zeichnen entlang einer lng/lat-Linie. */

export function makePdf() {
  // 11x11-Gitter, Linien alle 40 pt (zwei Strichstärken), Hintergrundfläche
  const NL = String.fromCharCode(10);
  let c = '0.95 g 0 0 612 792 re f' + NL + '0.2 0.2 0.2 RG 1 w' + NL;
  for (let i = 0; i <= 10; i++) c += `${100 + i * 40} 100 m ${100 + i * 40} 500 l S` + NL;
  c += '0.5 w 0.6 0.1 0.1 RG' + NL;
  for (let i = 0; i <= 10; i++) c += `100 ${100 + i * 40} m 500 ${100 + i * 40} l S` + NL;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${c.length} >>${NL}stream${NL}${c}endstream`,
  ];
  let out = '%PDF-1.4' + NL;
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj${NL}${o}${NL}endobj${NL}`; });
  const x = out.length;
  out += `xref${NL}0 ${objs.length + 1}${NL}0000000000 65535 f ${NL}`;
  out += offs.map((o) => String(o).padStart(10, '0') + ' 00000 n ' + NL).join('');
  out += `trailer${NL}<< /Size ${objs.length + 1} /Root 1 0 R >>${NL}startxref${NL}${x}${NL}%%EOF${NL}`;
  return Buffer.from(out, 'latin1');
}

/** Zeichnet entlang einer lng/lat-Linie mit Rauschen (px). */
export async function drawAlong(page, rect, ll, noisePx) {
  const pts = await page.evaluate(([line]) => {
    const m = window.__sz.map; const a = m.project(line[0]), b = m.project(line[1]);
    const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 6));
    return Array.from({ length: n + 1 }, (_, i) => [a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n]);
  }, [ll]);
  let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff - 0.5; };
  await page.mouse.move(rect[0] + pts[0][0], rect[1] + pts[0][1] + rnd() * noisePx);
  await page.mouse.down();
  for (const [x, y] of pts) await page.mouse.move(rect[0] + x, rect[1] + y + rnd() * noisePx * 2);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** Längste sichtbare Straße im mittleren Bildbereich als Bildschirmpunkte (px) oder null. */
export async function findRoad(page, box = [360, 150, 1100, 700]) {
  return page.evaluate((box) => {
    const m = window.__sz.map;
    const ids = m.getStyle().layers.filter((l) => l['source-layer'] === 'roads' && l.type === 'line' && /major|highway|minor/.test(l.id) && !/casing/.test(l.id)).map((l) => l.id);
    const feats = m.queryRenderedFeatures(undefined, { layers: ids });
    let best = null, bl = 0;
    for (const f of feats) {
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      for (const l of lines) {
        const pts = l.map((c) => m.project(c));
        const inside = pts.filter((p) => p.x > box[0] && p.x < box[2] && p.y > box[1] && p.y < box[3]);
        if (inside.length < 3) continue;
        let len = 0;
        for (let i = 1; i < inside.length; i++) len += Math.hypot(inside[i].x - inside[i - 1].x, inside[i].y - inside[i - 1].y);
        if (len > bl) { bl = len; best = inside.map((p) => [p.x, p.y]); }
      }
    }
    return best;
  }, box);
}

/** Dichte Punktfolge entlang einer Bildschirmlinie mit Rauschen (±noisePx). */
export function densify(road, noisePx, seed = 3) {
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff - 0.5; };
  const dense = [];
  for (let i = 1; i < road.length; i++) {
    const [x0, y0] = road[i - 1], [x1, y1] = road[i];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 6));
    for (let k = 0; k < n; k++) dense.push([x0 + ((x1 - x0) * k) / n + rnd() * noisePx * 2, y0 + ((y1 - y0) * k) / n + rnd() * noisePx * 2]);
  }
  return dense;
}

/** Nominatim-Attrappe: liefert je Suchtext (Kleinschreibung) die hinterlegten Treffer und zählt die Anfragen. */
export async function mockNominatim(ctx, fixtures) {
  const calls = [];
  await ctx.route('https://nominatim.openstreetmap.org/**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    calls.push(q);
    route.fulfill({ json: fixtures[q.trim().toLowerCase()] ?? [], headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  return calls;
}
