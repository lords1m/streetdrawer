import type { PdfDocument } from './document';
import { collect, iterate } from './filters';
import { Dict, Ref, isDict, isName, type PdfObj } from './model';

/** Stil-Schlüssel: Ebene (Marked Content), Art (0 Strich / 1 Fläche), RGB, Strichstärke in 1/20 pt. */
export function makeKey(oc: number, kind: number, rgb: number, wq: number): number {
  return ((oc * 2 + kind) * 16777216 + rgb) * 4096 + wq;
}
export function decodeKey(key: number) {
  const wq = key % 4096;
  const rest = (key - wq) / 4096;
  const rgb = rest % 16777216;
  const r2 = (rest - rgb) / 16777216;
  const kind = r2 % 2;
  return { oc: (r2 - kind) / 2, kind, rgb, width: wq / 20 };
}

export interface PathSink {
  /** Ein gezeichneter Pfad. pts: x,y-Paare in Seitenkoordinaten; subStart[i]: Startpunkt-Index des Teilpfads i. */
  paint(key: number, nPts: number, pts: Float64Array, nSub: number, subStart: Uint32Array, closed: Uint8Array): void;
}

export interface InterpOptions {
  /** Kurven in Polygonzüge auflösen (Durchgang 2). Sonst nur Endpunkte (Durchgang 1). */
  flatten: boolean;
  onChunk?: () => void;
}

interface Res { xobj: Map<string, Ref>; gsLW: Map<string, number>; props: Map<string, string> }
interface FormCache { bytes: Uint8Array; matrix: number[]; res: Res }

const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const code = (s: string) => s.charCodeAt(0) | ((s.charCodeAt(1) || 0) << 8) | ((s.charCodeAt(2) || 0) << 16) | (s.length > 3 ? 1 << 24 : 0);
const enum Op {
  q = 1, Q, cm, w, gs, m, l, c, v, y, h, re, S, s, f, B, b, n, W, g, G, rg, RG, k, K, sc, SC, Do, BI, BDC, BMC, EMC,
}
const OPMAP = new Map<number, number>([
  ['q', Op.q], ['Q', Op.Q], ['cm', Op.cm], ['w', Op.w], ['gs', Op.gs],
  ['m', Op.m], ['l', Op.l], ['c', Op.c], ['v', Op.v], ['y', Op.y], ['h', Op.h], ['re', Op.re],
  ['S', Op.S], ['s', Op.s], ['f', Op.f], ['F', Op.f], ['f*', Op.f], ['B', Op.B], ['B*', Op.B], ['b', Op.b], ['b*', Op.b], ['n', Op.n],
  ['W', Op.W], ['W*', Op.W],
  ['g', Op.g], ['G', Op.G], ['rg', Op.rg], ['RG', Op.RG], ['k', Op.k], ['K', Op.K],
  ['sc', Op.sc], ['scn', Op.sc], ['SC', Op.SC], ['SCN', Op.SC],
  ['Do', Op.Do], ['BI', Op.BI], ['BDC', Op.BDC], ['BMC', Op.BMC], ['EMC', Op.EMC],
].map(([s, o]) => [code(s as string), o as number]));

const byte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
const rgbOf = (r: number, g: number, b: number) => (byte(r) << 16) | (byte(g) << 8) | byte(b);
const cmykOf = (c: number, m: number, y: number, k: number) => rgbOf((1 - Math.min(1, c)) * (1 - Math.min(1, k)), (1 - Math.min(1, m)) * (1 - Math.min(1, k)), (1 - Math.min(1, y)) * (1 - Math.min(1, k)));

const STACK = 96;

export class ContentInterpreter {
  // Grafikzustand
  private a = 1; private b = 0; private c = 0; private d = 1; private e = 0; private f = 0;
  private lw = 1; private stroke = 0; private fill = 0;
  private gs = new Float64Array(STACK * 9); private sp = 0;
  // Marked Content / Ebenen
  private ocStack = new Int32Array(256); private ocTop = 0; private oc = 0;
  readonly ocNames: string[] = ['']; private ocIndex = new Map<string, number>();
  // Operanden
  private ops = new Float64Array(256); private nops = 0; private lastName: string | null = null; private nameOperand = false;
  // Pfad
  private px = new Float64Array(1 << 12); private n = 0;
  private subStart = new Uint32Array(256); private closed = new Uint8Array(256); private nsub = 0;
  private lx = 0; private ly = 0; private sx = 0; private sy = 0;
  // Zähler
  opCount = 0;
  pathCount = 0;
  private resCache = new Map<object | number, Res>();
  private formCache = new Map<number, FormCache>();
  private formBytes = 0;
  private active = new Set<number>();
  private cur: Res = { xobj: new Map(), gsLW: new Map(), props: new Map() };

