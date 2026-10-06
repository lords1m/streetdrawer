/**
 * Streamender JSON-Scanner: ruft für jedes Element des Arrays unter dem Schlüssel `key` (auf oberster Ebene)
 * den Callback mit dem Element-JSON-Text auf, ohne das Dokument im Speicher zu halten.
 * Gibt true zurück, wenn der Schlüssel gefunden wurde.
 */
export async function scanTopLevelArray(
  blob: Blob,
  key: string,
  onElement: (json: string) => void,
  onProgress?: (fraction: number) => void,
): Promise<boolean> {
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  let depth = 0;
  let inStr = false, esc = false;
  let strBuf = '';           // Inhalt des gerade gelesenen Strings, nur auf Ebene 1
  let strDepth1 = false;
  let armed = false;         // Schlüssel gelesen, warte auf ':' und '['
  let colonSeen = false;
  let arrDepth = -1;         // Tiefe innerhalb des Ziel-Arrays (= depth nach '[')
  let found = false;
  let capturing = false;
  let pieces: string[] = [];
  let read = 0;
  const total = blob.size || 1;

  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    read += chunk.length;
    let capStart = capturing ? 0 : -1;
    const n = chunk.length;
    for (let i = 0; i < n; i++) {
      const c = chunk.charCodeAt(i);
      if (inStr) {
        if (esc) { esc = false; if (strDepth1) strBuf += chunk[i]; continue; }
        if (c === 92) { esc = true; if (strDepth1) strBuf += '\\'; continue; }
        if (c === 34) {
          inStr = false;
          if (strDepth1 && depth === 1 && !found && strBuf === key) { armed = true; colonSeen = false; }
          strDepth1 = false;
          continue;
        }
        if (strDepth1) strBuf += chunk[i];
        continue;
      }
      if (c === 34) { inStr = true; strDepth1 = depth === 1 && arrDepth < 0; strBuf = ''; if (armed && colonSeen) armed = false; continue; }
      if (c === 123 || c === 91) { // { [
        if (armed && c === 91 && colonSeen && depth === 1) { armed = false; found = true; depth++; arrDepth = depth; continue; }
        if (arrDepth > 0 && depth === arrDepth && !capturing && c === 123) { capturing = true; capStart = i; pieces = []; }
        depth++;
        continue;
      }
      if (c === 125 || c === 93) { // } ]
        depth--;
        if (capturing && depth === arrDepth) {
          pieces.push(chunk.slice(capStart, i + 1));
          capturing = false; capStart = -1;
          onElement(pieces.join(''));
          pieces = [];
        } else if (c === 93 && arrDepth > 0 && depth === arrDepth - 1) {
          arrDepth = -1; // Array zu Ende
        }
        continue;
      }
      if (armed) {
        if (c === 58) colonSeen = true;
        else if (c > 32) armed = false;
      }
    }
    if (capturing && capStart >= 0) pieces.push(chunk.slice(capStart));
    onProgress?.(Math.min(1, read / total));
  }
  return found;
}
