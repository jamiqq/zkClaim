// Writes build/proof_solana.json: the proof and public inputs in groth16-solana byte layout.
// Rust tests and the relayer can load this directly.
const fs = require("fs");
const path = require("path");
const { proofToSolana, publicSignalsToSolana } = require("./solana-format");

const dir = path.join(__dirname, "..", "build");
const proof = JSON.parse(fs.readFileSync(path.join(dir, "proof.json")));
const pub = JSON.parse(fs.readFileSync(path.join(dir, "public.json")));

const hex = (b) => Buffer.from(b).toString("hex");
const out = {
  proof: hex(proofToSolana(proof)),                 // 256 bytes
  public_inputs: publicSignalsToSolana(pub).map(hex) // 5 x 32 bytes
};
fs.writeFileSync(path.join(dir, "proof_solana.json"), JSON.stringify(out, null, 2));
console.log("wrote build/proof_solana.json (proof", out.proof.length / 2, "bytes,", out.public_inputs.length, "inputs)");
