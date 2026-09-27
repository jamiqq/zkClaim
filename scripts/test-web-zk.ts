// End-to-end test of Kracavec's web/src/lib/zk.ts against the circuit (P1) and tree builder (P3).
//   tree (Sasha) -> buildInput + nullifierOf (Kracavec) -> real Groth16 proof -> snarkjs verify
//   -> proofToBytes (Kracavec) == reference bytes -> writes circuits/build/proof.json + public.json
//   so the Rust groth16-solana test can check the exact same proof.
// Run from repo root:  npx tsx scripts/test-web-zk.ts
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import * as snarkjs from "snarkjs";
import { PublicKey, Keypair } from "@solana/web3.js";
import { buildInput, proofToBytes, recipientLimbs, nullifierOf } from "../web/src/lib/zk";
import { buildTree, createPoseidonHash } from "./tree";

const require = createRequire(__filename);
const ref = require("../circuits/scripts/solana-format.js");
const B = path.join(__dirname, "..", "circuits", "build");
const WASM = path.join(B, "zkclaim_js", "zkclaim.wasm");
const ZKEY = path.join(B, "zkclaim_final.zkey");
const VK = JSON.parse(fs.readFileSync(path.join(B, "verification_key.json"), "utf8"));

let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

(async () => {
  const H = await createPoseidonHash();
  const secrets = [111n, 222n, 333n, 444n, 555n];
  const tree = await buildTree(secrets.map((s) => H([s])));
  const idx = 3, campaignId = 7n;
  const recipient: PublicKey = Keypair.generate().publicKey;

  // Kracavec's nullifier must equal Poseidon(secret, campaign)
  const nul = await nullifierOf(secrets[idx], campaignId);
  ok(BigInt(nul) === H([secrets[idx], campaignId]), "nullifierOf == Poseidon(secret, campaign)");

  // Kracavec's limbs vs reference
  const { hi, lo } = recipientLimbs(recipient);
  const [eh, el] = ref.recipientToLimbs(recipient.toBytes());
  ok(hi.toString() === eh && lo.toString() === el, "recipientLimbs == reference");

  // Kracavec's circuit input -> real proof
  const input = buildInput({
    secret: secrets[idx], campaignId, recipient, nullifier: BigInt(nul),
    path: { root: tree.root, index: idx, ...tree.getPath(idx) },
  });
  let proof: any, publicSignals: string[] = [];
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.fullProve(input as any, WASM, ZKEY));
    ok(true, "fullProve accepts buildInput");
  } catch (e: any) {
    ok(false, "fullProve rejects buildInput: " + String(e.message ?? e).split("\n")[0]);
    process.exit(1);
  }
  ok(await snarkjs.groth16.verify(VK, publicSignals, proof), "proof verifies (snarkjs)");

  // Kracavec's byte format vs reference
  ok(hex(proofToBytes(proof)) === hex(ref.proofToSolana(proof)), "proofToBytes == reference bytes");

  // hand the same proof to the Rust groth16-solana test
  fs.writeFileSync(path.join(B, "proof.json"), JSON.stringify(proof));
  fs.writeFileSync(path.join(B, "public.json"), JSON.stringify(publicSignals));
  console.log("\nwrote circuits/build/proof.json + public.json (next: export-solana.js + cargo test)");
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures ? 1 : 0);
})();