  constructor(private doc: PdfDocument, private sink: PathSink, private opt: InterpOptions) {}

  // ------------------------------------------------------------------ Resources
  async prepareRes(raw: PdfObj): Promise<Res> {
    const key: object | number | null = raw instanceof Ref ? raw.num : raw instanceof Dict ? raw : null;
    if (key !== null) { const hit = this.resCache.get(key); if (hit) return hit; }
    const res: Res = { xobj: new Map(), gsLW: new Map(), props: new Map() };
    const d = await this.doc.resolve(raw);
    if (isDict(d)) {
      const xo = await this.doc.resolve(d.get('XObject'));
      if (isDict(xo)) for (const k of xo.keys()) { const v = xo.get(k); if (v instanceof Ref) res.xobj.set(k, v); }
      const eg = await this.doc.resolve(d.get('ExtGState'));
      if (isDict(eg)) {
        for (const k of eg.keys()) {
          const g = await this.doc.resolve(eg.get(k));
          if (isDict(g)) { const lw = await this.doc.resolve(g.get('LW')); if (typeof lw === 'number') res.gsLW.set(k, lw); }
        }
      }
      const pr = await this.doc.resolve(d.get('Properties'));
      if (isDict(pr)) {
        for (const k of pr.keys()) {
          const o = await this.doc.resolve(pr.get(k));
          if (isDict(o)) { const nm = await this.doc.resolve(o.get('Name')); if (typeof nm === 'string') res.props.set(k, nm); }
        }
      }
    }
    if (key !== null) this.resCache.set(key, res);
    return res;
  }

  // ------------------------------------------------------------------ Einstiegspunkte
  async runPage(contents: number[], resources: PdfObj, onRaw?: (n: number) => void) {
    this.cur = await this.prepareRes(resources);
    for (const num of contents) {
      const info = await this.doc.getStream(num);
      if (!info) continue;
      await this.exec(await this.doc.openStream(info, onRaw), 0);
    }
  }

  private async exec(stream: ReadableStream<Uint8Array>, depth: number) {
    let carry: Uint8Array | null = null;
    this.nops = 0;
    const step = async (buf: Uint8Array, final: boolean): Promise<number> => {
      let pos = 0;
      for (;;) {
        const r = this.run(buf, pos, buf.length, final);
        pos = r.pos;
        if (r.doName !== null) { await this.doForm(r.doName, depth); continue; }
        return pos;
      }
    };
    for await (const chunk of iterate(stream)) {
      let buf = chunk;
      if (carry) { buf = new Uint8Array(carry.length + chunk.length); buf.set(carry); buf.set(chunk, carry.length); }
      const pos = await step(buf, false);
      carry = pos < buf.length ? buf.subarray(pos) : null;
      this.opt.onChunk?.();
    }
    if (carry) await step(carry, true);
  }

  private async runBytes(buf: Uint8Array, depth: number) {
    this.nops = 0;
    let pos = 0;
    for (;;) {
      const r = this.run(buf, pos, buf.length, true);
      pos = r.pos;
      if (r.doName !== null) { await this.doForm(r.doName, depth); continue; }
      return;
    }
  }

