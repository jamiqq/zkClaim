// Poseidon test vectors (circomlibjs). Every layer must reproduce these byte for byte.
// Writes ../shared/test-vectors.json (decimal + 32-byte big-endian hex).
const fs = require("fs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");
(async () => {
  const p = await buildPoseidon();
  const H = (...xs) => p.F.toObject(p(xs));
  const hex = (v) => v.toString(16).padStart(64, "0");
  const zeros = [0n];
  for (let i = 0; i < 8; i++) zeros.push(H(zeros[i], zeros[i]));
  const v = {
    poseidon_1: H(1n), poseidon_1_2: H(1n, 2n), zeros,
  };
  const out = {
    note: "circomlib Poseidon BN254 x5; hex = 32-byte big-endian",
    "poseidon(1)": { dec: v.poseidon_1.toString(), hex: hex(v.poseidon_1) },
    "poseidon(1,2)": { dec: v.poseidon_1_2.toString(), hex: hex(v.poseidon_1_2) },
    zeros: zeros.map((z) => ({ dec: z.toString(), hex: hex(z) })),
  };
  const f = path.join(__dirname, "..", "..", "shared", "test-vectors.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log("wrote", f);
  console.log("poseidon(1)   ", hex(v.poseidon_1));
  console.log("poseidon(1,2) ", hex(v.poseidon_1_2));
  console.log("zero[8]       ", hex(zeros[8]));
})();
