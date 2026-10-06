import { deflateSync } from 'node:zlib';

export type PdfMode = 'classic' | 'xrefstream' | 'objstm';

export interface BuildOpts {
  mode: PdfMode;
  /** Inhaltsströme je Seite (Text des Content-Streams). */
  pages: string[];
  flate?: boolean;
  /** Formulare (XObjects) mit Namen, auf allen Seiten verfügbar. */
  forms?: { name: string; content: string; matrix?: number[] }[];
  /** Optionale Inhalte (OC-Ebenen): Name → Anzeigename. */
  layers?: Record<string, string>;
  mediaBox?: [number, number, number, number];
  /** Zusätzliches Trailer-Fragment, z. B. "/Encrypt 99 0 R". */
  trailerExtra?: string;
  /** Seitenbaum verschachteln (Pages → Pages → Page). */
  nested?: boolean;
  /** Content-Stream mit /Length als indirekte Referenz. */
  indirectLength?: boolean;
}

const enc = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
const cat = (...a: Uint8Array[]): Uint8Array<ArrayBuffer> => { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

interface Obj { num: number; dict?: string; body?: string; data?: Uint8Array }

function pngUp(rows: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  let prev: Uint8Array = new Uint8Array(rows[0].length);
  for (const r of rows) { out.push(2); for (let i = 0; i < r.length; i++) out.push((r[i] - prev[i]) & 255); prev = r; }
  return Uint8Array.from(out);
}

export function buildPdf(o: BuildOpts): Uint8Array {
  const box = o.mediaBox ?? [0, 0, 612, 792];
  const objs: Obj[] = [];
  const flate = o.flate ?? true;
  let next = 1;
  const alloc = () => next++;

  const catalogNum = alloc(), pagesNum = alloc();
  const pageNums: number[] = [];
  const contentNums: number[] = [];
  const lenNums: number[] = [];
  o.pages.forEach(() => { pageNums.push(alloc()); contentNums.push(alloc()); if (o.indirectLength) lenNums.push(alloc()); });
  const formNums = (o.forms ?? []).map(() => alloc());
  const ocgNums = Object.keys(o.layers ?? {}).map(() => alloc());
  const midPages = o.nested ? alloc() : 0;

  const resources = (() => {
    let r = '<< ';
    if (o.forms?.length) r += '/XObject << ' + o.forms.map((f, i) => `/${f.name} ${formNums[i]} 0 R`).join(' ') + ' >> ';
    if (ocgNums.length) r += '/Properties << ' + Object.keys(o.layers!).map((k, i) => `/${k} ${ocgNums[i]} 0 R`).join(' ') + ' >> ';
    r += '/ExtGState << /GS1 << /LW 3 >> >> >>';
    return r;
  })();

  const stream = (text: string | Uint8Array, extra = '') => {
    const raw = typeof text === 'string' ? enc(text) : text;
    const data = flate ? new Uint8Array(deflateSync(raw)) : raw;
    return { dict: `/Length ${data.length}${flate ? ' /Filter /FlateDecode' : ''}${extra}`, data };
  };

  const pageDicts: Obj[] = [];
  o.pages.forEach((content, i) => {
    const s = stream(content);
    const parent = o.nested ? midPages : pagesNum;
    pageDicts.push({ num: pageNums[i], body: `<< /Type /Page /Parent ${parent} 0 R /MediaBox [${box.join(' ')}] /Resources ${resources} /Contents ${contentNums[i]} 0 R >>` });
    if (o.indirectLength) {
      objs.push({ num: contentNums[i], dict: s.dict.replace(/\/Length \d+/, `/Length ${lenNums[i]} 0 R`), data: s.data });
      objs.push({ num: lenNums[i], body: String(s.data.length) });
    } else objs.push({ num: contentNums[i], dict: s.dict, data: s.data });
  });
  (o.forms ?? []).forEach((f, i) => {
    const s = stream(f.content, ` /Type /XObject /Subtype /Form /BBox [0 0 1000 1000]${f.matrix ? ` /Matrix [${f.matrix.join(' ')}]` : ''}`);
    objs.push({ num: formNums[i], dict: s.dict, data: s.data });
  });
  Object.values(o.layers ?? {}).forEach((nm, i) => objs.push({ num: ocgNums[i], body: `<< /Type /OCG /Name (${nm}) >>` }));

  const structural: Obj[] = [{ num: catalogNum, body: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>` }];
  if (o.nested) {
    structural.push({ num: pagesNum, body: `<< /Type /Pages /Kids [${midPages} 0 R] /Count ${o.pages.length} >>` });
    structural.push({ num: midPages, body: `<< /Type /Pages /Parent ${pagesNum} 0 R /Kids [${pageNums.map((n) => n + ' 0 R').join(' ')}] /Count ${o.pages.length} >>` });
  } else {
    structural.push({ num: pagesNum, body: `<< /Type /Pages /Kids [${pageNums.map((n) => n + ' 0 R').join(' ')}] /Count ${o.pages.length} >>` });
  }
  structural.push(...pageDicts);

  const parts: Uint8Array[] = [enc('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n')];
  let pos = parts[0].length;
  const offsets = new Map<number, number>();
  const writeObj = (ob: Obj) => {
    offsets.set(ob.num, pos);
    const head = enc(`${ob.num} 0 obj\n`);
    const body = ob.data ? cat(enc(`<< ${ob.dict} >>\nstream\n`), ob.data, enc('\nendstream')) : enc(ob.body!);
    const chunk = cat(head, body, enc('\nendobj\n'));
    parts.push(chunk); pos += chunk.length;
  };

  let total = next; // höchste Nummer + 1 (wird ggf. um xref/objstm erweitert)
  const compressed = new Map<number, { stm: number; idx: number }>();

  if (o.mode === 'objstm') {
    const stmNum = total++;
    let hdr = '', body = '';
    structural.forEach((ob, i) => { hdr += `${ob.num} ${body.length} `; body += ob.body + '\n'; compressed.set(ob.num, { stm: stmNum, idx: i }); });
    const text = hdr + body;
    const s = stream(text, ` /Type /ObjStm /N ${structural.length} /First ${hdr.length}`);
    objs.push({ num: stmNum, dict: s.dict, data: s.data });
  } else {
    objs.push(...structural);
  }
  for (const ob of objs) writeObj(ob);

  const trailerBase = `/Root ${catalogNum} 0 R ${o.trailerExtra ?? ''}`;
  if (o.mode === 'classic') {
    const xrefPos = pos;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let n = 1; n < total; n++) x += `${String(offsets.get(n) ?? 0).padStart(10, '0')} 00000 n \n`;
    x += `trailer\n<< /Size ${total} ${trailerBase} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    parts.push(enc(x));
  } else {
    const xrefNum = total++;
    const xrefPos = pos;
    offsets.set(xrefNum, xrefPos);
    const rows: Uint8Array[] = [];
    for (let n = 0; n < total; n++) {
      const r = new Uint8Array(7);
      if (n === 0) { r[0] = 0; r[5] = 255; r[6] = 255; }
      else if (compressed.has(n)) { const c = compressed.get(n)!; r[0] = 2; new DataView(r.buffer).setUint32(1, c.stm); r[5] = (c.idx >> 8) & 255; r[6] = c.idx & 255; }
      else { r[0] = 1; new DataView(r.buffer).setUint32(1, offsets.get(n) ?? 0); }
      rows.push(r);
    }
    const data = new Uint8Array(deflateSync(pngUp(rows)));
    const head = `${xrefNum} 0 obj\n<< /Type /XRef /Size ${total} /W [1 4 2] ${trailerBase} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${data.length} >>\nstream\n`;
    parts.push(cat(enc(head), data, enc(`\nendstream\nendobj\nstartxref\n${xrefPos}\n%%EOF\n`)));
  }
  return cat(...parts);
}