  // ------------------------------------------------------------------ Formulare (XObjects)
  private async doForm(name: string, depth: number) {
    const ref = this.cur.xobj.get(name);
    if (!ref || depth > 14 || this.active.has(ref.num)) return;
    let fc = this.formCache.get(ref.num);
    let info = null;
    if (!fc) {
      info = await this.doc.getStream(ref.num);
      if (!info) return;
      const st = await this.doc.resolve(info.dict.get('Subtype'));
      if (!isName(st, 'Form')) return;
    }
    const savedCur = this.cur;
    this.saveState();
    const savedPath = this.n, savedSub = this.nsub;
    this.active.add(ref.num);
    try {
      if (!fc) {
        const dict = info!.dict;
        const mArr = await this.doc.resolve(dict.get('Matrix'));
        const matrix = Array.isArray(mArr) ? (mArr as PdfObj[]).map((x) => (typeof x === 'number' ? x : 0)) : [1, 0, 0, 1, 0, 0];
        const res = dict.has('Resources') ? await this.prepareRes(dict.get('Resources')!) : this.cur;
        if (info!.length <= 262144) {
          const bytes = await collect(await this.doc.openStream(info!));
          fc = { bytes, matrix, res };
          if (this.formBytes + bytes.length > 48 << 20) { this.formCache.clear(); this.formBytes = 0; }
          this.formCache.set(ref.num, fc); this.formBytes += bytes.length;
        } else {
          this.concat(matrix);
          this.cur = res;
          this.n = 0; this.nsub = 0;
          await this.exec(await this.doc.openStream(info!), depth + 1);
          return;
        }
      }
      this.concat(fc.matrix);
      this.cur = fc.res;
      this.n = 0; this.nsub = 0;
      await this.runBytes(fc.bytes, depth + 1);
    } finally {
      this.active.delete(ref.num);
      this.restoreState();
      this.cur = savedCur;
      this.n = savedPath; this.nsub = savedSub;
      this.nops = 0;
    }
  }

  // ------------------------------------------------------------------ Grafikzustand
  private saveState() {
    if (this.sp >= STACK) return;
    const o = this.sp++ * 9;
    const g = this.gs;
    g[o] = this.a; g[o + 1] = this.b; g[o + 2] = this.c; g[o + 3] = this.d; g[o + 4] = this.e; g[o + 5] = this.f;
    g[o + 6] = this.lw; g[o + 7] = this.stroke; g[o + 8] = this.fill;
  }
  private restoreState() {
    if (this.sp === 0) return;
    const o = --this.sp * 9;
    const g = this.gs;
    this.a = g[o]; this.b = g[o + 1]; this.c = g[o + 2]; this.d = g[o + 3]; this.e = g[o + 4]; this.f = g[o + 5];
    this.lw = g[o + 6]; this.stroke = g[o + 7]; this.fill = g[o + 8];
  }
  private concat(m: number[]) {
    // neue CTM = m × CTM
    const [ma, mb, mc, md, me, mf] = m;
    const a = ma * this.a + mb * this.c, b = ma * this.b + mb * this.d;
    const c = mc * this.a + md * this.c, d = mc * this.b + md * this.d;
    const e = me * this.a + mf * this.c + this.e, f = me * this.b + mf * this.d + this.f;
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }

  // ------------------------------------------------------------------ Pfad
  private addPt(x: number, y: number) {
    if (this.n * 2 + 2 > this.px.length) { const nb = new Float64Array(this.px.length * 2); nb.set(this.px); this.px = nb; }
    const i = this.n++ * 2;
    this.px[i] = x; this.px[i + 1] = y;
    this.lx = x; this.ly = y;
  }
  private newSub(x: number, y: number) {
    if (this.nsub === this.subStart.length) {
      const s = new Uint32Array(this.nsub * 2); s.set(this.subStart); this.subStart = s;
      const c = new Uint8Array(this.nsub * 2); c.set(this.closed); this.closed = c;
    }
    this.subStart[this.nsub] = this.n; this.closed[this.nsub] = 0; this.nsub++;
    this.addPt(x, y);
    this.sx = x; this.sy = y;
  }
  private curve(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    if (!this.opt.flatten) { this.addPt(x3, y3); return; }
    const x0 = this.lx, y0 = this.ly;
    const L = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.min(24, Math.max(2, Math.ceil(Math.sqrt(L) * 0.9)));
    for (let i = 1; i < n; i++) {
      const t = i / n, u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      this.addPt(w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3, w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3);
    }
    this.addPt(x3, y3);
  }

  private paintPath(doStroke: boolean, doFill: boolean, close: boolean) {
    if (this.nsub === 0) return;
    if (close && this.nsub > 0 && !this.closed[this.nsub - 1]) this.closePath();
    this.pathCount++;
    if (doStroke) {
      const scale = Math.sqrt(Math.abs(this.a * this.d - this.b * this.c));
      const wq = Math.min(4095, Math.round(this.lw * scale * 20));
      this.sink.paint(makeKey(this.oc, 0, this.stroke, wq), this.n, this.px, this.nsub, this.subStart, this.closed);
    } else if (doFill) {
      this.sink.paint(makeKey(this.oc, 1, this.fill, 0), this.n, this.px, this.nsub, this.subStart, this.closed);
    }
  }
  private closePath() {
    if (this.nsub === 0) return;
    this.closed[this.nsub - 1] = 1;
    if (this.lx !== this.sx || this.ly !== this.sy) this.addPt(this.sx, this.sy);
  }

