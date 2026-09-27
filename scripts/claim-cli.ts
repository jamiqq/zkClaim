// End-to-end claim on devnet from the command line (also the demo fallback).
//
//   npx tsx claim-cli.ts freeze <campaignId>
//       admin freezes the campaign (claims only work after freeze)
//   npx tsx claim-cli.ts claim <campaignId> <entryIndex> [recipientBase58]
//       builds a fresh proof for demo-secrets.json[entryIndex] against the ON-CHAIN tree
//       and sends the claim. Recipient defaults to a fresh keypair (saved to .recipients/).
//       Writes the proof to .last-claim.json for the attack tests below.
//   npx tsx claim-cli.ts replay <campaignId>
//       re-sends the last proof + nullifier to the same recipient -> MUST FAIL (nullifier used)
//   npx tsx claim-cli.ts prove-only <campaignId> <unusedEntryIndex>
//       proof + nullifier for a fresh recipient, NOT sent -> relayer-test-proof-<i>.json (shareable)
//   npx tsx claim-cli.ts swap-fresh <campaignId> <unusedEntryIndex>
//       proof for recipient X submitted for recipient Y with an UNUSED nullifier
//       -> MUST FAIL on the proof; the entry stays claimable afterwards
//
// Relayer = ~/.config/solana/id.json (pays fee + ATA rent). RPC_URL from env.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, getAccount,
} from "@solana/spl-token";
// eslint-disable-next-line
const snarkjs: any = require("snarkjs");
import { buildTree, createPoseidonHash } from "./tree";

const { proofToSolana, recipientToLimbs } = require("../circuits/scripts/solana-format.js");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const IDL = JSON.parse(fs.readFileSync(path.join(ROOT, "shared", "idl", "zkclaim.json"), "utf8"));
const PROGRAM_ID = new PublicKey(IDL.address);
const WASM = fs.existsSync(path.join(ROOT, "web/public/zk/zkclaim.wasm"))
  ? path.join(ROOT, "web/public/zk/zkclaim.wasm") : path.join(ROOT, "circuits/build/zkclaim_js/zkclaim.wasm");
const ZKEY = fs.existsSync(path.join(ROOT, "web/public/zk/zkclaim_final.zkey"))
  ? path.join(ROOT, "web/public/zk/zkclaim_final.zkey") : path.join(ROOT, "circuits/build/zkclaim_final.zkey");
const LAST = path.join(HERE, ".last-claim.json");
const RECIPIENTS = path.join(HERE, ".recipients");

const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const be32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");

function setup() {
  const relayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf8"))));
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(relayer), { commitment: "confirmed" });
  const program: any = new anchor.Program(IDL as anchor.Idl, provider);
  return { relayer, connection, program };
}

async function readTree(connection: Connection, campaign: PublicKey) {
  // Tree layout (Sava): disc 8 | filled_subtrees 256 | current_root 32 | leaves 8192 | next_index u32 LE (last 4)
  const tree = pda([Buffer.from("tree"), campaign.toBuffer()]);
  const info = await connection.getAccountInfo(tree, "confirmed");
  if (!info) throw new Error("tree account not found");
  const d = info.data;
  const next = d.readUInt32LE(d.length - 4);
  const root = BigInt("0x" + d.subarray(8 + 256, 8 + 256 + 32).toString("hex"));
  const leaves: bigint[] = [];
  for (let i = 0; i < next; i++) leaves.push(BigInt("0x" + d.subarray(296 + 32 * i, 296 + 32 * (i + 1)).toString("hex")));
  return { root, leaves };
}

async function sendClaim(program: any, relayer: Keypair, campaign: PublicKey, mint: PublicKey,
                         recipient: PublicKey, proof: Buffer, nullifier: Buffer) {
  const recipientToken = getAssociatedTokenAddressSync(mint, recipient);
  return program.methods.claim(Array.from(proof), Array.from(nullifier))
    .accountsPartial({
      relayer: relayer.publicKey,
      campaign,
      nullifierAccount: pda([Buffer.from("nullifier"), campaign.toBuffer(), nullifier]),
      recipient,
      recipientToken,
      vault: getAssociatedTokenAddressSync(mint, campaign, true),
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, recipientToken, recipient, mint),
    ])
    .rpc();
}

