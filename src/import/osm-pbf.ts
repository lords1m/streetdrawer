import { PbfReader } from 'pbf';
import { classifyHighway, type BBox, type LineSink, type Progress } from './sink';

/** Erste Bytes einer OSM-PBF-Datei: BlobHeader mit type "OSMHeader". */
export async function looksLikeOsmPbf(file: Blob): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  return new TextDecoder('latin1').decode(b).includes('OSMHeader');
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

interface Block { strings: string[]; gran: number; latOff: number; lonOff: number }

function readStringTable(pbf: PbfReader, end: number): string[] {
  const out: string[] = [];
  pbf.readFields((tag, _r, p) => { if (tag === 1) out.push(new TextDecoder().decode(p.readBytes())); }, null, end);
  return out;
}

/**
 * OSM-PBF streamend: Blob für Blob per File.slice. Setzt sortierte Datei (Knoten vor Wegen) voraus,
 * wie von Geofabrik/planet.osm geliefert. Nur Knoten im Ausschnitt werden gemerkt.
 */
export async function importOsmPbf(file: Blob, sink: LineSink, progress: Progress, bbox?: BBox) {
  const nodes = new Map<number, number>(); // id -> Index in coords
  const coords: number[] = [];
  let pos = 0;
  let ways = 0;
  const td = new TextDecoder();
  while (pos < file.size) {
    const lenBuf = new DataView(await file.slice(pos, pos + 4).arrayBuffer());
    const hlen = lenBuf.getUint32(0, false);
    const hdr = new Uint8Array(await file.slice(pos + 4, pos + 4 + hlen).arrayBuffer());
    let type = '', dsize = 0;
    new PbfReader(hdr).readFields((tag, _r, p) => {
      if (tag === 1) type = p.readString();
      else if (tag === 3) dsize = p.readVarint();
    }, null);
    const bodyStart = pos + 4 + hlen;
    pos = bodyStart + dsize;
    if (type !== 'OSMData') continue;
    const blobBytes = new Uint8Array(await file.slice(bodyStart, pos).arrayBuffer());
    let raw: Uint8Array | null = null, zlib: Uint8Array | null = null;
    new PbfReader(blobBytes).readFields((tag, _r, p) => {
      if (tag === 1) raw = p.readBytes();
      else if (tag === 3) zlib = p.readBytes();
    }, null);
    const data = raw ?? (zlib ? await inflate(zlib) : null);
    if (!data) continue;
    ways += decodeBlock(data, nodes, coords, sink, bbox);
    progress(Math.min(1, pos / file.size), `OSM-PBF: ${ways.toLocaleString('de')} Straßen`);
  }
  void td;
}

function decodeBlock(data: Uint8Array, nodes: Map<number, number>, coords: number[], sink: LineSink, bbox?: BBox): number {
  const blk: Block = { strings: [], gran: 100, latOff: 0, lonOff: 0 };
  const groups: [number, number][] = [];
  const pb = new PbfReader(data);
  pb.readFields((tag, _r, p) => {
    if (tag === 1) { const end = p.readVarint() + p.pos; blk.strings = readStringTable(p, end); p.pos = end; }
    else if (tag === 2) { const end = p.readVarint() + p.pos; groups.push([p.pos, end]); p.pos = end; }
    else if (tag === 17) blk.gran = p.readVarint();
    else if (tag === 19) blk.latOff = p.readVarint(true);
    else if (tag === 20) blk.lonOff = p.readVarint(true);
    else p.skip(p.type);
  }, null);
  let ways = 0;
  const toLat = (v: number) => 1e-9 * (blk.latOff + blk.gran * v);
  const toLon = (v: number) => 1e-9 * (blk.lonOff + blk.gran * v);
  const keep = (lon: number, lat: number) => !bbox || (lon >= bbox.minLng && lon <= bbox.maxLng && lat >= bbox.minLat && lat <= bbox.maxLat);
  const addNode = (id: number, lon: number, lat: number) => {
    if (!keep(lon, lat)) return;
    nodes.set(id, coords.length / 2);
    coords.push(lon, lat);
  };

  for (const [start, end] of groups) {
    const g = new PbfReader(data);
    g.pos = start;
    g.readFields((tag, _r, p) => {
      if (tag === 2) { // DenseNodes
        const e = p.readVarint() + p.pos;
        let ids: number[] = [], lats: number[] = [], lons: number[] = [];
        p.readFields((t, _x, q) => {
          if (t === 1) ids = q.readPackedSVarint();
          else if (t === 8) lats = q.readPackedSVarint();
          else if (t === 9) lons = q.readPackedSVarint();
          else q.skip(q.type);
        }, null, e);
        let id = 0, la = 0, lo = 0;
        for (let i = 0; i < ids.length; i++) { id += ids[i]; la += lats[i]; lo += lons[i]; addNode(id, toLon(lo), toLat(la)); }
      } else if (tag === 1) { // Node
        const e = p.readVarint() + p.pos;
        let id = 0, la = 0, lo = 0;
        p.readFields((t, _x, q) => {
          if (t === 1) id = q.readSVarint(); else if (t === 8) la = q.readSVarint(); else if (t === 9) lo = q.readSVarint(); else q.skip(q.type);
        }, null, e);
        addNode(id, toLon(lo), toLat(la));
      } else if (tag === 3) { // Way
        const e = p.readVarint() + p.pos;
        let keys: number[] = [], vals: number[] = [], refs: number[] = [];
        p.readFields((t, _x, q) => {
          if (t === 2) keys = q.readPackedVarint();
          else if (t === 3) vals = q.readPackedVarint();
          else if (t === 8) refs = q.readPackedSVarint();
          else q.skip(q.type);
        }, null, e);
        let hw: string | undefined;
        for (let i = 0; i < keys.length; i++) if (blk.strings[keys[i]] === 'highway') { hw = blk.strings[vals[i]]; break; }
        if (hw === undefined) return;
        const cls = classifyHighway(hw);
        if (cls === null) return;
        const line: number[][] = [];
        let id = 0;
        for (const d of refs) {
          id += d;
          const idx = nodes.get(id);
          if (idx !== undefined) line.push([coords[2 * idx], coords[2 * idx + 1]]);
        }
        if (line.length >= 2) { sink.addLine(line, cls); ways++; }
      } else p.skip(p.type);
    }, null, end);
  }
  return ways;
}
