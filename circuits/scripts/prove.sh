#!/usr/bin/env bash
# Generates a Groth16 proof for input.example.json and verifies it with snarkjs.
set -euo pipefail
cd "$(dirname "$0")/.."

snarkjs groth16 fullprove input.example.json \
  build/zkclaim_js/zkclaim.wasm build/zkclaim_final.zkey \
  build/proof.json build/public.json

snarkjs groth16 verify build/verification_key.json build/public.json build/proof.json
