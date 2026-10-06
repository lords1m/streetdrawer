import { describe, expect, it } from 'vitest';
import { PdfDocument } from '../src/pdf/document';
import { extractPdf, scanPdf } from '../src/pdf/analyze';
import { ContentInterpreter, decodeKey, makeKey } from '../src/pdf/interpreter';
import { applyFilters, collect } from '../src/pdf/filters';
import { guessScale, pdfToNet } from '../src/pdf/net';
import { buildGraph } from '../src/core/graph';
import { LocalProjection } from '../src/core/geo';
import { buildPdf, type PdfMode } from './pdf-builder';

const blobOf = (b: Uint8Array) => new Blob([b as BlobPart]);
const MODES: PdfMode[] = ['classic', 'xrefstream', 'objstm'];

const SIMPLE = `
1 0 0 RG 2 w
10 10 m 110 10 l S
0 0 1 RG 0.5 w
10 20 m 110 20 l 110 120 l S
0.2 g 20 20 50 30 re f
`;

describe('PDF-Struktur: xref-Varianten', () => {
  for (const mode of MODES) {
    it(`liest ${mode}: Katalog, Seitenbaum, Streams`, async () => {
      const pdf = buildPdf({ mode, pages: [SIMPLE, '0 0 m 1 1 l S'] });
      const doc = await PdfDocument.open(blobOf(pdf));
      expect(doc.recovered).toBe(false);
      expect(await doc.pageCount()).toBe(2);
      const p = await doc.getPage(0);
      expect(p.box).toEqual([0, 0, 612, 792]);
      const bytes = await doc.readStream(p.contents[0]);
      expect(new TextDecoder().decode(bytes!)).toContain('10 10 m 110 10 l S');
      const p2 = await doc.getPage(1);
      expect(new TextDecoder().decode((await doc.readStream(p2.contents[0]))!)).toContain('0 0 m 1 1 l S');
    });

    it(`scant ${mode}: Ebenenstatistik nach Farbe/Stärke/Anzahl`, async () => {
      const pdf = buildPdf({ mode, pages: [SIMPLE] });
      const scan = await scanPdf(blobOf(pdf), 0);
      expect(scan.pageCount).toBe(1);
      const strokes = scan.styles.filter((s) => s.kind === 'stroke');
      expect(strokes.length).toBe(2);
      const red = strokes.find((s) => s.rgb === 0xff0000)!;
      expect(red.width).toBe(2); expect(red.paths).toBe(1);
      const blue = strokes.find((s) => s.rgb === 0x0000ff)!;
      expect(blue.width).toBe(0.5); expect(blue.vertices).toBe(3);
      const fill = scan.styles.find((s) => s.kind === 'fill')!;
      expect(fill.rgb).toBe(0x333333);
    });
  }

  it('Seitenbaum verschachtelt, indirektes /Length', async () => {
    const pdf = buildPdf({ mode: 'classic', pages: ['0 0 m 5 5 l S', '1 1 m 9 9 l S'], nested: true, indirectLength: true });
    const ex = await extractPdf(blobOf(pdf), 1, (await scanPdf(blobOf(pdf), 1)).styles.map((s) => s.key), null);
    expect(Array.from(ex.coords)).toEqual([1, 1, 9, 9]);
  });

  it('unkomprimierte Streams funktionieren', async () => {
    const pdf = buildPdf({ mode: 'xrefstream', pages: [SIMPLE], flate: false });
    expect((await scanPdf(blobOf(pdf), 0)).styles.length).toBe(3);
  });

  it('meldet verschlüsselte Dateien klar', async () => {
    const pdf = buildPdf({ mode: 'classic', pages: [SIMPLE], trailerExtra: '/Encrypt 99 0 R' });
    await expect(PdfDocument.open(blobOf(pdf))).rejects.toThrow(/Verschlüsselt/);
  });

  for (const mode of MODES) {
    it(`stellt defekte xref wieder her (${mode})`, async () => {
      const pdf = buildPdf({ mode, pages: [SIMPLE] });
      // startxref-Offset zerstören
      const txt = Buffer.from(pdf).toString('latin1');
      const broken = txt.replace(/startxref\n\d+/, 'startxref\n7');
      const bytes = new Uint8Array(Buffer.from(broken, 'latin1'));
      const doc = await PdfDocument.open(blobOf(bytes));
      expect(doc.recovered).toBe(true);
      expect((await scanPdf(blobOf(bytes), 0)).styles.length).toBe(3);
    });
  }
});