  // ------------------------------------------------------------------ Tokenizer + Interpreter
  /** Verarbeitet buf[p..end). Gibt die Position vor einem unvollständigen Token zurück (außer final) oder nach einem `Do`. */
  private run(buf: Uint8Array, p: number, end: number, final: boolean): { pos: number; doName: string | null } {
    const ops = this.ops;
    let nops = this.nops;
    while (p < end) {
      const ch = buf[p];
      if (ch <= 32) { p++; continue; }
      // ---- Zahl
      if ((ch >= 48 && ch <= 57) || ch === 45 || ch === 43 || ch === 46) {
        let q = p, neg = false;
        while (q < end && (buf[q] === 45 || buf[q] === 43)) { if (buf[q] === 45) neg = true; q++; }
        let v = 0, dg = 0;
        while (q < end && (dg = buf[q] - 48) >= 0 && dg <= 9) { v = v * 10 + dg; q++; }
        if (q < end && buf[q] === 46) {
          q++;
          let sc = 0.1;
          while (q < end && (dg = buf[q] - 48) >= 0 && dg <= 9) { v += dg * sc; sc *= 0.1; q++; }
        }
        if (q >= end && !final) { this.nops = nops; return { pos: p, doName: null }; }
        while (q < end && buf[q] > 32 && DELIM[buf[q]] === 0) q++; // Reste ("1e5", "1.2.3")
        if (nops < 256) ops[nops++] = neg ? -v : v;
        p = q;
        continue;
      }
      // ---- Name
      if (ch === 47) {
        let q = p + 1, esc = false;
        while (q < end && buf[q] > 32 && DELIM[buf[q]] === 0) { if (buf[q] === 35) esc = true; q++; }
        if (q >= end && !final) { this.nops = nops; return { pos: p, doName: null }; }
        let s = '';
        for (let i = p + 1; i < q; i++) {
          if (esc && buf[i] === 35 && i + 2 < q) { s += String.fromCharCode(parseInt(String.fromCharCode(buf[i + 1], buf[i + 2]), 16) || 0); i += 2; }
          else s += String.fromCharCode(buf[i]);
        }
        if (this.lastName !== null) this.prevName = this.lastName;
        this.lastName = s; this.nameOperand = true;
        p = q;
        continue;
      }
      // ---- Strings, Dicts, Kommentare
      if (ch === 40) { // (
        let q = p + 1, depth = 1;
        while (q < end) {
          const x = buf[q++];
          if (x === 92) q++;
          else if (x === 40) depth++;
          else if (x === 41 && --depth === 0) break;
        }
        if (depth !== 0 && !final) { this.nops = nops; return { pos: p, doName: null }; }
        p = q;
        continue;
      }
      if (ch === 60) { // <
        if (p + 1 < end && buf[p + 1] === 60) { p += 2; continue; }
        if (p + 1 >= end && !final) { this.nops = nops; return { pos: p, doName: null }; }
        let q = p + 1;
        while (q < end && buf[q] !== 62) q++;
        if (q >= end && !final) { this.nops = nops; return { pos: p, doName: null }; }
        p = q + 1;
        continue;
      }
      if (ch === 62) { p += (p + 1 < end && buf[p + 1] === 62) ? 2 : 1; continue; }
      if (ch === 37) { while (p < end && buf[p] !== 10 && buf[p] !== 13) p++; continue; }
      if (DELIM[ch] === 1) { p++; continue; } // [ ] { } )

      // ---- Operator
      let q = p + 1;
      while (q < end && buf[q] > 32 && DELIM[buf[q]] === 0) q++;
      if (q >= end && !final) { this.nops = nops; return { pos: p, doName: null }; }
      const len = q - p;
      const k = buf[p] | (len > 1 ? buf[p + 1] << 8 : 0) | (len > 2 ? buf[p + 2] << 16 : 0) | (len > 3 ? 1 << 24 : 0);
      const op = OPMAP.get(k);
      this.opCount++;
      if (op !== undefined) {
        switch (op) {
          case Op.q: this.saveState(); break;
          case Op.Q: this.restoreState(); break;
          case Op.cm: if (nops >= 6) this.concat([ops[nops - 6], ops[nops - 5], ops[nops - 4], ops[nops - 3], ops[nops - 2], ops[nops - 1]]); break;
          case Op.w: if (nops >= 1) this.lw = ops[nops - 1]; break;
          case Op.gs: if (this.lastName !== null) { const lw = this.cur.gsLW.get(this.lastName); if (lw !== undefined) this.lw = lw; } break;
          case Op.m: if (nops >= 2) this.newSub(this.a * ops[nops - 2] + this.c * ops[nops - 1] + this.e, this.b * ops[nops - 2] + this.d * ops[nops - 1] + this.f); break;
          case Op.l:
            if (nops >= 2) {
              const x = this.a * ops[nops - 2] + this.c * ops[nops - 1] + this.e, y = this.b * ops[nops - 2] + this.d * ops[nops - 1] + this.f;
              if (this.nsub === 0) this.newSub(x, y);
              else if (this.closed[this.nsub - 1]) { this.newSub(this.sx, this.sy); this.addPt(x, y); }
              else this.addPt(x, y);
            }
            break;
          case Op.c:
            if (nops >= 6 && this.nsub > 0) {
              const o = nops - 6, A = this.a, B = this.b, C = this.c, D = this.d, E = this.e, F = this.f;
              this.curve(A * ops[o] + C * ops[o + 1] + E, B * ops[o] + D * ops[o + 1] + F, A * ops[o + 2] + C * ops[o + 3] + E, B * ops[o + 2] + D * ops[o + 3] + F, A * ops[o + 4] + C * ops[o + 5] + E, B * ops[o + 4] + D * ops[o + 5] + F);
            }
            break;
          case Op.v:
            if (nops >= 4 && this.nsub > 0) {
              const o = nops - 4, A = this.a, B = this.b, C = this.c, D = this.d, E = this.e, F = this.f;
              this.curve(this.lx, this.ly, A * ops[o] + C * ops[o + 1] + E, B * ops[o] + D * ops[o + 1] + F, A * ops[o + 2] + C * ops[o + 3] + E, B * ops[o + 2] + D * ops[o + 3] + F);
            }
            break;
          case Op.y:
            if (nops >= 4 && this.nsub > 0) {
              const o = nops - 4, A = this.a, B = this.b, C = this.c, D = this.d, E = this.e, F = this.f;
              const x3 = A * ops[o + 2] + C * ops[o + 3] + E, y3 = B * ops[o + 2] + D * ops[o + 3] + F;
              this.curve(A * ops[o] + C * ops[o + 1] + E, B * ops[o] + D * ops[o + 1] + F, x3, y3, x3, y3);
            }
            break;
          case Op.h: this.closePath(); break;
          case Op.re:
            if (nops >= 4) {
              const o = nops - 4, x = ops[o], y = ops[o + 1], w = ops[o + 2], h = ops[o + 3];
              const A = this.a, B = this.b, C = this.c, D = this.d, E = this.e, F = this.f;
              this.newSub(A * x + C * y + E, B * x + D * y + F);
              this.addPt(A * (x + w) + C * y + E, B * (x + w) + D * y + F);
              this.addPt(A * (x + w) + C * (y + h) + E, B * (x + w) + D * (y + h) + F);
              this.addPt(A * x + C * (y + h) + E, B * x + D * (y + h) + F);
              this.closed[this.nsub - 1] = 1;
              this.addPt(this.sx, this.sy);
            }
            break;
          case Op.S: this.paintPath(true, false, false); this.n = 0; this.nsub = 0; break;
          case Op.s: this.paintPath(true, false, true); this.n = 0; this.nsub = 0; break;
          case Op.f: this.paintPath(false, true, false); this.n = 0; this.nsub = 0; break;
          case Op.B: this.paintPath(true, true, false); this.n = 0; this.nsub = 0; break;
          case Op.b: this.paintPath(true, true, true); this.n = 0; this.nsub = 0; break;
          case Op.n: this.n = 0; this.nsub = 0; break;
          case Op.W: break;
          case Op.g: if (nops >= 1) this.fill = rgbOf(ops[nops - 1], ops[nops - 1], ops[nops - 1]); break;
          case Op.G: if (nops >= 1) this.stroke = rgbOf(ops[nops - 1], ops[nops - 1], ops[nops - 1]); break;
          case Op.rg: if (nops >= 3) this.fill = rgbOf(ops[nops - 3], ops[nops - 2], ops[nops - 1]); break;
          case Op.RG: if (nops >= 3) this.stroke = rgbOf(ops[nops - 3], ops[nops - 2], ops[nops - 1]); break;
          case Op.k: if (nops >= 4) this.fill = cmykOf(ops[nops - 4], ops[nops - 3], ops[nops - 2], ops[nops - 1]); break;
          case Op.K: if (nops >= 4) this.stroke = cmykOf(ops[nops - 4], ops[nops - 3], ops[nops - 2], ops[nops - 1]); break;
          case Op.sc: this.fill = this.colorFrom(ops, nops); break;
          case Op.SC: this.stroke = this.colorFrom(ops, nops); break;
          case Op.BDC: case Op.BMC: {
            if (this.ocTop < 255) {
              let next = this.oc;
              if (op === Op.BDC && this.prevName === 'OC' && this.lastName !== null) {
                const nm = this.cur.props.get(this.lastName);
                if (nm !== undefined) {
                  let idx = this.ocIndex.get(nm);
                  if (idx === undefined && this.ocNames.length < 250) { idx = this.ocNames.length; this.ocNames.push(nm); this.ocIndex.set(nm, idx); }
                  if (idx !== undefined) next = idx;
                }
              }
              this.ocStack[this.ocTop++] = this.oc;
              this.oc = next;
            }
            break;
          }
          case Op.EMC: if (this.ocTop > 0) this.oc = this.ocStack[--this.ocTop]; break;
          case Op.Do: {
            const name = this.lastName;
            this.nops = 0; nops = 0; this.lastName = null; this.prevName = null; this.nameOperand = false;
            if (name !== null) return { pos: q, doName: name };
            break;
          }
          case Op.BI: {
            // Inline-Bild überspringen: "ID" … Binärdaten … "EI"
            const skip = skipInlineImage(buf, q, end, final);
            if (skip < 0) { this.nops = nops; return { pos: p, doName: null }; }
            q = skip;
            break;
          }
        }
      }
      nops = 0; this.lastName = null; this.prevName = null; this.nameOperand = false;
      p = q;
    }
    this.nops = nops;
    return { pos: p, doName: null };
  }
  private prevName: string | null = null;

