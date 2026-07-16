#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_NAME="pitch-deck-vector-export-edge.zip"
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
