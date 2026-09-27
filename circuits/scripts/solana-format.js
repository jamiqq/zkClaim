// Converts a snarkjs Groth16 proof into the byte layout groth16-solana expects.
// Used by the web app (browser) and by scripts/tests (node).
//
// proof (256 bytes, big-endian):
//   proof_a (64)  = G1 (x, -y)          <- a is NEGATED
//   proof_b (128) = G2 (x.c1, x.c0, y.c1, y.c0)
//   proof_c (64)  = G1 (x, y)
// public inputs: 32-byte big-endian each, in circuit declaration order.

// BN254 base field (coordinates), NOT the scalar field
const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

function be32(v) {
  const hex = BigInt(v).toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("value does not fit in 32 bytes: " + v);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function proofToSolana(proof) {
  const ax = BigInt(proof.pi_a[0]);
  const ay = BigInt(proof.pi_a[1]);
  const ayNeg = ay === 0n ? 0n : (BASE_FIELD - ay) % BASE_FIELD;

  const proofA = concat([be32(ax), be32(ayNeg)]);
  const proofB = concat([
    be32(proof.pi_b[0][1]), be32(proof.pi_b[0][0]),
    be32(proof.pi_b[1][1]), be32(proof.pi_b[1][0]),
  ]);
  const proofC = concat([be32(proof.pi_c[0]), be32(proof.pi_c[1])]);

  return concat([proofA, proofB, proofC]); // 256 bytes
}

function publicSignalsToSolana(publicSignals) {
  return publicSignals.map(be32); // Array<Uint8Array(32)>
}

// Solana pubkey (32 bytes) -> [hi, lo] circuit inputs as decimal strings
function recipientToLimbs(pubkeyBytes) {
  const toBig = (b) => BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
  return [toBig(pubkeyBytes.slice(0, 16)).toString(), toBig(pubkeyBytes.slice(16, 32)).toString()];
}

module.exports = { proofToSolana, publicSignalsToSolana, recipientToLimbs, be32 };
