/** Wachsende Typed-Array-Puffer, vermeiden Array-Overhead bei Millionen Einträgen. */
export class GrowF64 {
  a: Float64Array; n = 0;
  constructor(cap = 1024) { this.a = new Float64Array(cap); }
  push(v: number) {
    if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  toArray() { return this.a.slice(0, this.n); }
}
export class GrowF32 {
  a: Float32Array; n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  push(v: number) {
    if (this.n === this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  toArray() { return this.a.slice(0, this.n); }
}
export class GrowU32 {
  a: Uint32Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint32Array(cap); }
  push(v: number) {
    if (this.n === this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  toArray() { return this.a.slice(0, this.n); }
}

/** Offene Adressierung: (int,int) -> int. Für Knoten-Snapping und Kanten-Deduplizierung. */
export class IntPairMap {
  private ka: Int32Array; private kb: Int32Array; private v: Int32Array;
  private mask: number; size = 0;
  constructor(cap = 1 << 12) {
    let c = 1; while (c < cap) c <<= 1;
    this.ka = new Int32Array(c); this.kb = new Int32Array(c); this.v = new Int32Array(c).fill(-1);
    this.mask = c - 1;
  }
  private slot(a: number, b: number) {
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0;
    h ^= h >>> 15;
    let i = h & this.mask;
    while (this.v[i] !== -1 && (this.ka[i] !== a || this.kb[i] !== b)) i = (i + 1) & this.mask;
    return i;
  }
  get(a: number, b: number): number { return this.v[this.slot(a, b)]; }
  set(a: number, b: number, val: number) {
    if ((this.size + 1) * 2 > this.v.length) this.grow();
    const i = this.slot(a, b);
    if (this.v[i] === -1) this.size++;
    this.ka[i] = a; this.kb[i] = b; this.v[i] = val;
  }
  private grow() {
    const oa = this.ka, ob = this.kb, ov = this.v;
    const c = ov.length * 2;
    this.ka = new Int32Array(c); this.kb = new Int32Array(c); this.v = new Int32Array(c).fill(-1);
    this.mask = c - 1; this.size = 0;
    for (let i = 0; i < ov.length; i++) if (ov[i] !== -1) this.set(oa[i], ob[i], ov[i]);
  }
}
