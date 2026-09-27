// Generates a valid circuit input (input.example.json) from a real Merkle tree.
// Also the reference implementation of the tree for Sasha (TS infra):
//   leaf = Poseidon(secret), node = Poseidon(left, right), depth 8,
//   zero[0] = 0, zero[i+1] = Poseidon(zero[i], zero[i]),
//   pathIndices[i] = bit i of the leaf index (LSB first), 0 = current node is LEFT.
//
// Usage: node scripts/gen-input.js [recipientPubkeyBase58] [campaignId] [leafIndex]
const fs = require("fs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");
const { PublicKey, Keypair } = require("@solana/web3.js");

const DEPTH = 8;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomField() {
  const b = require("crypto").randomBytes(32);
  return BigInt("0x" + b.toString("hex")) % FIELD;
}

function bytesToBigBE(bytes) {
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

(async () => {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (...xs) => F.toObject(poseidon(xs));

  const recipient = process.argv[2] ? new PublicKey(process.argv[2]) : Keypair.generate().publicKey;
  const campaignId = BigInt(process.argv[3] ?? 1);
  const myIndex = Number(process.argv[4] ?? 3);

  // zero chain
  const zeros = [0n];
  for (let i = 0; i < DEPTH; i++) zeros.push(H(zeros[i], zeros[i]));

  // 5 registrations; ours is at myIndex
  const secrets = Array.from({ length: 5 }, randomField);
  const leaves = secrets.map((s) => H(s));

  // build full tree level by level
  let level = leaves.slice();
  const layers = [level];
  for (let d = 0; d < DEPTH; d++) {
    const next = [];
    const width = Math.ceil(level.length / 2) || 1;
    for (let i = 0; i < width; i++) {
      const l = level[2 * i] ?? zeros[d];
      const r = level[2 * i + 1] ?? zeros[d];
      next.push(H(l, r));
    }
    level = next;
    layers.push(level);
  }
  const root = layers[DEPTH][0];

  // path for myIndex
  const pathElements = [];
  const pathIndices = [];
  let idx = myIndex;
  for (let d = 0; d < DEPTH; d++) {
    const sib = idx ^ 1;
    pathElements.push((layers[d][sib] ?? zeros[d]).toString());
    pathIndices.push(idx & 1);
    idx >>= 1;
  }

  const secret = secrets[myIndex];
  const nullifier = H(secret, campaignId);
  const rb = recipient.toBytes();

  const input = {
    root: root.toString(),
    nullifier: nullifier.toString(),
    recipient_hi: bytesToBigBE(rb.slice(0, 16)).toString(),
    recipient_lo: bytesToBigBE(rb.slice(16, 32)).toString(),
    campaign_id: campaignId.toString(),
    secret: secret.toString(),
    pathElements,
    pathIndices,
  };

  const out = path.join(__dirname, "..", "input.example.json");
  fs.writeFileSync(out, JSON.stringify(input, null, 2));

  const meta = {
    recipient: recipient.toBase58(),
    leafIndex: myIndex,
    leaves: leaves.map(String),
    zeros: zeros.map(String),
  };
  fs.writeFileSync(path.join(__dirname, "..", "input.example.meta.json"), JSON.stringify(meta, null, 2));

  console.log("wrote input.example.json (+ .meta.json)");
  console.log("recipient:", recipient.toBase58(), " leafIndex:", myIndex, " campaign:", campaignId.toString());
  console.log("root:", root.toString());
  console.log("zero[8]:", zeros[DEPTH].toString());
})();