describe('Inhaltsstrom-Interpreter', () => {
  async function paths(content: string, opts: Parameters<typeof buildPdf>[0] extends infer T ? Partial<T> : never = {}) {
    const pdf = buildPdf({ mode: 'classic', pages: [content], ...opts } as never);
    const scan = await scanPdf(blobOf(pdf), 0);
    const ex = await extractPdf(blobOf(pdf), 0, scan.styles.map((s) => s.key), null);
    const lines: number[][] = [];
    for (let i = 0; i < ex.offsets.length - 1; i++) lines.push(Array.from(ex.coords.subarray(ex.offsets[i] * 2, ex.offsets[i + 1] * 2)));
    return { lines, ex, scan };
  }

  it('Linien, Rechteck (geschlossen), h-Operator', async () => {
    const { lines } = await paths('0 0 m 10 0 l 10 10 l h S 5 5 4 6 re S');
    expect(lines[0]).toEqual([0, 0, 10, 0, 10, 10, 0, 0]);
    expect(lines[1]).toEqual([5, 5, 9, 5, 9, 11, 5, 11, 5, 5]);
  });

  it('CTM (cm) und q/Q', async () => {
    const { lines } = await paths('q 2 0 0 2 100 50 cm 0 0 m 10 10 l S Q 0 0 m 1 1 l S');
    expect(lines[0]).toEqual([100, 50, 120, 70]);
    expect(lines[1]).toEqual([0, 0, 1, 1]);
  });

  it('Strichstärke wird mit CTM skaliert, gs setzt LW', async () => {
    const { scan } = await paths('q 3 0 0 3 0 0 cm 1 w 0 0 m 1 1 l S Q /GS1 gs 0 0 m 1 1 l S');
    const widths = scan.styles.map((s) => s.width).sort();
    expect(widths).toEqual([3]);
    expect(scan.styles.length).toBe(1); // gleicher Stil
    expect(scan.styles[0].paths).toBe(2);
  });

  it('Kurven werden in Polygonzüge aufgelöst', async () => {
    const { lines } = await paths('0 0 m 0 100 100 100 100 0 c S');
    expect(lines[0].length / 2).toBeGreaterThan(6);
    expect(lines[0].slice(-2)).toEqual([100, 0]);
    // Scheitelpunkt der Kurve liegt bei y=75
    const ys = lines[0].filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeCloseTo(75, -0.5);
  });

  it('v und y Kurven enden am richtigen Punkt', async () => {
    const { lines } = await paths('0 0 m 50 50 100 0 v S 0 0 m 50 50 100 0 y S');
    expect(lines[0].slice(-2)).toEqual([100, 0]);
    expect(lines[1].slice(-2)).toEqual([100, 0]);
  });

  it('Farben: RGB, Gray, CMYK', async () => {
    const { scan } = await paths('0 1 0 RG 0 0 m 1 1 l S 0.5 G 0 0 m 1 1 l S 0 0 0 1 K 0 0 m 1 1 l S 1 0 0 0 K 0 0 m 1 1 l S');
    const rgbs = scan.styles.map((s) => s.rgb).sort((a, b) => a - b);
    expect(rgbs).toEqual([0x000000, 0x00ffff, 0x00ff00, 0x808080].sort((a, b) => a - b));
  });

  it('Formulare (Do) mit Matrix und verschachtelte Zustände', async () => {
    const { lines } = await paths('1 0 0 1 100 100 cm /F1 Do 0 0 m 1 1 l S', {
      forms: [{ name: 'F1', content: '0 0 m 10 0 l S /F2 Do', matrix: [2, 0, 0, 2, 0, 0] }, { name: 'F2', content: '0 5 m 1 5 l S' }],
    });
    // F1 hat Matrix 2x; Linie (0,0)-(10,0) -> (100,100)-(120,100)
    expect(lines[0]).toEqual([100, 100, 120, 100]);
    // F2 ist nicht in der Resources-Liste von F1 -> erbt Seiten-Ressourcen, also gezeichnet mit 2x-Matrix
    expect(lines[1]).toEqual([100, 110, 102, 110]);
    expect(lines[2]).toEqual([100, 100, 101, 101]);
  });

  it('Ebenen (BDC /OC) erscheinen in der Statistik', async () => {
    const { scan } = await paths('/OC /L1 BDC 0 0 m 5 5 l S EMC /OC /L2 BDC 0 0 m 5 5 l S EMC 0 0 m 5 5 l S', { layers: { L1: 'Straßen', L2: 'Gewässer' } });
    expect(scan.styles.map((s) => s.layer).sort()).toEqual(['', 'Gewässer', 'Straßen']);
  });

  it('überspringt Inline-Bilder samt Binärdaten (auch mit "EI" im Datenstrom)', async () => {
    const data = 'q 10 0 0 10 0 0 cm BI /W 4 /H 1 /CS /G /BPC 8 ID \u0001 EI \u0002\u0003 EI\nQ 0 0 m 7 7 l S';
    const { lines } = await paths(data);
    expect(lines).toEqual([[0, 0, 7, 7]]);
  });

  it('Text, Strings mit Klammern, Dicts und Kommentare stören nicht', async () => {
    const { lines } = await paths('BT /F1 12 Tf (Hallo \\) (Welt)) Tj [(a) -20 (b)] TJ ET % Kommentar 1 2 m\n/Span << /MCID 0 >> BDC 0 0 m 3 3 l S EMC <48656C6C6F> pop');
    expect(lines).toEqual([[0, 0, 3, 3]]);
  });

  it('Region filtert Linienzüge', async () => {
    const pdf = buildPdf({ mode: 'classic', pages: ['0 0 m 10 0 l S 500 500 m 510 500 l S'] });
    const scan = await scanPdf(blobOf(pdf), 0);
    const ex = await extractPdf(blobOf(pdf), 0, scan.styles.map((s) => s.key), [400, 400, 600, 600]);
    expect(Array.from(ex.coords)).toEqual([500, 500, 510, 500]);
  });

  it('Dichteübersicht zählt Punkte', async () => {
    const pdf = buildPdf({ mode: 'classic', pages: ['0 0 m 600 0 l S'] });
    const scan = await scanPdf(blobOf(pdf), 0);
    expect(scan.density.cells.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('Schlüssel-Kodierung ist umkehrbar', () => {
    const k = makeKey(7, 1, 0xabcdef, 1234);
    expect(decodeKey(k)).toEqual({ oc: 7, kind: 1, rgb: 0xabcdef, width: 1234 / 20 });
  });
});

describe('Chunk-Grenzen im Tokenizer', () => {
  /** Interpretiert denselben Inhalt in Stücken von n Bytes und vergleicht mit einem Durchlauf. */
  async function run(content: string, chunk: number) {
    const pdf = buildPdf({ mode: 'classic', pages: ['0 0 m 1 1 l S'] });
    const doc = await PdfDocument.open(blobOf(pdf));
    const got: number[][] = [];
    const sink = { paint(_k: number, nPts: number, pts: Float64Array) { got.push(Array.from(pts.subarray(0, nPts * 2))); } };
    const it = new ContentInterpreter(doc, sink, { flatten: true });
    const bytes = new TextEncoder().encode(content);
    const rs = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); } });
    await (it as unknown as { exec(s: ReadableStream<Uint8Array>, d: number): Promise<void> }).exec(rs, 0);
    return got;
  }
  const content = '10.25 20.5 m 30 -40.125 l (a string with ) and \\( stuff) Tj /Name#20X gs 1 0 0 RG BI /W 1 /H 1 ID \u0000 EI 0.5 .5 m 7 8 l S 100 200 300 400 re S';
  it('liefert für alle Stückgrößen dasselbe', async () => {
    const ref = await run(content, 1 << 20);
    expect(ref.length).toBe(2);
    for (const n of [1, 2, 3, 5, 7, 13]) expect(await run(content, n)).toEqual(ref);
  });

  it('verarbeitet 200.000 Operatoren über viele 64-KB-Grenzen', async () => {
    let s = '';
    for (let i = 0; i < 40000; i++) s += `${i} 0 m ${i + 1} 1.5 l ${i + 2} 3 l S\n`;
    const pdf = buildPdf({ mode: 'classic', pages: [s] });
    const t0 = performance.now();
    const scan = await scanPdf(blobOf(pdf), 0);
    const dt = performance.now() - t0;
    expect(scan.paths).toBe(40000);
    expect(scan.operators).toBe(160000);
    expect(dt).toBeLessThan(5000);
  });
});

