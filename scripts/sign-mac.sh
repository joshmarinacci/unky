#!/bin/bash
set -euo pipefail

signing_identity="Developer ID Application: Joshua Marinacci (EYDSR3DT3F)"
team_id="EYDSR3DT3F"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This command must run on macOS." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -Fq "$signing_identity"; then
  echo "Signing identity not found in the keychain: $signing_identity" >&2
  exit 1
fi

read -r -p "Apple Account email: " apple_id
read -r -s -p "Apple app-specific password: " apple_password
printf '\n'

if [[ -z "$apple_id" || -z "$apple_password" ]]; then
  echo "Apple Account email and app-specific password are required." >&2
  exit 1
fi

export APPLE_ID="$apple_id"
export APPLE_PASSWORD="$apple_password"
export APPLE_TEAM_ID="$team_id"
export APPLE_SIGNING_IDENTITY="$signing_identity"
unset apple_password

cd "$(dirname "$0")/.."
npm run build:metadata
source src-tauri/build-metadata.env
export BUILD_NUMBER BUILD_TIMESTAMP BUILD_COMMIT

npm run tauri -- build --bundles dmg

dmg_dir="target/release/bundle/dmg"
dmg_path=$(find "$dmg_dir" -maxdepth 1 -type f -name '*.dmg' -print -quit)
if [[ -z "$dmg_path" ]]; then
  echo "Tauri completed without producing a DMG in $dmg_dir." >&2
  exit 1
fi

dmg_name="Unky_${BUILD_VERSION}_build-${BUILD_NUMBER}_${BUILD_TIMESTAMP//:/_}_${BUILD_COMMIT}_aarch64.dmg"
mv "$dmg_path" "$dmg_dir/$dmg_name"
echo "Created signed DMG: $dmg_dir/$dmg_name"
