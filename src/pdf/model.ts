/** PDF-Objektmodell und Lexer für Struktur-Objekte (nicht für Inhaltsströme – die haben einen eigenen, schnellen Tokenizer). */

export class Name { constructor(readonly name: string) {} }
export class Ref { constructor(readonly num: number, readonly gen: number) {} }
export class Cmd { constructor(readonly cmd: string) {} }

export type PdfObj = null | boolean | number | string | Name | Ref | PdfObj[] | Dict;

export class Dict {
  readonly map = new Map<string, PdfObj>();
  get(key: string): PdfObj | undefined { return this.map.get(key); }
  set(key: string, v: PdfObj) { this.map.set(key, v); }
  has(key: string) { return this.map.has(key); }
  keys() { return this.map.keys(); }
}

export class EofError extends Error { constructor() { super('PDF: unerwartetes Ende'); } }

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
export const isWs = (c: number) => WS[c] === 1;
export const isDelim = (c: number) => DELIM[c] === 1;
export const isRegular = (c: number) => WS[c] === 0 && DELIM[c] === 0;

export class Lexer {
  /** complete: der Puffer enthält das Objekt vollständig – ein Token darf am Pufferende enden. */
  constructor(public buf: Uint8Array, public pos = 0, public complete = false) {}

  skipWs() {
    const b = this.buf;
    for (;;) {
      while (this.pos < b.length && WS[b[this.pos]]) this.pos++;
      if (this.pos < b.length && b[this.pos] === 37) { // % Kommentar
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
        continue;
      }
      return;
    }
  }

  /** Nächstes Objekt; Schlüsselwörter (obj, endobj, stream, …) kommen als Cmd. */
  parse(): PdfObj | Cmd {
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) throw new EofError();
    const c = b[this.pos];
    if (c === 47) return this.name();
    if (c === 40) return this.string();
    if (c === 60) {
      if (b[this.pos + 1] === 60) return this.dict();
      return this.hex();
    }
    if (c === 91) {
      this.pos++;
      const arr: PdfObj[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) throw new EofError();
        if (b[this.pos] === 93) { this.pos++; return arr; }
        const v = this.parse();
        if (v instanceof Cmd) { if (v.cmd === 'endobj') throw new EofError(); continue; }
        arr.push(v);
      }
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) return this.numberOrRef();
    // Schlüsselwort
    const s = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    if (this.pos === s) { this.pos++; return new Cmd(String.fromCharCode(c)); } // verirrtes Trennzeichen
    const w = latin1(b, s, this.pos);
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Cmd(w);
  }

  private numberOrRef(): PdfObj {
    const b = this.buf;
    const start = this.pos;
    let p = start;
    if (b[p] === 43 || b[p] === 45) p++;
    let isInt = true;
    while (p < b.length && ((b[p] >= 48 && b[p] <= 57) || b[p] === 46)) { if (b[p] === 46) isInt = false; p++; }
    if (p >= b.length && !this.complete) throw new EofError();
    const v = Number(latin1(b, start, p)) || 0;
    this.pos = p;
    if (isInt && v >= 0 && b[start] !== 43 && b[start] !== 45) {
      // Ref-Vorausschau: <gen> R
      let q = p;
      while (q < b.length && WS[b[q]]) q++;
      const g0 = q;
      while (q < b.length && b[q] >= 48 && b[q] <= 57) q++;
      if (q > g0 && q < b.length) {
        const gen = Number(latin1(b, g0, q));
        let r = q;
        while (r < b.length && WS[b[r]]) r++;
        if (r < b.length && b[r] === 82 && (r + 1 >= b.length || !isRegular(b[r + 1]))) {
          this.pos = r + 1;
          return new Ref(v, gen);
        }
      } else if (q >= b.length && !this.complete) throw new EofError();
    }
    return v;
  }

  private name(): Name {
    const b = this.buf;
    this.pos++;
    let s = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 35 && this.pos + 2 < b.length) {
        const h = parseInt(latin1(b, this.pos + 1, this.pos + 3), 16);
        if (!Number.isNaN(h)) { s += String.fromCharCode(h); this.pos += 3; continue; }
      }
      s += String.fromCharCode(c); this.pos++;
    }
    if (this.pos >= b.length && !this.complete) throw new EofError();
    return new Name(s);
  }

  private string(): string {
    const b = this.buf;
    this.pos++;
    let depth = 1;
    const out: number[] = [];
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 92) {
        const n = b[this.pos++];
        if (n === 110) out.push(10); else if (n === 114) out.push(13); else if (n === 116) out.push(9);
        else if (n === 98) out.push(8); else if (n === 102) out.push(12);
        else if (n >= 48 && n <= 55) {
          let v = n - 48;
          for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + b[this.pos++] - 48;
          out.push(v & 255);
        } else if (n === 13) { if (b[this.pos] === 10) this.pos++; }
        else if (n === 10) { /* Zeilenfortsetzung */ }
        else out.push(n);
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (--depth === 0) return decodeText(out); out.push(c); }
      else out.push(c);
    }
    throw new EofError();
  }

  private hex(): string {
    const b = this.buf;
    this.pos++;
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 62) { if (hi >= 0) out.push(hi << 4); return decodeText(out); }
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
    }
    throw new EofError();
  }

  private dict(): Dict {
    const b = this.buf;
    this.pos += 2;
    const d = new Dict();
    for (;;) {
      this.skipWs();
      if (this.pos >= b.length) throw new EofError();
      if (b[this.pos] === 62 && b[this.pos + 1] === 62) { this.pos += 2; return d; }
      const k = this.parse();
      if (!(k instanceof Name)) { if (k instanceof Cmd && (k.cmd === 'endobj' || k.cmd === 'stream')) throw new EofError(); continue; }
      const v = this.parse();
      if (v instanceof Cmd) continue;
      d.set(k.name, v);
    }
  }
}

export function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192)) as unknown as number[]);
  return out;
}

function decodeText(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (bytes.some((x) => x > 127)) {
    // viele Erzeuger schreiben UTF-8 statt PDFDocEncoding
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { /* latin1 */ }
  }
  return String.fromCharCode(...bytes);
}

export const isDict = (v: unknown): v is Dict => v instanceof Dict;
export const isName = (v: unknown, n?: string): v is Name => v instanceof Name && (n === undefined || v.name === n);
export const isRef = (v: unknown): v is Ref => v instanceof Ref;
