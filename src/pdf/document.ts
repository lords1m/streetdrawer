import { applyFilters, collect, type FilterSpec } from './filters';
import { Cmd, Dict, EofError, Lexer, Name, Ref, isDict, isName, latin1, type PdfObj } from './model';

export interface StreamInfo { dict: Dict; start: number; length: number }

interface ObjStm { buf: Uint8Array; nums: number[]; offs: number[]; first: number }

const T_NONE = 0, T_FREE = 3, T_INUSE = 1, T_COMP = 2;

/**
 * PDF-Dokument auf einem Blob/File: liest nur die benötigten Bereiche (Blob.slice).
 * Unterstützt klassische xref-Tabellen, xref-Streams, Hybrid-Dateien, Objekt-Streams und Wiederherstellung defekter xref.
 */
export class PdfDocument {
  readonly size: number;
  trailer = new Dict();
  private xType = new Uint8Array(1024);
  private xA = new Float64Array(1024);
  private xB = new Uint32Array(1024);
  private cache = new Map<number, PdfObj>();
  private streams = new Map<number, StreamInfo>();
  private objStms = new Map<number, ObjStm>();
  recovered = false;

  private constructor(readonly blob: Blob) { this.size = blob.size; }

  static async open(blob: Blob): Promise<PdfDocument> {
    const doc = new PdfDocument(blob);
    await doc.init();
    return doc;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(Math.max(0, start), Math.min(this.size, end)).arrayBuffer());
  }

  // ------------------------------------------------------------------ xref
  private grow(n: number) {
    if (n < this.xType.length) return;
    let c = this.xType.length;
    while (c <= n) c *= 2;
    const t = new Uint8Array(c); t.set(this.xType); this.xType = t;
    const a = new Float64Array(c); a.set(this.xA); this.xA = a;
    const b = new Uint32Array(c); b.set(this.xB); this.xB = b;
  }
  private setEntry(num: number, type: number, a: number, b: number) {
    this.grow(num);
    if (this.xType[num] !== T_NONE) return; // neuester Eintrag gewinnt
    this.xType[num] = type; this.xA[num] = a; this.xB[num] = b;
  }
  hasObject(num: number) { return num < this.xType.length && (this.xType[num] === T_INUSE || this.xType[num] === T_COMP); }
  get objectLimit() { return this.xType.length; }

  private async init() {
    const head = latin1(await this.read(0, 1024), 0, Math.min(1024, this.size));
    if (!head.includes('%PDF-')) throw new Error('Keine PDF-Datei');
    try {
      const tail = await this.read(this.size - 2048, this.size);
      const txt = latin1(tail, 0, tail.length);
      const i = txt.lastIndexOf('startxref');
      if (i < 0) throw new Error('startxref fehlt');
      const off = parseInt(txt.slice(i + 9).trim(), 10);
      if (!Number.isFinite(off)) throw new Error('startxref ungültig');
      await this.readXrefChain(off);
      if (!this.trailer.has('Root')) throw new Error('Trailer ohne Root');
      // Plausibilität: Wurzel muss ladbar sein
      await this.catalog();
    } catch {
      await this.rebuild();
    }
    if (this.trailer.has('Encrypt')) throw new Error('Verschlüsselte PDF-Dateien werden nicht unterstützt.');
  }

  private async readXrefChain(first: number) {
    const seen = new Set<number>();
    const queue = [first];
    let firstTrailer = true;
    while (queue.length) {
      const off = queue.shift()!;
      if (seen.has(off) || off < 0 || off >= this.size) continue;
      seen.add(off);
      const trailer = await this.readXrefSection(off);
      if (firstTrailer) { this.trailer = trailer; firstTrailer = false; }
      else for (const k of trailer.keys()) if (!this.trailer.has(k)) this.trailer.set(k, trailer.get(k)!);
      const stm = trailer.get('XRefStm');
      if (typeof stm === 'number') queue.unshift(stm);
      const prev = trailer.get('Prev');
      if (typeof prev === 'number') queue.push(prev);
    }
  }

  private async readXrefSection(off: number): Promise<Dict> {
    const probe = await this.read(off, off + 64);
    let p = 0;
    while (p < probe.length && probe[p] <= 32) p++;
    if (latin1(probe, p, p + 4) === 'xref') return this.readXrefTable(off + p + 4);
    // xref-Stream: "n g obj << /Type /XRef … >> stream"
    const { obj, stream } = await this.parseIndirect(off);
    if (!(obj instanceof Dict) || !stream) throw new Error('xref-Stream erwartet');
    const data = await collect(await this.openStream(stream));
    const w = (obj.get('W') as number[]) ?? [1, 2, 1];
    const size = obj.get('Size') as number;
    const index = (obj.get('Index') as number[]) ?? [0, size];
    const rowLen = w[0] + w[1] + w[2];
    let pos = 0;
    const rd = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + data[pos++]; return v; };
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]; i++) {
        if (pos + rowLen > data.length) break;
        const t = w[0] ? rd(w[0]) : 1, a = rd(w[1]), b = rd(w[2]);
        const num = index[s] + i;
        if (t === 1) this.setEntry(num, T_INUSE, a, b);
        else if (t === 2) this.setEntry(num, T_COMP, a, b);
        else this.setEntry(num, T_FREE, 0, 0);
      }
    }
    return obj;
  }

  private async readXrefTable(start: number): Promise<Dict> {
    // Tolerantes Lesen in 1-MB-Fenstern
    let winStart = start;
    let buf = await this.read(winStart, winStart + (1 << 20));
    let pos = 0;
    const ensure = async (n: number) => {
      if (pos + n <= buf.length || winStart + buf.length >= this.size) return;
      const rest = buf.subarray(pos);
      const more = await this.read(winStart + buf.length, winStart + buf.length + (1 << 20));
      const nb = new Uint8Array(rest.length + more.length);
      nb.set(rest); nb.set(more, rest.length);
      winStart += pos; buf = nb; pos = 0;
    };
    const skipWs = async () => { for (;;) { await ensure(64); while (pos < buf.length && buf[pos] <= 32) pos++; if (pos < buf.length || winStart + buf.length >= this.size) return; } };
    const readInt = async () => {
      await skipWs(); await ensure(32);
      let v = 0, any = false;
      while (pos < buf.length && buf[pos] >= 48 && buf[pos] <= 57) { v = v * 10 + buf[pos++] - 48; any = true; }
      if (!any) throw new Error('xref: Zahl erwartet');
      return v;
    };
    for (;;) {
      await skipWs(); await ensure(16);
      if (latin1(buf, pos, pos + 7) === 'trailer') { pos += 7; break; }
      const first = await readInt();
      const count = await readInt();
      for (let i = 0; i < count; i++) {
        const o = await readInt(); const g = await readInt();
        await skipWs();
        const k = buf[pos++];
        if (k === 110) this.setEntry(first + i, T_INUSE, o, g);
        else if (k === 102) this.setEntry(first + i, T_FREE, 0, 0);
        else throw new Error('xref: Eintrag ungültig');
      }
    }
    await ensure(1 << 16);
    const lx = new Lexer(buf, pos);
    const d = lx.parse();
    if (!(d instanceof Dict)) throw new Error('Trailer-Dictionary erwartet');
    return d;
  }

  /** Wiederherstellung: Datei nach "n g obj" absuchen. */
  private async rebuild() {
    this.recovered = true;
    this.xType = new Uint8Array(1024); this.xA = new Float64Array(1024); this.xB = new Uint32Array(1024);
    this.cache.clear(); this.streams.clear(); this.objStms.clear();
    const CH = 4 << 20, OV = 128;
    const found = new Map<number, number>();
    let rootRef: Ref | null = null;
    for (let base = 0; base < this.size; base += CH) {
      const buf = await this.read(base, base + CH + OV);
      const txt = latin1(buf, 0, buf.length);
      const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt))) {
        if (m.index >= CH && base + CH < this.size) break; // gehört zum nächsten Fenster
        found.set(Number(m[1]), base + m.index);
      }
      const tre = /trailer\s*<<([\s\S]{0,2000}?)>>\s*(?:startxref|%%EOF|$)/g;
      while ((m = tre.exec(txt))) {
        const rm = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(m[1]);
        if (rm) rootRef = new Ref(Number(rm[1]), Number(rm[2]));
      }
      const cre = /(\d{1,10})\s+\d{1,5}\s+obj\s*<<[^>]{0,400}?\/Type\s*\/Catalog/g;
      while ((m = cre.exec(txt))) if (!rootRef) rootRef = new Ref(Number(m[1]), 0);
    }
    for (const [num, off] of found) this.setEntry(num, T_INUSE, off, 0);
    if (!rootRef) {
      // XRef-Stream-Objekte enthalten Root im Dictionary
      for (const [num] of found) {
        try {
          const o = await this.getObject(num);
          if (o instanceof Dict && isName(o.get('Type'), 'XRef') && o.get('Root') instanceof Ref) { rootRef = o.get('Root') as Ref; break; }
        } catch { /* weiter */ }
      }
    }
    if (!rootRef) throw new Error('PDF-Struktur nicht lesbar (kein Katalog gefunden).');
    this.trailer = new Dict();
    this.trailer.set('Root', rootRef);
    // Objekt-Streams: enthaltene Objekte ergänzen
    for (const [num] of [...found]) {
      try {
        const o = await this.getObject(num);
        if (o instanceof Dict && isName(o.get('Type'), 'ObjStm')) {
          const st = await this.loadObjStm(num);
          st.nums.forEach((n, i) => this.setEntry(n, T_COMP, num, i));
        }
      } catch { /* defekte Objekte überspringen */ }
    }
  }

  // ------------------------------------------------------------------ Objekte
  async getObject(num: number): Promise<PdfObj> {
    const hit = this.cache.get(num);
    if (hit !== undefined || this.cache.has(num)) return hit as PdfObj;
    if (num >= this.xType.length) return null;
    let obj: PdfObj = null;
    const t = this.xType[num];
    if (t === T_INUSE) {
      const r = await this.parseIndirect(this.xA[num]);
      obj = r.obj;
      if (r.stream) this.streams.set(num, r.stream);
    } else if (t === T_COMP) {
      const st = await this.loadObjStm(this.xA[num]);
      let idx = this.xB[num];
      if (st.nums[idx] !== num) idx = st.nums.indexOf(num);
      if (idx >= 0) {
        const lx = new Lexer(st.buf, st.first + st.offs[idx]);
        const v = lx.parse();
        obj = v instanceof Cmd ? null : v;
      }
    }
    if (this.cache.size > 200_000) this.cache.clear();
    this.cache.set(num, obj);
    return obj;
  }

  async resolve(v: PdfObj | undefined): Promise<PdfObj> {
    let n = 0;
    while (v instanceof Ref && n++ < 32) v = await this.getObject(v.num);
    return v === undefined ? null : v;
  }

  async getStream(num: number): Promise<StreamInfo | null> {
    await this.getObject(num);
    return this.streams.get(num) ?? null;
  }

  async catalog(): Promise<Dict> {
    const c = await this.resolve(this.trailer.get('Root'));
    if (!(c instanceof Dict)) throw new Error('Katalog fehlt');
    return c;
  }

  private async loadObjStm(num: number): Promise<ObjStm> {
    const hit = this.objStms.get(num);
    if (hit) return hit;
    const d = await this.getObject(num);
    const info = this.streams.get(num);
    if (!(d instanceof Dict) || !info) throw new Error('Objekt-Stream fehlt');
    const buf = await collect(await this.openStream(info));
    const n = (await this.resolve(d.get('N'))) as number;
    const first = (await this.resolve(d.get('First'))) as number;
    const lx = new Lexer(buf);
    const nums: number[] = [], offs: number[] = [];
    for (let i = 0; i < n; i++) { nums.push(lx.parse() as number); offs.push(lx.parse() as number); }
    const st = { buf, nums, offs, first };
    if (this.objStms.size >= 6) this.objStms.delete(this.objStms.keys().next().value!);
    this.objStms.set(num, st);
    return st;
  }

  /** "n g obj … endobj" bei absolutem Offset. */
  async parseIndirect(off: number): Promise<{ num: number; obj: PdfObj; stream?: StreamInfo }> {
    let want = 4096;
    for (;;) {
      const buf = await this.read(off, off + want);
      const atEnd = off + buf.length >= this.size;
      try {
        const lx = new Lexer(buf);
        const n = lx.parse(), g = lx.parse(), kw = lx.parse();
        void g;
        if (typeof n !== 'number' || !(kw instanceof Cmd) || kw.cmd !== 'obj') throw new Error(`Objekt-Kopf bei ${off} ungültig`);
        let obj = lx.parse();
        if (obj instanceof Cmd) obj = null;
        let stream: StreamInfo | undefined;
        if (obj instanceof Dict) {
          lx.skipWs();
          if (lx.pos + 6 <= buf.length && latin1(buf, lx.pos, lx.pos + 6) === 'stream') {
            let ds = lx.pos + 6;
            if (buf[ds] === 13 && buf[ds + 1] === 10) ds += 2; else if (buf[ds] === 10 || buf[ds] === 13) ds++;
            let len = await this.resolve(obj.get('Length'));
            const start = off + ds;
            if (typeof len !== 'number' || len < 0 || start + len > this.size || !(await this.endstreamAt(start + len))) {
              len = await this.findEndstream(start);
            }
            stream = { dict: obj, start, length: len as number };
          }
        }
        return { num: n, obj: obj as PdfObj, stream };
      } catch (e) {
        if (e instanceof EofError && !atEnd && want < (1 << 26)) { want *= 4; continue; }
        throw e;
      }
    }
  }

  private async endstreamAt(pos: number): Promise<boolean> {
    const b = await this.read(pos, pos + 24);
    const t = latin1(b, 0, b.length);
    return /^\s*endstream/.test(t);
  }
  private async findEndstream(start: number): Promise<number> {
    const CH = 1 << 20;
    for (let base = start; base < this.size; base += CH) {
      const b = await this.read(base, base + CH + 16);
      const i = latin1(b, 0, b.length).indexOf('endstream');
      if (i >= 0) {
        let e = base + i;
        if (e > start && (await this.read(e - 1, e))[0] === 10) e--;
        if (e > start && (await this.read(e - 1, e))[0] === 13) e--;
        return e - start;
      }
    }
    return this.size - start;
  }

  // ------------------------------------------------------------------ Streams
  async filterSpecs(dict: Dict): Promise<FilterSpec[]> {
    const f = await this.resolve(dict.get('Filter') ?? dict.get('F'));
    if (f === null) return [];
    const names = (Array.isArray(f) ? f : [f]).map((x) => (x instanceof Name ? x.name : ''));
    const pr = await this.resolve(dict.get('DecodeParms') ?? dict.get('DP'));
    const parms = Array.isArray(pr) ? pr : [pr];
    const out: FilterSpec[] = [];
    for (let i = 0; i < names.length; i++) {
      const spec: FilterSpec = { name: names[i] };
      const p = await this.resolve(parms[i] as PdfObj);
      if (isDict(p)) {
        const num = async (k: string) => { const v = await this.resolve(p.get(k)); return typeof v === 'number' ? v : undefined; };
        spec.predictor = await num('Predictor');
        spec.columns = await num('Columns');
        spec.colors = await num('Colors');
        spec.bpc = await num('BitsPerComponent');
        spec.early = await num('EarlyChange');
      }
      out.push(spec);
    }
    return out;
  }

  /** Dekodierter Stream als ReadableStream. `onRaw` meldet gelesene Rohbytes (Fortschritt). */
  async openStream(info: StreamInfo, onRaw?: (n: number) => void): Promise<ReadableStream<Uint8Array>> {
    const specs = await this.filterSpecs(info.dict);
    let raw: ReadableStream<Uint8Array> = this.blob.slice(info.start, info.start + info.length).stream();
    if (onRaw) {
      raw = raw.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) { onRaw(c.length); ctl.enqueue(c); } }));
    }
    return applyFilters(raw, specs);
  }

  async readStream(num: number): Promise<Uint8Array | null> {
    const info = await this.getStream(num);
    return info ? collect(await this.openStream(info)) : null;
  }

  // ------------------------------------------------------------------ Seiten
  async pageCount(): Promise<number> {
    const pages = await this.resolve((await this.catalog()).get('Pages'));
    const n = isDict(pages) ? await this.resolve(pages.get('Count')) : 0;
    return typeof n === 'number' ? n : 0;
  }

  /** Seite (0-basiert) mit geerbten Attributen. */
  async getPage(index: number): Promise<PageInfo> {
    const root = await this.resolve((await this.catalog()).get('Pages'));
    let counter = index;
    const walk = async (node: PdfObj, inherited: Inherited, depth: number): Promise<PageInfo | null> => {
      if (!(node instanceof Dict) || depth > 40) return null;
      const inh: Inherited = { ...inherited };
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const) { const v = node.get(k); if (v !== undefined) inh[k] = v; }
      const kids = await this.resolve(node.get('Kids'));
      if (!Array.isArray(kids)) {
        if (counter-- === 0) return this.makePage(node, inh);
        return null;
      }
      for (const kid of kids) {
        const k = await this.resolve(kid);
        if (!(k instanceof Dict)) continue;
        const isPages = isName(await this.resolve(k.get('Type')), 'Pages') || k.has('Kids');
        if (isPages) {
          const cnt = await this.resolve(k.get('Count'));
          if (typeof cnt === 'number' && counter >= cnt) { counter -= cnt; continue; }
        }
        const r = await walk(k, inh, depth + 1);
        if (r) return r;
      }
      return null;
    };
    const page = await walk(root, {}, 0);
    if (!page) throw new Error(`Seite ${index + 1} nicht gefunden`);
    return page;
  }

  private async makePage(node: Dict, inh: Inherited): Promise<PageInfo> {
    const mb = (await this.resolve(inh.MediaBox ?? null)) as PdfObj;
    let box: [number, number, number, number] = [0, 0, 612, 792];
    if (Array.isArray(mb)) {
      const v: number[] = [];
      for (const x of mb) { const r = await this.resolve(x); if (typeof r === 'number') v.push(r); }
      if (v.length === 4) box = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
    }
    const contents: number[] = [];
    const c = node.get('Contents');
    const addC = async (v: PdfObj | undefined) => {
      if (v instanceof Ref) {
        const r = await this.getObject(v.num);
        if (Array.isArray(r)) { for (const x of r) await addC(x); } else contents.push(v.num);
      } else if (Array.isArray(v)) for (const x of v) await addC(x);
    };
    await addC(c);
    return { dict: node, box, resources: inh.Resources ?? null, contents };
  }
}

type Inherited = Partial<Record<'Resources' | 'MediaBox' | 'CropBox' | 'Rotate', PdfObj>>;

export interface PageInfo {
  dict: Dict;
  box: [number, number, number, number];
  resources: PdfObj;
  contents: number[]; // Objektnummern der Inhaltsströme
}
