#!/usr/bin/env bash
# run-measure.sh <label> <FULL 0|1> <CPU throttle>, from the repository root of a probe build
# (PROBE=1 npm run build after applying probe-before.patch or probe-after.patch and copying probe.ts
# to src/probe.ts). Starts a fresh streaming preview per run, so every run begins from the same seed.
set -euo pipefail
label=$1; full=$2; cpu=$3
here=$(dirname "$0")
cp "$here/measure-window.mjs" scripts/.measure-window.tmp.mjs
SEED_TURNS=80 ANSWER_PARAGRAPHS=80 node_modules/.bin/tsx .agents/tools/streaming-preview.ts 4190 > /dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null || true; rm -f scripts/.measure-window.tmp.mjs' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:4190/ > /dev/null && break; sleep 0.5; done
FULL=$full CPU=$cpu node scripts/.measure-window.tmp.mjs 4190 "$label"
