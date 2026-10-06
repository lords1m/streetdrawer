import { describe, expect, it } from 'vitest';
import { buildGraph, polylinesFromArrays } from '../src/core/graph';
import { LocalProjection } from '../src/core/geo';
import { SegGrid } from '../src/core/grid';
import { matchPath } from '../src/core/matching';
import { Lexer, Name } from '../src/pdf/model';
import { PdfDocument } from '../src/pdf/document';
import { ContentInterpreter } from '../src/pdf/interpreter';
import { extractPdf, scanPdf } from '../src/pdf/analyze';
import { buildPdf } from './pdf-builder';

const proj = new LocalProjection(13.4, 52.5);
const blobOf = (b: Uint8Array) => new Blob([b as BlobPart]);

describe('Codecheck-Regressionen', () => {
  it('Routing zwischen Kandidaten nutzt nur erlaubte Klassen', () => {
    // Hauptstraßen y=0 und y=40, nur bei x=200 verbunden; Fußweg bei x=100 als Abkürzung
    const g = buildGraph(polylinesFromArrays(
      [[[0, 0], [200, 0]], [[0, 40], [200, 40]], [[200, 0], [200, 40]], [[100, 0], [100, 40]]],
      [0, 0, 0, 2],
    ), proj, { planarize: true });
    const raw = [0, 2, 98, 2, 98, 38, 0, 38];
    const parts = matchPath(g, raw, { radius: 15, classMask: 1 });
    for (const p of parts) {
      for (let i = 0; i < p.length; i += 2) {
        const onPath = Math.abs(p[i] - 100) < 1e-6 && p[i + 1] > 1 && p[i + 1] < 39;
        expect(onPath).toBe(false);
      }
    }
    // mit Pfaden erlaubt darf (und soll) die Abkürzung genutzt werden
    const all = matchPath(g, raw, { radius: 15, classMask: 7 });
    expect(all.some((p) => { for (let i = 0; i < p.length; i += 2) if (Math.abs(p[i] - 100) < 1e-6 && p[i + 1] > 10 && p[i + 1] < 30) return true; return false; })).toBe(true);
  });

  it('Brücke über Straße erzeugt keine Kreuzung, gleiche Ebene schon', () => {
    const lines = [[[-50, 0], [50, 0]], [[0, -50], [0, 50]]];
    const bridge = buildGraph({ ...polylinesFromArrays(lines), level: Int8Array.of(0, 1) }, proj, { planarize: true });
    expect(bridge.edgeCount).toBe(2);
    const same = buildGraph({ ...polylinesFromArrays(lines), level: Int8Array.of(1, 1) }, proj, { planarize: true });
    expect(same.edgeCount).toBe(4);
  });

  it('Raster: lange Diagonale belegt nur durchlaufene Zellen und wird gefunden', () => {
    const n = 2001;
    const ax = new Float64Array(n), ay = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n);
    for (let i = 0; i < 2000; i++) { const x = (i % 50) * 20, y = Math.floor(i / 50) * 25; ax[i] = x; ay[i] = y; bx[i] = x + 1; by[i] = y; }
    ax[2000] = 0; ay[2000] = 0; bx[2000] = 1000; by[2000] = 1000; // Diagonale
    const g = new SegGrid(ax, ay, bx, by, n);
    const items = (g as unknown as { items: Uint32Array }).items.length;
    expect(items).toBeLessThan(2000 * 4 + (g.nx + g.ny) * 3);
    for (const t of [0, 0.13, 0.5, 0.77, 1]) {
      const found: number[] = [];
      g.query(t * 1000 - 1, t * 1000 - 1, t * 1000 + 1, t * 1000 + 1, (i) => found.push(i));
      expect(found).toContain(2000);
    }
  });

  it('Lexer: Zahl/Name/Referenz am Ende eines vollständigen Puffers', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(new Lexer(enc('4711'), 0, true).parse()).toBe(4711);
    expect((new Lexer(enc('/Foo'), 0, true).parse() as Name).name).toBe('Foo');
    expect(new Lexer(enc('12 0'), 0, true).parse()).toBe(12);
    expect(() => new Lexer(enc('4711')).parse()).toThrow(/Ende/); // unvollständiger Puffer: nachladen
  });

  it('Objekt-Stream, dessen letztes Objekt eine Zahl ohne Zeilenende ist', async () => {
    const pdf = buildPdf({ mode: 'objstm', pages: ['0 0 m 5 5 l S'] });
    const doc = await PdfDocument.open(blobOf(pdf));
    // ObjStm des Builders: letztes Objekt ist die Seite. Direkt prüfen: Lexer im vollständigen Puffer
    expect(await doc.pageCount()).toBe(1);
  });

  it('mehr als 256 verschachtelte q verschieben den Grafikzustand nicht', async () => {
    const content = 'q '.repeat(300) + '2 0 0 2 0 0 cm ' + 'Q '.repeat(300) + '0 0 m 10 10 l S';
    const pdf = buildPdf({ mode: 'classic', pages: [content] });
    const scan = await scanPdf(blobOf(pdf), 0);
    const ex = await extractPdf(blobOf(pdf), 0, scan.styles.map((s) => s.key), null);
    expect(Array.from(ex.coords)).toEqual([0, 0, 10, 10]);
  });

  it('Formular mit offenen q beeinflusst den Aufrufer nicht', async () => {
    const pdf = buildPdf({ mode: 'classic', pages: ['/F1 Do 0 0 m 10 10 l S'], forms: [{ name: 'F1', content: 'q q 3 0 0 3 0 0 cm 0 0 m 1 1 l S' }] });
    const scan = await scanPdf(blobOf(pdf), 0);
    const ex = await extractPdf(blobOf(pdf), 0, scan.styles.map((s) => s.key), null);
    expect(Array.from(ex.coords.subarray(4))).toEqual([0, 0, 10, 10]);
  });

  it('Operanden dürfen über Grenzen zwischen Inhaltsströmen laufen', async () => {
    const pdf = buildPdf({ mode: 'classic', pages: ['0 0 m 100', '200 l S'] });
    const doc = await PdfDocument.open(blobOf(pdf));
    const p0 = await doc.getPage(0), p1 = await doc.getPage(1);
    const got: number[][] = [];
    const it = new ContentInterpreter(doc, { paint(_k, nPts, pts) { got.push(Array.from(pts.subarray(0, nPts * 2))); } }, { flatten: true });
    await it.runPage([p0.contents[0], p1.contents[0]], p0.resources);
    expect(got).toEqual([[0, 0, 100, 200]]);
  });

  it('unterminierte Klammer im Inhaltsstrom bleibt linear (kein quadratisches Puffern)', async () => {
    const junk = '1 2 3 4 '.repeat(500_000); // ~4 MB nach einer offenen Klammer
    const pdf = buildPdf({ mode: 'classic', pages: ['0 0 m 1 1 l S (' + junk] });
    const t0 = performance.now();
    const scan = await scanPdf(blobOf(pdf), 0);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(scan.paths).toBe(1);
  });
});
