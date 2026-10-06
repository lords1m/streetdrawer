import type { BuildOptions } from './graph';

export type Slot = 'tiles' | 'import';

/** Linien als flache Puffer. coords: lng/lat (Grad) oder Meter relativ zu `origin`. */
export interface LineBatch {
  coords: Float64Array;
  offsets: Uint32Array;
  cls: Uint8Array;
  /** Ebene je Linie (Brücke 1, Boden 0, Tunnel -1). */
  level?: Int8Array;
  kind: 'lnglat' | 'meters';
  /** Bei kind==='meters': Georeferenz (Ursprung der Meter-Koordinaten). */
  origin?: [number, number];
}

export type WorkerIn =
  | { op: 'setNetwork'; rid: number; slot: Slot; lines: LineBatch; build: BuildOptions }
  | { op: 'clear'; rid: number; slot: Slot }
  | { op: 'overlay'; rid: number; slot: Slot }
  | {
      op: 'feed'; rid: number; slot: Slot; sid: number;
      points: Float64Array; // lng,lat – nur neue Punkte
      radiusM: number; classMask: number; final: boolean;
    }
  | { op: 'drop'; rid: number; sid: number };

export interface NetStats { nodes: number; edges: number; ms: number }

export type WorkerOut =
  | { op: 'ready'; rid: number; slot: Slot; stats: NetStats }
  | { op: 'cleared'; rid: number }
  | { op: 'overlay'; rid: number; src: Float64Array; dst: Float64Array; cls: Uint8Array }
  | { op: 'result'; rid: number; sid: number; parts: Float64Array[]; ms: number; final: boolean }
  | { op: 'error'; rid: number; message: string };

export interface Stroke {
  id: number;
  color: string;
  width: number;      // Pixel (Bildschirm)
  parts: Float64Array[]; // lng,lat flach
}
