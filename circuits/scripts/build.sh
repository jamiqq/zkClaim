#!/usr/bin/env bash
# Builds the zkClaim circuit: compile -> trusted setup (demo-only) -> copy browser assets.
# Run from anywhere: ./circuits/scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build

PTAU=pot14_final.ptau

# 1. Powers of Tau, phase 1 (single-party = DEMO ONLY). Done once, reused on rebuilds.
if [ ! -f "$PTAU" ]; then
  echo "==> Powers of Tau (2^14)"
  snarkjs powersoftau new bn128 14 pot14_0000.ptau
  snarkjs powersoftau contribute pot14_0000.ptau pot14_0001.ptau --name="zkclaim" -e="$(openssl rand -hex 32)"
  snarkjs powersoftau prepare phase2 pot14_0001.ptau "$PTAU"
  rm -f pot14_0000.ptau pot14_0001.ptau
fi

# 2. Compile
echo "==> Compile"
circom zkclaim.circom --r1cs --wasm --sym -l node_modules -o build
snarkjs r1cs info build/zkclaim.r1cs

# 3. Groth16 phase 2 (single-party = DEMO ONLY)
echo "==> Groth16 setup"
snarkjs groth16 setup build/zkclaim.r1cs "$PTAU" build/zkclaim_0000.zkey
snarkjs zkey contribute build/zkclaim_0000.zkey build/zkclaim_final.zkey --name="zkclaim" -e="$(openssl rand -hex 32)"
rm -f build/zkclaim_0000.zkey
snarkjs zkey export verificationkey build/zkclaim_final.zkey build/verification_key.json

# 4. Browser assets for the web app
mkdir -p ../web/public/zk
cp build/zkclaim_js/zkclaim.wasm build/zkclaim_final.zkey ../web/public/zk/

echo "==> Done. Next: node scripts/gen-input.js && ./scripts/prove.sh"
