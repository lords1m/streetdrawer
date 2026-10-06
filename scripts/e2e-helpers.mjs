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
