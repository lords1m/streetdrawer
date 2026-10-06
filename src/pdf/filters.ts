/** Stream-Filter als Web-Streams: Flate (nativ), ASCIIHex, ASCII85, LZW, RunLength sowie PNG-/TIFF-Prädiktoren. */

export interface FilterSpec { name: string; columns?: number; colors?: number; bpc?: number; predictor?: number; early?: number }

/** Liest einen Stream bis zum Ende; Fehler (z. B. abgeschnittene Flate-Daten) beenden still und liefern das Bisherige. */
export async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const r = stream.getReader();
  try {
    for (;;) {
      let v: ReadableStreamReadResult<Uint8Array>;
      try { v = await r.read(); } catch { return; }
      if (v.done) return;
      if (v.value.length) yield v.value;
    }
  } finally { try { r.releaseLock(); } catch { /* ignore */ } }
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of iterate(stream)) { parts.push(c); n += c.length; }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function applyFilters(raw: ReadableStream<Uint8Array>, filters: FilterSpec[]): ReadableStream<Uint8Array> {
  let s = raw;
  for (const f of filters) {
    switch (f.name) {
      case 'FlateDecode': case 'Fl':
        s = s.pipeThrough(new DecompressionStream('deflate') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
        s = predictor(s, f);
        break;
      case 'ASCIIHexDecode': case 'AHx': s = s.pipeThrough(hexDecoder()); break;
      case 'ASCII85Decode': case 'A85': s = s.pipeThrough(ascii85Decoder()); break;
      case 'LZWDecode': case 'LZW': s = predictor(wholeBuffer(s, (b) => lzwDecode(b, f.early ?? 1)), f); break;
      case 'RunLengthDecode': case 'RL': s = wholeBuffer(s, runLengthDecode); break;
      case 'Crypt': break;
      default: throw new Error(`Nicht unterstützter PDF-Filter: ${f.name}`);
    }
  }
  return s;
}

function wholeBuffer(s: ReadableStream<Uint8Array>, fn: (b: Uint8Array) => Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(c) { c.enqueue(fn(await collect(s))); c.close(); },
  });
}

function predictor(s: ReadableStream<Uint8Array>, f: FilterSpec): ReadableStream<Uint8Array> {
  const p = f.predictor ?? 1;
  if (p <= 1) return s;
  const colors = f.colors ?? 1, bpc = f.bpc ?? 8, cols = f.columns ?? 1;
  const bpp = Math.max(1, (colors * bpc) >> 3);
  const rowBytes = (cols * colors * bpc + 7) >> 3;
  if (p >= 10) return s.pipeThrough(pngPredictor(rowBytes, bpp));
  if (p === 2 && bpc === 8) return s.pipeThrough(tiffPredictor(rowBytes, colors));
  return s;
}

function pngPredictor(rowBytes: number, bpp: number): TransformStream<Uint8Array, Uint8Array> {
  let prev = new Uint8Array(rowBytes);
  let cur = new Uint8Array(rowBytes + 1);
  let fill = 0;
  return new TransformStream({
    transform(chunk, ctl) {
      const out = new Uint8Array(Math.ceil((chunk.length + fill) / (rowBytes + 1)) * rowBytes);
      let o = 0;
      for (let i = 0; i < chunk.length;) {
        const take = Math.min(rowBytes + 1 - fill, chunk.length - i);
        cur.set(chunk.subarray(i, i + take), fill);
        fill += take; i += take;
        if (fill === rowBytes + 1) {
          const t = cur[0];
          const row = out.subarray(o, o + rowBytes);
          for (let k = 0; k < rowBytes; k++) {
            const x = cur[k + 1];
            const a = k >= bpp ? row[k - bpp] : 0, b = prev[k], c = k >= bpp ? prev[k - bpp] : 0;
            let v: number;
            switch (t) {
              case 1: v = x + a; break;
              case 2: v = x + b; break;
              case 3: v = x + ((a + b) >> 1); break;
              case 4: {
                const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
                v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
              }
              default: v = x;
            }
            row[k] = v & 255;
          }
          prev = Uint8Array.from(row);
          o += rowBytes; fill = 0;
        }
      }
      if (o) ctl.enqueue(out.subarray(0, o));
    },
  });
}