async function main() {
  const [cmd, idArg, entryArg, recipientArg] = process.argv.slice(2);
  if (!cmd || !idArg) throw new Error("usage: claim-cli.ts freeze|claim|replay|swap-fresh|prove-only <campaignId> [entryIndex] [recipient]");
  const campaignId = BigInt(idArg);
  const campaign = pda([Buffer.from("campaign"), u64le(campaignId)]);
  const { relayer, connection, program } = setup();

  if (cmd === "freeze") {
    const sig = await program.methods.freezeCampaign().accountsPartial({ admin: relayer.publicKey, campaign }).rpc();
    console.log("freeze_campaign", sig);
    return;
  }

  const secrets = JSON.parse(fs.readFileSync(path.join(HERE, "demo-secrets.json"), "utf8"));
  const mint = new PublicKey(secrets.mint);

  const proveFor = async (entryIdx: string | undefined, recipient: PublicKey) => {
    const entry = secrets.entries[Number(entryIdx ?? NaN)];
    if (!entry) throw new Error(`no entry ${entryIdx} in demo-secrets.json`);
    const H = await createPoseidonHash();
    const { root, leaves } = await readTree(connection, campaign);
    const tree = await buildTree(leaves);
    if (tree.root !== root) throw new Error("rebuilt root != on-chain root");
    const index = leaves.findIndex((l) => l === BigInt(entry.commitment));
    if (index < 0) throw new Error("commitment not in on-chain tree");
    const { pathElements, pathIndices } = tree.getPath(index);
    const secret = BigInt(entry.secret);
    const nullifier = H([secret, campaignId]);
    const [hi, lo] = recipientToLimbs(recipient.toBytes());
    const input = {
      root: root.toString(), nullifier: nullifier.toString(), recipient_hi: hi, recipient_lo: lo,
      campaign_id: campaignId.toString(), secret: secret.toString(),
      pathElements: pathElements.map(String), pathIndices,
    };
    const t = Date.now();
    const { proof } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    console.log(`proof generated in ${Date.now() - t} ms (leaf ${index} of ${leaves.length})`);
    return { proofBytes: Buffer.from(proofToSolana(proof)), nullBytes: be32(nullifier) };
  };

  if (cmd === "prove-only") {
    // proof for an unused entry + fresh recipient, NOT sent. Output is safe to share (no secret inside):
    // lets the relayer be tested without the secrets or the circuit build.
    const kp = Keypair.generate();
    fs.mkdirSync(RECIPIENTS, { recursive: true });
    fs.writeFileSync(path.join(RECIPIENTS, `${kp.publicKey.toBase58()}.json`), JSON.stringify(Array.from(kp.secretKey)));
    const { proofBytes, nullBytes } = await proveFor(entryArg, kp.publicKey);
    const nullAcc = pda([Buffer.from("nullifier"), campaign.toBuffer(), nullBytes]);
    if (await connection.getAccountInfo(nullAcc)) throw new Error(`entry ${entryArg} already claimed - pick an unused entry`);
    const out = { campaign: campaign.toBase58(), campaignId: idArg, recipient: kp.publicKey.toBase58(),
      proof: proofBytes.toString("hex"), nullifier: nullBytes.toString("hex") };
    const f = path.join(HERE, `relayer-test-proof-${entryArg}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log("wrote", f, "(no secret inside; safe to send to the relayer dev)");
    return;
  }

  if (cmd === "swap-fresh") {
    // proof made for recipient X, submitted for recipient Y, with an UNUSED nullifier.
    // Must fail on the proof. The nullifier stays unused, so this entry can still claim later.
    const x = Keypair.generate().publicKey, y = Keypair.generate().publicKey;
    const { proofBytes, nullBytes } = await proveFor(entryArg, x);
    const nullAcc = pda([Buffer.from("nullifier"), campaign.toBuffer(), nullBytes]);
    if (await connection.getAccountInfo(nullAcc)) throw new Error(`entry ${entryArg} already claimed - pick an unused entry`);
    try {
      const sig = await sendClaim(program, relayer, campaign, mint, y, proofBytes, nullBytes);
      console.log("UNEXPECTED SUCCESS (swap-fresh):", sig);
      process.exit(1);
    } catch (e: any) {
      const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
      console.log("EXPECTED FAILURE (swap-fresh): proof rejected for a different recipient");
      console.log("  program log:", (logs.find((l) => /Error|failed/i.test(l)) ?? String(e?.message ?? e).split("\n")[0]).slice(0, 160));
      console.log("  nullifier still unused:", (await connection.getAccountInfo(nullAcc)) === null);
    }
    return;
  }

  if (cmd === "claim") {
    let recipient: PublicKey;
    if (recipientArg) recipient = new PublicKey(recipientArg);
    else {
      const kp = Keypair.generate();
      fs.mkdirSync(RECIPIENTS, { recursive: true });
      fs.writeFileSync(path.join(RECIPIENTS, `${kp.publicKey.toBase58()}.json`), JSON.stringify(Array.from(kp.secretKey)));
      recipient = kp.publicKey;
    }
    console.log("recipient (fresh, 0 SOL):", recipient.toBase58());
    const { proofBytes, nullBytes } = await proveFor(entryArg, recipient);
    fs.writeFileSync(LAST, JSON.stringify({ campaignId: idArg, recipient: recipient.toBase58(),
      proof: proofBytes.toString("hex"), nullifier: nullBytes.toString("hex") }, null, 2));
    const sig = await sendClaim(program, relayer, campaign, mint, recipient, proofBytes, nullBytes);
    const bal = (await getAccount(connection, getAssociatedTokenAddressSync(mint, recipient))).amount;
    console.log("claim", sig);
    console.log(`recipient token balance: ${Number(bal) / 1e6}`);
    console.log(`explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    return;
  }

  const last = JSON.parse(fs.readFileSync(LAST, "utf8"));
  const proofBytes = Buffer.from(last.proof, "hex");
  const nullBytes = Buffer.from(last.nullifier, "hex");
  if (cmd !== "replay") throw new Error("unknown command " + cmd + " (use swap-fresh <campaignId> <unusedEntry>)");
  const target = new PublicKey(last.recipient);
  try {
    const sig = await sendClaim(program, relayer, campaign, mint, target, proofBytes, nullBytes);
    console.log(`UNEXPECTED SUCCESS (${cmd}):`, sig);
    process.exit(1);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const reason = /already in use/i.test(msg) ? "nullifier already used"
      : /ProofInvalid|0x17|custom program error/i.test(msg) ? "proof rejected" : msg.split("\n")[0];
    console.log(`EXPECTED FAILURE (${cmd}): ${reason}`);
  }
}

// snarkjs keeps worker threads alive after proving -> exit explicitly
main().then(() => process.exit(0)).catch((e) => { console.error(e?.logs ?? "", e); process.exit(1); });
