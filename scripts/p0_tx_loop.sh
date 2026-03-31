#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

INTERVAL_SECONDS="${TX_LOOP_INTERVAL_SECONDS:-1800}"

while true; do
  TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "[p0_tx_loop] ts=$TS repo=zkkyc-solana"
  node scripts/arcium_interaction.js
  echo "[p0_tx_loop] sleeping ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done