function tiffPredictor(rowBytes: number, colors: number): TransformStream<Uint8Array, Uint8Array> {
  let col = 0;
  const last = new Uint8Array(colors);
  return new TransformStream({
    transform(chunk, ctl) {
      const out = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const k = col % rowBytes;
        const ch = k % colors;
        const v = k < colors ? chunk[i] : (chunk[i] + last[ch]) & 255;
        last[ch] = v; out[i] = v; col++;
      }
      ctl.enqueue(out);
    },
  });
}

function hexDecoder(): TransformStream<Uint8Array, Uint8Array> {
  let hi = -1, done = false;
  return new TransformStream({
    transform(chunk, ctl) {
      const out: number[] = [];
      for (const c of chunk) {
        if (done) break;
        if (c === 62) { if (hi >= 0) out.push(hi << 4); hi = -1; done = true; break; }
        const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
        if (v < 0) continue;
        if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
      }
      if (out.length) ctl.enqueue(Uint8Array.from(out));
    },
    flush(ctl) { if (hi >= 0 && !done) ctl.enqueue(Uint8Array.of(hi << 4)); },
  });
}

function ascii85Decoder(): TransformStream<Uint8Array, Uint8Array> {
  const grp: number[] = [];
  let done = false;
  const flushGroup = (out: number[], n: number) => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (i < n ? grp[i] : 84);
    const bytes = [(v / 16777216) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let i = 0; i < n - 1; i++) out.push(bytes[i]);
  };
  return new TransformStream({
    transform(chunk, ctl) {
      const out: number[] = [];
      for (const c of chunk) {
        if (done) break;
        if (c === 126) { done = true; break; } // ~>
        if (c <= 32) continue;
        if (c === 122 && grp.length === 0) { out.push(0, 0, 0, 0); continue; }
        if (c < 33 || c > 117) continue;
        grp.push(c - 33);
        if (grp.length === 5) { flushGroup(out, 5); grp.length = 0; }
      }
      if (out.length) ctl.enqueue(Uint8Array.from(out));
    },
    flush(ctl) {
      if (grp.length > 1) { const out: number[] = []; flushGroup(out, grp.length); ctl.enqueue(Uint8Array.from(out)); }
    },
  });
}

function runLengthDecode(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length;) {
    const l = b[i++];
    if (l === 128) break;
    if (l < 128) { for (let k = 0; k <= l && i < b.length; k++) out.push(b[i++]); }
    else { const v = b[i++]; for (let k = 0; k < 257 - l; k++) out.push(v); }
  }
  return Uint8Array.from(out);
}

function lzwDecode(b: Uint8Array, early: number): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => { table = []; for (let i = 0; i < 256; i++) table.push([i]); table.push([], []); };
  reset();
  let bits = 9, buf = 0, nb = 0, prev: number[] | null = null;
  for (let i = 0; i < b.length;) {
    while (nb < bits && i < b.length) { buf = (buf << 8) | b[i++]; nb += 8; }
    if (nb < bits) break;
    const code = (buf >> (nb - bits)) & ((1 << bits) - 1);
    nb -= bits; buf &= (1 << nb) - 1;
    if (code === 256) { reset(); bits = 9; prev = null; continue; }
    if (code === 257) break;
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const v of entry) out.push(v);
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    const sz = table.length + early;
    bits = sz >= 4096 ? 12 : sz >= 2048 ? 12 : sz >= 1024 ? 11 : sz >= 512 ? 10 : 9;
  }
  return Uint8Array.from(out);
}
