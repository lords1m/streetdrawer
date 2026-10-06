import type { Stroke } from './core/types';

interface Projector {
  project(ll: [number, number]): { x: number; y: number };
  unproject(p: [number, number]): { lng: number; lat: number };
}

/**
 * Radierer im Bildschirmraum: entfernt alle Linienteile innerhalb `radius` Pixel um die Punkte
 * `at` und teilt Linien an den Lücken. Unveränderte Striche bleiben dieselben Objekte.
 */
export function eraseStrokes(list: Stroke[], map: Projector, at: [number, number][], radius: number): Stroke[] {
  const r2 = radius * radius;
  let changed = false;
  const out: Stroke[] = [];
  for (const s of list) {
    let sChanged = false;
    const parts: Float64Array[] = [];
    for (const part of s.parts) {
      const n = part.length / 2;
      const px = new Float64Array(n), py = new Float64Array(n);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const p = map.project([part[2 * i], part[2 * i + 1]]);
        px[i] = p.x; py[i] = p.y;
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const near = at.some(([x, y]) => x >= minX - radius && x <= maxX + radius && y >= minY - radius && y <= maxY + radius);
      if (!near) { parts.push(part); continue; }
      // verdichten (px-Raum), damit auch Teilstücke langer Segmente fallen
      const step = Math.max(2, radius / 2);
      const dx: number[] = [], dy: number[] = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          const len = Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
          const k = Math.floor(len / step);
          for (let j = 1; j <= k; j++) {
            const f = j / (k + 1);
            dx.push(px[i - 1] + (px[i] - px[i - 1]) * f); dy.push(py[i - 1] + (py[i] - py[i - 1]) * f);
          }
        }
        dx.push(px[i]); dy.push(py[i]);
      }
      let cur: number[] = [];
      let removed = false;
      const flush = () => {
        if (cur.length >= 4) {
          const o = new Float64Array(cur.length);
          for (let i = 0; i < cur.length; i += 2) { const ll = map.unproject([cur[i], cur[i + 1]]); o[i] = ll.lng; o[i + 1] = ll.lat; }
          parts.push(o);
        }
        cur = [];
      };
      for (let i = 0; i < dx.length; i++) {
        let hit = false;
        for (const [x, y] of at) { const ddx = dx[i] - x, ddy = dy[i] - y; if (ddx * ddx + ddy * ddy <= r2) { hit = true; break; } }
        if (hit) { removed = true; flush(); } else cur.push(dx[i], dy[i]);
      }
      if (!removed) { parts.push(part); continue; }
      flush();
      sChanged = true;
    }
    if (!sChanged) { out.push(s); continue; }
    changed = true;
    if (parts.length) out.push({ ...s, parts });
  }
  return changed ? out : list;
}
