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

npm run tauri -- build --bundles dmg
