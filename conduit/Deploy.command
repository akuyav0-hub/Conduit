#!/bin/bash
# Double-click on a Mac to deploy Conduit.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Conduit needs Node.js to deploy. Opening the download page…"
  open "https://nodejs.org/en/download"
  read -r -p "Install the LTS version, then run Deploy again. Press Enter to close."
  exit 1
fi
node scripts/deploy.mjs
read -r -p "Press Enter to close."
