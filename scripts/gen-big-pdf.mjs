// Erzeugt ein synthetisches Karten-PDF mit vielen Vektoroperatoren (Standard: 20 Mio.), Flate-komprimiert, streamend geschrieben.
// Aufruf: node scripts/gen-big-pdf.mjs [Operatoren] [Ausgabe]
import fs from 'node:fs';
import zlib from 'node:zlib';

const totalOps = Number(process.argv[2] || 20_000_000);
const out = process.argv[3] || '.tmp/big.pdf';
fs.mkdirSync(out.replace(/[\\/][^\\/]+$/, '') || '.', { recursive: true });

const tmp = out + '.content';
const deflate = zlib.createDeflate({ level: 6 });
const ws = fs.createWriteStream(tmp);
deflate.pipe(ws);

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

let x = 300, y = 400, ops = 0;
const BATCH = 20000;
const pathsTotal = Math.floor(totalOps / 4); // je Pfad: m l l S
let done = 0;
const t0 = Date.now();
while (done < pathsTotal) {
  let s = '';
  for (let i = 0; i < BATCH && done < pathsTotal; i++, done++) {
    if (done % 2000 === 0) {
      const c = (done / 2000) % 7;
      s += `${(c * 0.13).toFixed(2)} ${(0.2 + c * 0.1).toFixed(2)} 0.4 RG ${(0.25 + (c % 3) * 0.25).toFixed(2)} w\n`;
      ops += 2;
    }
    const dx = (rnd() - 0.5) * 6, dy = (rnd() - 0.5) * 6;
    // zufälliger Gang, bleibt im Blatt
    x = Math.min(580, Math.max(20, x + dx * 4)); y = Math.min(770, Math.max(20, y + dy * 4));
    s += `${x.toFixed(2)} ${y.toFixed(2)} m ${(x + dx).toFixed(2)} ${(y + dy).toFixed(2)} l ${(x + dx * 2).toFixed(2)} ${(y + dy * 1.5).toFixed(2)} l S\n`;
    ops += 4;
  }
  if (!deflate.write(s)) await new Promise((r) => deflate.once('drain', r));
}
deflate.end();
await new Promise((r) => ws.on('finish', r));
const contentLen = fs.statSync(tmp).size;

const enc = (s) => Buffer.from(s, 'latin1');
const fd = fs.openSync(out, 'w');
let pos = 0;
const w = (b) => { fs.writeSync(fd, b); pos += b.length; };
const offs = {};
w(enc('%PDF-1.5\n'));
offs[1] = pos; w(enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
offs[2] = pos; w(enc('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));
offs[3] = pos; w(enc('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n'));
offs[4] = pos; w(enc(`4 0 obj\n<< /Length ${contentLen} /Filter /FlateDecode >>\nstream\n`));
const rd = fs.openSync(tmp, 'r');
const buf = Buffer.alloc(1 << 22);
for (let r; (r = fs.readSync(rd, buf, 0, buf.length, null)) > 0;) w(buf.subarray(0, r));
fs.closeSync(rd); fs.unlinkSync(tmp);
w(enc('\nendstream\nendobj\n'));
const xref = pos;
let x2 = 'xref\n0 5\n0000000000 65535 f \n';
for (let n = 1; n <= 4; n++) x2 += `${String(offs[n]).padStart(10, '0')} 00000 n \n`;
x2 += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
w(enc(x2));
fs.closeSync(fd);
console.log(`${out}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${ops.toLocaleString('de')} Operatoren, erzeugt in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