  private colorFrom(ops: Float64Array, n: number): number {
    if (this.nameOperand) return 0x7f7f7f; // Pattern/benannte Farbe: nicht auswertbar
    if (n >= 4) return cmykOf(ops[n - 4], ops[n - 3], ops[n - 2], ops[n - 1]);
    if (n >= 3) return rgbOf(ops[n - 3], ops[n - 2], ops[n - 1]);
    if (n >= 1) return rgbOf(ops[n - 1], ops[n - 1], ops[n - 1]);
    return 0;
  }
}

/** Liefert die Position hinter "EI" oder -1 (unvollständig, mehr Daten nötig). */
function skipInlineImage(b: Uint8Array, p: number, end: number, final: boolean): number {
  let id = -1;
  for (let i = p; i + 2 < end + (final ? 1 : 0) && i + 1 < end; i++) {
    if (b[i] === 73 && b[i + 1] === 68 && (i === p || b[i - 1] <= 32) && (i + 2 >= end ? final : b[i + 2] <= 32)) { id = i; break; }
  }
  if (id < 0) return final ? end : -1;
  let ds = id + 2;
  if (ds < end && b[ds] <= 32) ds++;
  for (let i = ds; i + 1 < end; i++) {
    if (b[i] === 69 && b[i + 1] === 73 && (i === ds || b[i - 1] <= 32) && (i + 2 >= end ? final : b[i + 2] <= 32 || DELIM[b[i + 2]] === 1)) {
      // Plausibilität: danach kein Binärmüll
      let ok = true;
      for (let k = i + 2; k < Math.min(end, i + 12); k++) if (b[k] > 127 || (b[k] < 9 && b[k] !== 0)) { ok = false; break; }
      if (ok) return i + 2;
    }
  }
  return final ? end : -1;
}

