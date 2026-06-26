#!/usr/bin/env bash
set -euo pipefail

APP="release/mac-arm64/Workbench Vision.app"
IDENTITY="Workbench Vision Dev (Self-Signed)"

if [[ ! -d "$APP" ]]; then
  echo "App bundle not found: $APP" >&2
  exit 1
fi

if security find-identity -v -p codesigning | grep -Fq "$IDENTITY"; then
  SIGN_ID="$IDENTITY"
elif security find-identity -v -p codesigning | grep -Fq "50370F878738983468F8C079A83F8DF22A9BBF25"; then
  SIGN_ID="50370F878738983468F8C079A83F8DF22A9BBF25"
else
  SIGN_ID=""
fi

if [[ -n "$SIGN_ID" ]]; then
  echo "Signing $APP with $SIGN_ID"
  codesign --force --deep --sign "$SIGN_ID" --options runtime "$APP"
  codesign --verify --deep --strict "$APP"
  codesign -dv "$APP" 2>&1 | head -8
else
  echo "Warning: no signing identity found; leaving adhoc signature" >&2
fi
