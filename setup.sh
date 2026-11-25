#!/bin/sh
# PRISM setup: installs deps; for Luau verification put luau in tools/luau or set PRISM_LUAU
npm install && echo "ok. run: npx tsx scratch/auto.ts file.lua out"
