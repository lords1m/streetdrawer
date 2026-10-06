import { geojson } from 'flatgeobuf';
import { addFeature, type BBox, type LineSink, type Progress } from './sink';

/** FlatGeobuf streamend über File.stream(); optional räumlicher Filter über den Paketindex. */
export async function importFlatGeobuf(file: Blob, sink: LineSink, progress: Progress, bbox?: BBox) {
  const rect = bbox ? { minX: bbox.minLng, minY: bbox.minLat, maxX: bbox.maxLng, maxY: bbox.maxLat } : undefined;
  let n = 0;
  for await (const f of geojson.deserialize(file.stream(), rect ? { rect } : undefined)) {
    addFeature(sink, f as never);
    if (++n % 5000 === 0) progress(0, `FlatGeobuf: ${n.toLocaleString('de')} Objekte`);
  }
  progress(1, `FlatGeobuf: ${n.toLocaleString('de')} Objekte`);
}
