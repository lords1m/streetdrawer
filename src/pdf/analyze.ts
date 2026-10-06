import { GrowF64, GrowU32 } from '../core/grow';
import { PdfDocument } from './document';
import { ContentInterpreter, decodeKey, type PathSink } from './interpreter';

export interface StyleStat {
  key: number;
  kind: 'stroke' | 'fill';
  rgb: number;
  /** Strichstärke in pt (nur Striche). */
  width: number;
  layer: string;
  paths: number;
  vertices: number;
}

export interface PdfScan {
  pageCount: number;
  page: number;
  box: [number, number, number, number];
  styles: StyleStat[];
  density: { nx: number; ny: number; cells: Uint32Array };
  operators: number;
  paths: number;
  ms: number;
  recovered: boolean;
}

export type PdfProgress = (fraction: number, text?: string) => void;

const DENSITY_LONG = 160;

class ScanSink implements PathSink {
  stats = new Map<number, { paths: number; vertices: number }>();
  readonly nx: number; readonly ny: number;
  readonly cells: Uint32Array;
  private x0: number; private y0: number; private sx: number; private sy: number;
  constructor(box: [number, number, number, number]) {
    const w = box[2] - box[0] || 1, h = box[3] - box[1] || 1;
    const k = DENSITY_LONG / Math.max(w, h);
    this.nx = Math.max(1, Math.ceil(w * k)); this.ny = Math.max(1, Math.ceil(h * k));
    this.cells = new Uint32Array(this.nx * this.ny);
    this.x0 = box[0]; this.y0 = box[1]; this.sx = this.nx / w; this.sy = this.ny / h;
  }
  paint(key: number, nPts: number, pts: Float64Array) {
    let s = this.stats.get(key);
    if (!s) { s = { paths: 0, vertices: 0 }; this.stats.set(key, s); }
    s.paths++; s.vertices += nPts;
    // Segmente entlang ihrer Länge in Rasterzellen eintragen (nicht nur Stützpunkte)
    for (let i = 0; i < nPts; i++) {
      const x = pts[2 * i], y = pts[2 * i + 1];
      this.hit(x, y);
      if (i > 0) {
        const ax = pts[2 * i - 2], ay = pts[2 * i - 1];
        const steps = Math.min(64, Math.ceil(Math.max(Math.abs(x - ax) * this.sx, Math.abs(y - ay) * this.sy)));
        for (let k = 1; k < steps; k++) this.hit(ax + ((x - ax) * k) / steps, ay + ((y - ay) * k) / steps);
      }
    }
  }
  private hit(x: number, y: number) {
    const cx = Math.floor((x - this.x0) * this.sx), cy = Math.floor((y - this.y0) * this.sy);
    if (cx >= 0 && cx < this.nx && cy >= 0 && cy < this.ny) this.cells[cy * this.nx + cx]++;
  }
}

function contentSize(doc: PdfDocument, nums: number[]) {
  return Promise.all(nums.map(async (n) => (await doc.getStream(n))?.length ?? 0)).then((a) => a.reduce((x, y) => x + y, 0));
}

/** Durchgang 1: Ebenenstatistik (Farbe, Strichstärke, Anzahl) und Dichteübersicht – ohne Geometrie zu speichern. */
export async function scanPdf(file: Blob, pageIndex: number, progress: PdfProgress = () => {}): Promise<PdfScan> {
  const t0 = performance.now();
  const doc = await PdfDocument.open(file);
  const pageCount = await doc.pageCount();
  const page = await doc.getPage(pageIndex);
  const sink = new ScanSink(page.box);
  const interp = new ContentInterpreter(doc, sink, { flatten: false });
  const total = Math.max(1, await contentSize(doc, page.contents));
  let raw = 0;
  progress(0, 'PDF wird analysiert …');
  await interp.runPage(page.contents, page.resources, (n) => {
    raw += n;
    progress(Math.min(0.99, raw / total), `Analyse: ${interp.opCount.toLocaleString('de')} Operatoren`);
  });
  const styles: StyleStat[] = [];
  for (const [key, s] of sink.stats) {
    const d = decodeKey(key);
    styles.push({ key, kind: d.kind === 0 ? 'stroke' : 'fill', rgb: d.rgb, width: d.width, layer: interp.ocNames[d.oc] ?? '', paths: s.paths, vertices: s.vertices });
  }
  styles.sort((a, b) => b.paths - a.paths);
  progress(1, 'Analyse fertig');
  return {
    pageCount, page: pageIndex, box: page.box, styles,
    density: { nx: sink.nx, ny: sink.ny, cells: sink.cells },
    operators: interp.opCount, paths: interp.pathCount, ms: performance.now() - t0, recovered: doc.recovered,
  };
}

export interface Extracted {
  coords: Float64Array;   // Seitenkoordinaten (pt), x,y-Paare
  offsets: Uint32Array;   // Punktindex je Polylinie (n+1)
  keys: Float64Array;     // Stil-Schlüssel je Polylinie
  box: [number, number, number, number];
}

class ExtractSink implements PathSink {
  coords = new GrowF64(1 << 18);
  offsets = new GrowU32(1 << 14);
  keys = new GrowF64(1 << 14);
  constructor(private want: Set<number>, private region: [number, number, number, number] | null) {}
  paint(key: number, nPts: number, pts: Float64Array, nSub: number, subStart: Uint32Array) {
    if (!this.want.has(key)) return;
    const r = this.region;
    for (let s = 0; s < nSub; s++) {
      const a = subStart[s], b = s + 1 < nSub ? subStart[s + 1] : nPts;
      if (b - a < 2) continue;
      if (r) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = a; i < b; i++) {
          const x = pts[2 * i], y = pts[2 * i + 1];
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        if (maxX < r[0] || minX > r[2] || maxY < r[1] || minY > r[3]) continue;
      }
      this.offsets.push(this.coords.n / 2);
      for (let i = a; i < b; i++) { this.coords.push(pts[2 * i]); this.coords.push(pts[2 * i + 1]); }
      this.keys.push(key);
    }
  }
}

/** Durchgang 2: nur gewählte Stile im gewählten Ausschnitt einlesen. */
export async function extractPdf(
  file: Blob, pageIndex: number, keys: number[], region: [number, number, number, number] | null, progress: PdfProgress = () => {},
): Promise<Extracted> {
  const doc = await PdfDocument.open(file);
  const page = await doc.getPage(pageIndex);
  const sink = new ExtractSink(new Set(keys), region);
  const interp = new ContentInterpreter(doc, sink, { flatten: true });
  const total = Math.max(1, await contentSize(doc, page.contents));
  let raw = 0;
  await interp.runPage(page.contents, page.resources, (n) => {
    raw += n;
    progress(Math.min(0.99, raw / total), `Einlesen: ${sink.offsets.n.toLocaleString('de')} Linienzüge`);
  });
  sink.offsets.push(sink.coords.n / 2);
  progress(1, `${(sink.offsets.n - 1).toLocaleString('de')} Linienzüge`);
  return { coords: sink.coords.toArray(), offsets: sink.offsets.toArray(), keys: sink.keys.toArray(), box: page.box };
}
