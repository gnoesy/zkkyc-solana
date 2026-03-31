#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

INTERVAL_SECONDS="${MXE_LOOP_INTERVAL_SECONDS:-3600}"
ANCHOR_WALLET="${ANCHOR_WALLET:-/Users/macmini/.config/solana/devnet.json}"

while true; do
  TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "[mxe_loop] ts=${TS} repo=zkkyc-solana wallet=${ANCHOR_WALLET}"
  if ! ANCHOR_WALLET="${ANCHOR_WALLET}" npx ts-node --transpile-only scripts/run_demo.ts; then
    echo "[mxe_loop] run_demo failed; continuing after cooldown"
  fi
  echo "[mxe_loop] sleeping ${INTERVAL_SECONDS}s"
  sleep "${INTERVAL_SECONDS}"
done
