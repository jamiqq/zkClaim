#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build

# one-time demo Powers of Tau (2^12 = 4096 constraints; circuit is ~2.5k). Single-party = demo only.
if [ ! -f pot12_final.ptau ]; then
  snarkjs powersoftau new bn128 12 pot12_0000.ptau
  snarkjs powersoftau contribute pot12_0000.ptau pot12_0001.ptau --name="zkclaim" -e="$(date +%s%N)"
  snarkjs powersoftau prepare phase2 pot12_0001.ptau pot12_final.ptau
fi

circom zkclaim.circom --r1cs --wasm --sym -l node_modules -o build
snarkjs r1cs info build/zkclaim.r1cs          # check constraints < 4096, else switch to 13
snarkjs groth16 setup build/zkclaim.r1cs pot12_final.ptau build/zkclaim_0000.zkey
snarkjs zkey contribute build/zkclaim_0000.zkey build/zkclaim_final.zkey --name="zkclaim" -e="$(date +%s%N)"
snarkjs zkey export verificationkey build/zkclaim_final.zkey build/verification_key.json

cp build/zkclaim_js/zkclaim.wasm build/zkclaim_final.zkey ../web/public/zk/
echo "done: convert build/verification_key.json → programs/zkclaim/src/verifying_key.rs"