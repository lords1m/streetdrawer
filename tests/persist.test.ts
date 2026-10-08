import { describe, expect, it } from 'vitest';
import { drawingStore, type SavedDrawing } from '../src/persist';

describe('Zeichnung speichern', () => {
  it('entprellt: nur der letzte Stand wird geschrieben, flush schreibt sofort', async () => {
    const writes: SavedDrawing[] = [];
    const store = { get: async () => writes[writes.length - 1], set: async (_k: string, v: SavedDrawing) => { writes.push(v); } };
    const d = drawingStore(store, 20);
    const s = (id: number) => ({ id, color: '#000', width: 4, parts: [Float64Array.from([13.4, 52.5, 13.41, 52.51])] });
    d.save([s(1)], 1);
    d.save([s(1), s(2)], 2);
    expect(writes).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(writes).toHaveLength(1);
    expect(writes[0].strokes).toHaveLength(2);
    d.save([], 2);
    d.flush();
    expect(writes).toHaveLength(2);
    expect((await d.load())?.strokes).toEqual([]);
  });

  it('ohne Speicher passiert nichts', async () => {
    const d = drawingStore(undefined, 1);
    d.save([], 0);
    d.flush();
    expect(await d.load()).toBeUndefined();
  });
});
