#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT_DIR/manifest.json" | head -n 1)"

if [[ -z "$VERSION" ]]; then
  echo "Could not determine the extension version from manifest.json." >&2
  exit 1
fi

PACKAGE_NAME="pitch-deck-vector-export-edge-v${VERSION}.zip"
PACKAGE_PATH="$DIST_DIR/$PACKAGE_NAME"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cd "$ROOT_DIR"
zip -X -r "$PACKAGE_PATH" \
  manifest.json \
  src \
  assets/icons/icon-16.png \
  assets/icons/icon-32.png \
  assets/icons/icon-48.png \
  assets/icons/icon-128.png \
  assets/icons/icon-512.png \
  LICENSE \
  README.md

echo "$PACKAGE_PATH"
