import type { Stroke } from './core/types';
import { optionalStore, type KvStore } from './idb';

/** Gespeicherte Zeichnung (ohne Undo-Verlauf). Float64Array-Teile gehen per Structured Clone direkt in IndexedDB. */
export interface SavedDrawing { strokes: Stroke[]; nextStrokeId: number; t: number }

const KEY = 'current';

/**
 * Zeichnung über Neuladen hinweg behalten: Speichern entprellt nach jeder Änderung, Laden einmal beim Start.
 * Ohne IndexedDB (privates Fenster, Node) passiert nichts.
 */
export function drawingStore(store: KvStore<SavedDrawing> | undefined = optionalStore<SavedDrawing>('drawing'), delayMs = 500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: SavedDrawing | null = null;
  const flush = () => {
    clearTimeout(timer);
    if (pending && store) void store.set(KEY, pending);
    pending = null;
  };
  return {
    load: async (): Promise<SavedDrawing | undefined> => {
      const d = await store?.get(KEY);
      return d && Array.isArray(d.strokes) ? d : undefined;
    },
    save(strokes: Stroke[], nextStrokeId: number) {
      pending = { strokes, nextStrokeId, t: Date.now() };
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}
