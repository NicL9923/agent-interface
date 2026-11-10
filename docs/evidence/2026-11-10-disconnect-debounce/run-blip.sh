#!/usr/bin/env bash
# run-blip.sh <label>, from the repository root of a probe build: `python3 apply-probe.py`, copy probe.ts
# to src/probe.ts, then `PROBE=1 npm run build`. The preview must take SEED_TURNS, added to
# .agents/tools/streaming-preview.ts on branch t3/window-work-memo. Starts a fresh seeded preview,
# fails one conversation read, lets the next succeed, and prints the counts.
set -euo pipefail
here=$(dirname "$0")
cp "$here/measure-blip.mjs" scripts/.measure-blip.tmp.mjs
SEED_TURNS=80 node_modules/.bin/tsx .agents/tools/streaming-preview.ts 4190 > /dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null || true; rm -f scripts/.measure-blip.tmp.mjs' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:4190/ > /dev/null && break; sleep 0.5; done
node scripts/.measure-blip.tmp.mjs 4190 "$1"
