#!/usr/bin/env bash
# Einmalige Einrichtung der Weltkarte im Cloud-Storage-Bucket (von Hand auszuführen).
#
# UNGETESTET: Die Sitzung, in der dieses Skript entstand, hatte keinen Zugriff auf das GCP-Projekt.
# Vor dem ersten Lauf jeden Schritt lesen; bei Fehlern lässt sich das Skript erneut starten (Schritte sind wiederholbar).
#
# Voraussetzungen
# - gcloud-CLI, angemeldet (gcloud auth login) mit Rechten auf das Projekt
# - Firebase-Projekt im Blaze-Tarif (Abrechnung aktiv), sonst lassen sich keine eigenen Buckets anlegen
# - Keine Organisationsrichtlinie „Public Access Prevention“, sonst scheitert die Freigabe für allUsers
# - Die Welt-Datei ist ca. 120 GB groß. Cloud Shell hat nur 5 GB Platte: das Skript streamt deshalb ohne lokale
#   Kopie (curl | gcloud storage cp -). Am besten auf einer kleinen Compute-Engine-VM in derselben Region laufen
#   lassen (Eingang nach GCP ist kostenlos, die Übertragung dauert dort Minuten statt Stunden).
# - Für einen Ausschnitt (BBOX gesetzt) zusätzlich das pmtiles-CLI und lokaler Platz für die Ausschnittsdatei.
#   Größe vorher prüfen: pmtiles extract <Quelle> x.pmtiles --bbox=… --dry-run
#
# Aufruf
#   scripts/setup-world-tiles.sh                       # ganze Welt, neuester Protomaps-Build
#   BBOX="-25,34,45,72" NAME=europe scripts/setup-world-tiles.sh   # nur Europa
#   BUILD=20261001 scripts/setup-world-tiles.sh        # bestimmter Build
#
# Danach die ausgegebene URL in src/config.ts (WORLD_PMTILES_URL) eintragen, committen und deployen.
set -euo pipefail

PROJECT="${PROJECT:-strassenzeichner}"
BUCKET="${BUCKET:-strassenzeichner-tiles}"
LOCATION="${LOCATION:-europe-west3}"
BUILD="${BUILD:-}"            # leer = neuester Build laut build-metadata.protomaps.dev
BBOX="${BBOX:-}"              # leer = ganze Welt; sonst minLon,minLat,maxLon,maxLat
NAME="${NAME:-planet}"        # Präfix des Objektnamens
ORIGIN_CHECK="${ORIGIN_CHECK:-https://strassenzeichner.web.app}"

step() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------- Quelle
if [[ -z "$BUILD" ]]; then
  step "Neuesten Protomaps-Build ermitteln"
  KEY=$(curl -fsSL https://build-metadata.protomaps.dev/builds.json | grep -o '"key" *: *"[^"]*"' | tail -1 | sed 's/.*"\([^"]*\)"$/\1/')
  BUILD="${KEY%.pmtiles}"
fi
SRC="https://build.protomaps.com/${BUILD}.pmtiles"
OBJECT="${NAME}-${BUILD}.pmtiles"
URL="https://storage.googleapis.com/${BUCKET}/${OBJECT}"
echo "Projekt: $PROJECT  Bucket: gs://$BUCKET ($LOCATION)"
echo "Quelle:  $SRC${BBOX:+  Ausschnitt: $BBOX}"
echo "Ziel:    gs://$BUCKET/$OBJECT"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- 1. Bucket
step "1. Bucket anlegen (Uniform Bucket-Level Access)"
if gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" >/dev/null 2>&1; then
  echo "Bucket existiert bereits."
else
  gcloud storage buckets create "gs://$BUCKET" --project="$PROJECT" --location="$LOCATION" \
    --default-storage-class=STANDARD --uniform-bucket-level-access
fi

# ---------------------------------------------------------------- 2. Öffentlich lesbar
step "2. Lesezugriff für alle (allUsers → roles/storage.objectViewer)"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project="$PROJECT" \
  --member=allUsers --role=roles/storage.objectViewer >/dev/null

# ---------------------------------------------------------------- 3. CORS
# PMTiles liest per Range-Request; der Browser braucht dafür CORS. responseHeader steuert sowohl die erlaubten
# Anfrage-Header als auch die für Skripte sichtbaren Antwort-Header (ETag und Content-Range liest der pmtiles-Client).
step "3. CORS setzen"
cat >"$TMP/cors.json" <<'JSON'
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Range", "Content-Range", "Content-Length", "Accept-Ranges", "ETag", "If-Match", "Cache-Control"],
    "maxAgeSeconds": 3600
  }
]
JSON
gcloud storage buckets update "gs://$BUCKET" --project="$PROJECT" --cors-file="$TMP/cors.json"

# ---------------------------------------------------------------- 4. Datei übertragen
step "4. Datei übertragen"
if gcloud storage objects describe "gs://$BUCKET/$OBJECT" --project="$PROJECT" >/dev/null 2>&1; then
  echo "Objekt existiert bereits – übersprungen (zum Neuladen vorher löschen)."
elif [[ -z "$BBOX" ]]; then
  # Streaming ohne lokale Kopie; bricht die Verbindung ab, Schritt erneut starten
  curl -fL --retry 5 "$SRC" | gcloud storage cp - "gs://$BUCKET/$OBJECT" --project="$PROJECT"
else
  pmtiles extract "$SRC" "$TMP/$OBJECT" --bbox="$BBOX"
  gcloud storage cp "$TMP/$OBJECT" "gs://$BUCKET/$OBJECT" --project="$PROJECT"
fi

# ---------------------------------------------------------------- 5. Cache-Header
step "5. Cache-Control setzen"
gcloud storage objects update "gs://$BUCKET/$OBJECT" --project="$PROJECT" --cache-control="public, max-age=86400"

# ---------------------------------------------------------------- 6. Prüfen
step "6. Range-Request und CORS prüfen (erwartet: 206, Content-Range, Access-Control-Allow-Origin)"
curl -sS -o /dev/null -D "$TMP/headers" -r 0-126 -H "Origin: $ORIGIN_CHECK" "$URL"
grep -iE '^(HTTP/|content-range|access-control-allow-origin|access-control-expose-headers|etag)' "$TMP/headers" || true
if ! grep -qE '^HTTP/[0-9.]+ 206' "$TMP/headers"; then echo "FEHLER: kein 206 – Range-Requests funktionieren nicht." >&2; exit 1; fi
if ! grep -qi '^access-control-allow-origin' "$TMP/headers"; then echo "FEHLER: CORS-Header fehlt." >&2; exit 1; fi

cat <<EOF

Fertig. In src/config.ts eintragen:

  export const WORLD_PMTILES_URL = … || '$URL';

Tipp: in der GCP-Abrechnung einen Budget-Alarm anlegen (der Bucket ist öffentlich, Egress ist nicht gedeckelt).
EOF
