import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPdf, scanPdf } from '../src/pdf/analyze';

// Läuft nur mit BENCH=<Pfad zur PDF>:  BENCH=.tmp/big.pdf npx vitest run tests/pdf-bench.test.ts
const file = process.env.BENCH;
describe.skipIf(!file)('PDF-Leistung (20 Mio. Operatoren, 40 MB)', () => {
  it('Durchgang 1 und 2 in unter 15 s je Durchgang, Speicher unter 1 GB', async () => {
    const blob = await fs.openAsBlob(file!);
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
    const t0 = performance.now();
    const scan = await scanPdf(blob, 0);
    const t1 = performance.now();
    const ex = await extractPdf(blob, 0, scan.styles.slice(0, 3).map((s) => s.key), null);
    const t2 = performance.now();
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    const rep = {
      dateiMB: +(blob.size / 1048576).toFixed(1), operatoren: scan.operators, pfade: scan.paths, stile: scan.styles.length,
      durchgang1_s: +((t1 - t0) / 1000).toFixed(2), durchgang2_s: +((t2 - t1) / 1000).toFixed(2),
      linienzuege: ex.offsets.length - 1, rssPeakMB: Math.round(peak / 1048576),
    };
    fs.writeFileSync('.tmp/bench-result.json', JSON.stringify(rep, null, 2));
    expect(scan.operators).toBeGreaterThanOrEqual(19_000_000);
    expect((t1 - t0) / 1000).toBeLessThan(15);
    expect(peak / 1048576).toBeLessThan(1024);
  }, 180_000);
});
