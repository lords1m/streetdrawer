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

Live: Firebase Hosting (Projekt `strassenzeichner`), Deploy über `.github/workflows/firebase-hosting.yml`.

## Weltkarte (Cloud Storage)

Standardkarte ist die ganze Welt aus dem Protomaps-Build (ca. 120 GB, Zoom 0–15). Firebase Hosting erlaubt höchstens
2 GB pro Datei, deshalb liegt sie in einem öffentlichen Cloud-Storage-Bucket im selben GCP-Projekt. Ablauf beim Start:

1. eigene PMTiles-URL aus dem Panel (falls gesetzt, gemerkt im Browser)
2. Weltkarte – URL in `src/config.ts` (`WORLD_PMTILES_URL`, beim Bauen überschreibbar mit `VITE_WORLD_PMTILES_URL`)
3. `berlin.pmtiles` neben der App (schneller Start und Fallback)

Die erste Quelle, deren Header innerhalb von 5 s lesbar ist, wird genommen. Fällt sie später aus, wechselt die App auf
Berlin. Liegt die Kartenmitte außerhalb der aktiven Datei, erscheint „Hier gibt es in der gewählten Karte keine Daten.“

**Einrichtung (einmalig, von Hand):** `scripts/setup-world-tiles.sh` legt den Bucket an, gibt ihn öffentlich lesbar
frei, setzt CORS für Range-Requests, streamt die Datei aus dem Protomaps-Build hinein und prüft am Ende Status 206 und
CORS-Header. Danach die ausgegebene URL in `src/config.ts` eintragen. Voraussetzungen: Blaze-Tarif (Abrechnung aktiv),
`gcloud` angemeldet, keine Organisationsrichtlinie „Public Access Prevention“. Wegen der Dateigröße am besten auf einer
kleinen Compute-Engine-VM in derselben Region ausführen (Cloud Shell hat nur 5 GB Platte).
**Das Skript ist ungetestet** – es entstand ohne Zugriff auf das GCP-Projekt.

Nur ein Ausschnitt statt der ganzen Welt: `BBOX="-25,34,45,72" NAME=europe scripts/setup-world-tiles.sh` (benötigt das
pmtiles-CLI; Größe vorher mit `pmtiles extract … --dry-run` prüfen).

**Kosten** (Richtwerte, aktuelle Preise unter cloud.google.com/storage/pricing prüfen):

- Speicher: ca. 120 GB × ca. 0,02–0,03 USD pro GB und Monat ≈ 2,50–3,50 USD/Monat (Standard, eine Region).
- Abruf (Egress ins Internet): ca. 0,08–0,12 USD pro GB. Eine Sitzung lädt typisch einige MB Kacheln; bei vielen
  Nutzern dominiert dieser Posten.
- Anfragen: jede Kachel ist ein Lesezugriff (Klasse B, Bruchteile eines Cents je 1000).

**Missbrauchsrisiko:** Der Bucket ist öffentlich; jeder kann die ganze Datei direkt herunterladen (ein Komplettabruf
kostet grob 10–15 USD). CORS schützt davor nicht. In der GCP-Abrechnung deshalb einen **Budget-Alarm** einrichten.

## Bedienung

- **Ort suchen** im Feld oben: Adresse, Stadt, Land, PLZ oder Koordinaten (`52.52, 13.40`, Breite vor Länge; auch
  `52,52; 13,40`). Gesucht wird bei Enter oder Klick (kein Autocomplete – Nominatim erlaubt höchstens eine Anfrage pro
  Sekunde). Bei mehreren Treffern mit ↑/↓ wählen, Enter übernimmt, Escape schließt. Koordinaten springen ohne
  Netzabfrage. Panel-Abschnitt „Ort“: **Mein Standort**, **Zur Zeichnung springen** (alle Striche ins Bild) und die
  letzten 5 Suchen.
- **Striche bleiben beim Ortswechsel erhalten.** Man kann an einem Ort anfangen und woanders weiterzeichnen; das
  Einrasten funktioniert überall, wo die Karte Straßen hat.
- Die Ansicht steht im URL-Hash (`#zoom/lat/lng`) und lässt sich so teilen. Letzte Position, letzte Suchen und eigene
  PMTiles-URL merkt sich der Browser (localStorage); die Zeichnung übersteht ein Neuladen (IndexedDB, ohne Undo-Verlauf).
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
- **Export** (PNG/SVG) nimmt die Striche im sichtbaren Kartenausschnitt; Teile außerhalb werden abgeschnitten. Liegen
  Striche an mehreren Orten, wählt man so selbst, was ins Bild kommt.
- **Overpass** (optional, ab Zoom 17): wenige Abfragen nacheinander, Cache (Speicher + IndexedDB), Wartezeit bei 429.
  Ein User-Agent lässt sich im Browser nicht setzen; es wird der Referer gesendet.

## Datenschutz

- Der **Suchtext** geht an Nominatim, den Suchdienst der OpenStreetMap Foundation (Server in der EU), zusammen mit dem
  Kartenausschnitt (zur Gewichtung der Treffer) und dem Referer der Seite. Ergebnisse werden im Browser gecacht.
- Der **Standort** („Mein Standort“) bleibt im Browser und wird nicht übertragen.
- Kacheln kommen aus Cloud Storage bzw. Firebase Hosting, Schriften (abschaltbar) von `protomaps.github.io`.

## Architektur

`src/geocode.ts` Nominatim-Client (Cache in Speicher + IndexedDB, Mindestabstand, Backoff), `src/search-ui.ts` Suchfeld
und Trefferliste, `src/tile-source.ts` Wahl der Kartenquelle und Header-Grenzen, `src/idb.ts` gemeinsame IndexedDB
(eine Version für alle Stores), `src/persist.ts` Zeichnung speichern, `src/prefs.ts` localStorage.
`src/core` Geometrie, Raster-Index, Netzaufbau/Planarisierung, Dijkstra, Matching (inkrementell, Vorschau < 30 ms).
`src/workers` Netz-, Import- und PDF-Worker. `src/pdf` eigener Streaming-PDF-Parser (xref-Tabellen/-Streams,
Objekt-Streams, Flate/ASCII85/Hex/LZW/RunLength, Prädiktoren). `src/import` Formatleser.
deck.gl wird nur für das Netz-Overlay genutzt; Striche und Vorschau laufen über MapLibre.

## Leistung (Node, synthetisch)

`node scripts/gen-big-pdf.mjs 20000000 .tmp/big.pdf` und `BENCH=.tmp/big.pdf npx vitest run tests/pdf-bench.test.ts`:
85 MB PDF, 20 Mio. Operatoren: Durchgang 1 ca. 1,3 s, Durchgang 2 ca. 1,2 s, Speicherspitze ca. 340 MB.
