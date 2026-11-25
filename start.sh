#!/usr/bin/env sh
# PRISM one-shot launcher: install deps, fetch native Luau tools, build the UI, start the server.
#   ./start.sh [--port 7777] [--host 127.0.0.1] [--workspace DIR]
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
node tools/fetch-luau.mjs --optional || true
[ -f apps/web/dist/index.html ] || npm run build
exec node --import tsx apps/server/src/server.ts "$@"
