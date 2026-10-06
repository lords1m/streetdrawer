# Straßenzeichner

Straßenverläufe einer Karte mit dem Stift nachzeichnen: der Strich rastet nur auf Straßen ein (HMM-Map-Matching).
Export als PNG und SVG. Reine statische Web-App, kein Backend.

## Start

```bash
npm install
npm run tiles:berlin   # schneidet Berlin (Zoom 0–15, ca. 82 MB) nach public/berlin.pmtiles
npm run dev            # http://localhost:5173
npm test               # Vitest
npm run e2e            # Playwright-Hauptpfade (einmalig: npx playwright install chromium)
npm run build          # statisches Bundle in dist/
```

## PMTiles erzeugen

Benötigt das [pmtiles-CLI](https://docs.protomaps.com/pmtiles/cli) (`pmtiles` im PATH oder `PMTILES_BIN=…`).

```bash
# anderer Ausschnitt
BBOX="9.7,53.4,10.3,53.7" OUT=public/hamburg.pmtiles npm run tiles:berlin
```

Die Datei muss im Protomaps-Schema vorliegen (Layer `roads`, Attribut `kind`). Im Panel kann unter „Karte“ auch eine
eigene `.pmtiles`-URL eingetragen werden (muss CORS und Range-Requests erlauben).

## Hosting

`dist/` auf einen beliebigen statischen Host legen, der **HTTP-Range-Requests** ausliefert (nginx, Caddy, GitHub Pages,
Netlify, S3/Cloudflare R2 …). Die `.pmtiles`-Datei daneben legen oder per URL einbinden. Beschriftungsschriften werden
standardmäßig von `protomaps.github.io` geladen; im Panel abschaltbar (dann komplett ohne externe Abhängigkeit).

## Bedienung

- **Stift** zeichnen, **Radierer**, **Bewegen** (oder Leertaste halten). Zwei Finger / Mausrad zoomen.
- Fangradius, Strichstärke, Farbe, Klassen (Hauptstraßen/Straßen/Pfade) im Panel. Strg+Z / Strg+Y.
- Das Netz stammt aus den aktuell sichtbaren Straßen der Vektorkacheln: weit weg nur Hauptstraßen, kleine Straßen
  erst beim Hineinzoomen.
- **Import** (Datei wählen oder auf die Seite ziehen): GeoJSON, Overpass-JSON, PMTiles, MVT-Kachel (`z-x-y.mvt`),
  OSM-PBF, FlatGeobuf, PDF. Große Dateien werden streamend gelesen; bei großen Dateien „nur aktueller
  Kartenausschnitt“ wählen.
- **PDF:** zwei Durchgänge. Erst Dichteübersicht und Ebenenstatistik (Farbe, Strichstärke, Anzahl, Ebenenname),
  dann nur die gewählten Ebenen im gewählten Ausschnitt. Maßstab 1:N wird aus dem Dateinamen geraten. Kreuzungen und
  T-Stöße werden planarisiert, schmale Lücken überbrückt. Ausdünnung nach Zoom ist für PDF-Netze aus.
  Nicht unterstützt: verschlüsselte PDFs, Seitenrotation, Clip-Pfade.
- **Overpass** (optional, ab Zoom 17): wenige Abfragen nacheinander, Cache (Speicher + IndexedDB), Wartezeit bei 429.
  Ein User-Agent lässt sich im Browser nicht setzen; es wird der Referer gesendet.

## Architektur

`src/core` Geometrie, Raster-Index, Netzaufbau/Planarisierung, Dijkstra, Matching (inkrementell, Vorschau < 30 ms).
`src/workers` Netz-, Import- und PDF-Worker. `src/pdf` eigener Streaming-PDF-Parser (xref-Tabellen/-Streams,
Objekt-Streams, Flate/ASCII85/Hex/LZW/RunLength, Prädiktoren). `src/import` Formatleser.
deck.gl wird nur für das Netz-Overlay genutzt; Striche und Vorschau laufen über MapLibre.

## Leistung (Node, synthetisch)

`node scripts/gen-big-pdf.mjs 20000000 .tmp/big.pdf` und `BENCH=.tmp/big.pdf npx vitest run tests/pdf-bench.test.ts`:
85 MB PDF, 20 Mio. Operatoren: Durchgang 1 ca. 1,3 s, Durchgang 2 ca. 1,2 s, Speicherspitze ca. 340 MB.
