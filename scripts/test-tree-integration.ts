// Integration test: Sasha's tree builder (P3) x Tima's circuit (P1).
// For many tree shapes and leaf positions: build tree with P3's code ->
// take the path -> generate a real Groth16 proof with the circuit -> verify.
// Also checks the zero chain and an on-chain-style incremental insert.
//
// Run from repo root:  npx tsx scripts/test-tree-integration.ts
// Needs: circuits/build (run circuits/scripts/build.sh), snarkjs + circomlibjs in scripts/.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";

// >>> ADAPT THIS IMPORT to Sasha's module / function names <<<
import { buildTree } from "./tree";
// Expected API: buildTree(leaves: bigint[]) -> { root: bigint, getPath(i) -> { pathElements: bigint[], pathIndices: number[] } }

const ROOT = path.join(__dirname, "..");
const WASM = path.join(ROOT, "circuits/build/zkclaim_js/zkclaim.wasm");
const ZKEY = path.join(ROOT, "circuits/build/zkclaim_final.zkey");
const VK = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/verification_key.json"), "utf8"));
const VECTORS = JSON.parse(fs.readFileSync(path.join(ROOT, "shared/test-vectors.json"), "utf8"));
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DEPTH = 8;

let failures = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };
const rnd = () => BigInt("0x" + crypto.randomBytes(32).toString("hex")) % FIELD;

async function main() {
  const p = await buildPoseidon();
  const H = (...xs: bigint[]) => p.F.toObject(p(xs)) as bigint;

  // 1. zero chain vs shared/test-vectors.json (empty tree root = zero[8])
  const empty = await buildTree([]);
  ok(empty.root === BigInt(VECTORS.zeros[DEPTH].dec), "empty tree root == zero[8] from test-vectors.json");

  // 2. proofs from P3 paths verify, across tree sizes and positions
  const cases: Array<[number, number]> = [
    [1, 0], [2, 1], [5, 0], [5, 3], [5, 4], [30, 0], [30, 17], [30, 29], [256, 0], [256, 255],
  ];
  for (const [n, idx] of cases) {
    const secrets = Array.from({ length: n }, rnd);
    const tree = await buildTree(secrets.map((s) => H(s)));
    const { pathElements, pathIndices } = tree.getPath(idx);
    const campaign = 1n;
    const recipient = crypto.randomBytes(32);
    const input = {
      root: tree.root.toString(),
      nullifier: H(secrets[idx], campaign).toString(),
      recipient_hi: BigInt("0x" + recipient.subarray(0, 16).toString("hex")).toString(),
      recipient_lo: BigInt("0x" + recipient.subarray(16).toString("hex")).toString(),
      campaign_id: campaign.toString(),
      secret: secrets[idx].toString(),
      pathElements: pathElements.map(String),
      pathIndices,
    };
    let verified = false;
    try {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
      verified = await snarkjs.groth16.verify(VK, publicSignals, proof);
    } catch (e) { /* witness fails if path is wrong */ }
    ok(verified, `tree of ${n}, leaf ${idx}: proof from P3 path verifies`);
  }

  // 3. on-chain style incremental insert (Tornado filled_subtrees) == full build
  const leaves = Array.from({ length: 30 }, () => H(rnd()));
  const zeros = [0n]; for (let i = 0; i < DEPTH; i++) zeros.push(H(zeros[i], zeros[i]));
  const filled = zeros.slice(0, DEPTH);
  let incRoot = zeros[DEPTH];
  leaves.forEach((leaf, n) => {
    let cur = leaf, idx = n;
    for (let d = 0; d < DEPTH; d++) {
      if ((idx & 1) === 0) { filled[d] = cur; cur = H(cur, zeros[d]); }
      else { cur = H(filled[d], cur); }
      idx >>= 1;
    }
    incRoot = cur;
  });
  ok(incRoot === (await buildTree(leaves)).root, "incremental insert (on-chain algorithm) root == P3 full-tree root");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