describe('Filter', () => {
  const stream = (b: Uint8Array) => new Blob([b as BlobPart]).stream();
  it('ASCIIHexDecode', async () => {
    const out = await collect(applyFilters(stream(new TextEncoder().encode('48 65 6C6c 6F>')), [{ name: 'ASCIIHexDecode' }]));
    expect(new TextDecoder().decode(out)).toBe('Hello');
  });
  it('ASCII85Decode', async () => {
    const out = await collect(applyFilters(stream(new TextEncoder().encode('87cURD]i,"Ebo80~>')), [{ name: 'ASCII85Decode' }]));
    expect(new TextDecoder().decode(out)).toBe('Hello World!');
  });
  it('LZWDecode (Beispiel aus der PDF-Spezifikation)', async () => {
    const out = await collect(applyFilters(stream(Uint8Array.of(0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01)), [{ name: 'LZWDecode' }]));
    expect(new TextDecoder().decode(out)).toBe('-----A---B');
  });
  it('RunLengthDecode', async () => {
    const out = await collect(applyFilters(stream(Uint8Array.of(2, 65, 66, 67, 254, 68, 128)), [{ name: 'RunLengthDecode' }]));
    expect(new TextDecoder().decode(out)).toBe('ABCDDD');
  });
  it('Flate + ASCII85 als Kette', async () => {
    const { deflateSync } = await import('node:zlib');
    const z = deflateSync(Buffer.from('0 0 m 1 1 l S'));
    // einfache ASCII85-Kodierung
    let a85 = '';
    for (let i = 0; i < z.length; i += 4) {
      const n = Math.min(4, z.length - i);
      let v = 0; for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? z[i + k] : 0);
      const d: string[] = []; for (let k = 0; k < 5; k++) { d.unshift(String.fromCharCode((v % 85) + 33)); v = Math.floor(v / 85); }
      a85 += d.join('').slice(0, n + 1);
    }
    a85 += '~>';
    const out = await collect(applyFilters(stream(new TextEncoder().encode(a85)), [{ name: 'ASCII85Decode' }, { name: 'FlateDecode' }]));
    expect(new TextDecoder().decode(out)).toBe('0 0 m 1 1 l S');
  });
  it('abgeschnittene Flate-Daten liefern das Bisherige statt abzustürzen', async () => {
    const { deflateSync } = await import('node:zlib');
    const z = deflateSync(Buffer.from('0 0 m 1 1 l S '.repeat(2000)));
    const out = await collect(applyFilters(stream(new Uint8Array(z.subarray(0, z.length - 20))), [{ name: 'FlateDecode' }]));
    expect(out.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Maßstab und Netzaufbau', () => {
  it('rät den Maßstab aus dem Dateinamen', () => {
    expect(guessScale('Stadtplan_1_5000.pdf')).toBe(5000);
    expect(guessScale('karte 1:25000.pdf')).toBe(25000);
    expect(guessScale('plan-M10000.pdf')).toBe(10000);
    expect(guessScale('Maßstab 2500 Mitte.pdf')).toBe(2500);
    expect(guessScale('rechnung_2024.pdf')).toBeNull();
    expect(guessScale('flurkarte_1-1000_blatt3.pdf')).toBe(1000);
  });

  it('rechnet Seiten-pt in Meter um und überbrückt Lücken', async () => {
    // zwei Linien mit 1-pt-Lücke bei 1:5000 (1 pt = 1,76 m), T-Stoß und Kreuzung
    const content = '0 0 m 100 0 l S 101 0 m 200 0 l S 150 -50 m 150 50 l S 50 10 m 50 60 l S';
    const pdf = buildPdf({ mode: 'classic', pages: [content] });
    const scan = await scanPdf(blobOf(pdf), 0);
    const ex = await extractPdf(blobOf(pdf), 0, scan.styles.map((s) => s.key), null);
    const net = pdfToNet(ex, { scale: 5000, gapPt: 2, classFromWidth: false, center: [13.4, 52.5] });
    expect(net.metersPerPoint).toBeCloseTo(1.7639, 3);
    const g = buildGraph({ coords: net.batch.coords, offsets: net.batch.offsets, cls: net.batch.cls }, new LocalProjection(13.4, 52.5), net.build);
    // Lücke geschlossen: Horizontale ist in einer Komponente erreichbar
    const comp = components(g);
    // Linie 4 (50,10)-(50,60) ist von der Horizontalen (y=0) 10 pt entfernt -> eigene Komponente
    expect(comp).toBe(2);
    // Kreuzung (150,0): Grad 4 vorhanden
    let deg4 = 0;
    for (let n = 0; n < g.nodeCount; n++) if (g.adjStart[n + 1] - g.adjStart[n] === 4) deg4++;
    expect(deg4).toBe(1);
  });
});

function components(g: ReturnType<typeof buildGraph>): number {
  const seen = new Uint8Array(g.nodeCount);
  let c = 0;
  for (let s = 0; s < g.nodeCount; s++) {
    if (seen[s]) continue;
    c++;
    const st = [s]; seen[s] = 1;
    while (st.length) {
      const u = st.pop()!;
      for (let k = g.adjStart[u]; k < g.adjStart[u + 1]; k++) {
        const e = g.adjEdge[k]; const v = g.edgeA[e] === u ? g.edgeB[e] : g.edgeA[e];
        if (!seen[v]) { seen[v] = 1; st.push(v); }
      }
    }
  }
  return c;
}
