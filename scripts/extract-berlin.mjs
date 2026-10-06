// Schneidet Berlin (Zoom 0–15) aus dem aktuellen Protomaps-Planetenbuild nach public/berlin.pmtiles.
// Benötigt das pmtiles-CLI (https://github.com/protomaps/go-pmtiles/releases), im PATH als `pmtiles`
// oder über die Umgebungsvariable PMTILES_BIN. Anderer Ausschnitt: BBOX="minLon,minLat,maxLon,maxLat" OUT=public/x.pmtiles
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const bbox = process.env.BBOX || '13.08,52.33,13.77,52.68';
const out = process.env.OUT || 'public/berlin.pmtiles';
const maxzoom = process.env.MAXZOOM || '15';
const bin = process.env.PMTILES_BIN || 'pmtiles';

const builds = await (await fetch('https://build-metadata.protomaps.dev/builds.json')).json();
const latest = builds[builds.length - 1].key;
const src = process.env.SRC || `https://build.protomaps.com/${latest}`;
console.log(`Quelle: ${src}\nBBox:   ${bbox}\nZiel:   ${out}`);

fs.mkdirSync(out.replace(/[\\/][^\\/]+$/, '') || '.', { recursive: true });
const r = spawnSync(bin, ['extract', src, out, `--bbox=${bbox}`, `--maxzoom=${maxzoom}`], { stdio: 'inherit' });
if (r.error) {
  console.error(`\npmtiles-CLI nicht gefunden (${bin}). Installation: https://docs.protomaps.com/pmtiles/cli`);
  process.exit(1);
}
process.exit(r.status ?? 1);
