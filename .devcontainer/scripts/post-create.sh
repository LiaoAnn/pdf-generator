#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends socat
sudo rm -rf /var/lib/apt/lists/*

# Named volumes can initially be owned by root.
sudo mkdir -p /home/node/.pnpm-store
sudo chown -R node:node /home/node/.pnpm-store
pnpm config set store-dir /home/node/.pnpm-store

# Playwright + headless Chromium for driving the app in a browser during
# verification. A dev-environment tool, not a repo dependency: never add it to
# package.json. Pinned and installed globally. Browsers go to
# PLAYWRIGHT_BROWSERS_PATH, the shared playwright_browsers volume, so re-creating
# the container skips the download; only the system libraries are reinstalled.
PLAYWRIGHT_VERSION=1.63.0
: "${PLAYWRIGHT_BROWSERS_PATH:=/home/node/.cache/ms-playwright}"
export PLAYWRIGHT_BROWSERS_PATH
if [ "$(playwright --version 2>/dev/null)" != "Version $PLAYWRIGHT_VERSION" ]; then
  npm install -g --no-fund --no-audit "playwright@$PLAYWRIGHT_VERSION"
fi
sudo mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
sudo chown node:node "$PLAYWRIGHT_BROWSERS_PATH"
sudo "$(command -v playwright)" install-deps chromium-headless-shell
# No-op when this version's headless shell is already on the volume.
playwright install --only-shell chromium
