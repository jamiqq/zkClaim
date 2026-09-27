// Creates the zkClaim demo campaign on devnet. Safe to re-run: every step checks
// on-chain state first, and secrets are persisted BEFORE anything is registered.
//
//   npx tsx demo-campaign.ts <campaignId> [phantomAddress ...]
//
// Steps:
//   1. demo token mint (6 decimals) + mint supply to admin      (skipped if saved)
//   2. create_campaign(campaignId, AMOUNT)                      (skipped if campaign PDA exists)
//   3. fund vault with SEED_COUNT+EXTRA claims worth of tokens  (tops up to target)
//   4. 30 seed wallets (Sasha's .seed-wallets) + random secrets -> demo-secrets.json
//   5. add_eligible: seed wallets + optional Phantom addresses  (skips existing Eligible)
//   6. register all 30: user = seed wallet, payer = admin       (skips existing Registration)
//   NOT frozen: freeze only after `claim` works on devnet.
//
// Admin = ~/.config/solana/id.json (pays rent + fees, ~0.3 SOL total).
// Output: scripts/demo-secrets.json (GITIGNORED - contains secrets).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo,
  getAssociatedTokenAddressSync, getAccount, transfer,
} from "@solana/spl-token";
import { buildPoseidon } from "circomlibjs";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const SEED_COUNT = 30;
const EXTRA_CLAIMS = 5;               // vault headroom (Phantom test wallets, retries)
const DECIMALS = 6;
const AMOUNT = 100n * 10n ** 6n;      // 100 tokens per claim
const ELIGIBLE_BATCH = 10;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const HERE = __dirname;
const IDL = JSON.parse(fs.readFileSync(path.join(HERE, "..", "shared", "idl", "zkclaim.json"), "utf8"));
const PROGRAM_ID = new PublicKey(IDL.address);
const OUT = path.join(HERE, "demo-secrets.json");
const WALLET_DIR = path.join(HERE, ".seed-wallets");

type SeedEntry = { wallet: string; secret: string; commitment: string; commitmentHex: string; index: number | null };
type State = { campaignId: string; mint: string | null; campaign: string; entries: SeedEntry[]; extraEligible: string[] };

const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const be32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
const exists = async (c: Connection, k: PublicKey) => (await c.getAccountInfo(k, "confirmed")) !== null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAUSE = Number(process.env.PAUSE_MS ?? 1500); // between txs, to stay under RPC rate limits
const save = (s: State) => fs.writeFileSync(OUT, JSON.stringify(s, null, 2), { mode: 0o600 });

function loadSeedWallet(i: number): Keypair {
  const f = path.join(WALLET_DIR, `seed-${i.toString().padStart(2, "0")}-keypair.json`);
  if (!fs.existsSync(f)) throw new Error(`missing ${f} - run: npx tsx seed.ts`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
}

async function main() {
  const campaignId = BigInt(process.argv[2] ?? NaN);
  const extraEligible = process.argv.slice(3).map((a) => new PublicKey(a).toBase58());
  if (process.argv[2] === undefined) throw new Error("usage: npx tsx demo-campaign.ts <campaignId> [phantomAddress ...]");

  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf8"))));
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program: any = new anchor.Program(IDL as anchor.Idl, provider);

  const campaign = pda([Buffer.from("campaign"), u64le(campaignId)]);
  const tree = pda([Buffer.from("tree"), campaign.toBuffer()]);
  console.log("admin   ", admin.publicKey.toBase58(), (await connection.getBalance(admin.publicKey)) / 1e9, "SOL");
  console.log("campaign", campaignId.toString(), campaign.toBase58());

  // ---- state: load or init; secrets are generated ONCE and saved before any tx ----
  const poseidon = await buildPoseidon();
  const H = (x: bigint) => poseidon.F.toObject(poseidon([x])) as bigint;
  let state: State;
  if (fs.existsSync(OUT)) {
    state = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (state.campaignId !== campaignId.toString())
      throw new Error(`${OUT} belongs to campaign ${state.campaignId}; move it away to start a new campaign`);
  } else {
    const entries: SeedEntry[] = [];
    for (let i = 0; i < SEED_COUNT; i++) {
      const secret = BigInt("0x" + crypto.randomBytes(32).toString("hex")) % FIELD;
      const commitment = H(secret);
      entries.push({ wallet: loadSeedWallet(i).publicKey.toBase58(), secret: secret.toString(),
        commitment: commitment.toString(), commitmentHex: be32(commitment).toString("hex"), index: null });
    }
    state = { campaignId: campaignId.toString(), mint: null, campaign: campaign.toBase58(), entries, extraEligible: [] };
    save(state);
    console.log(`secrets saved -> ${OUT}`);
  }
  state.extraEligible = Array.from(new Set([...state.extraEligible, ...extraEligible]));
  save(state);

  // ---- 1. mint ----
  let mint: PublicKey;
  if (state.mint) { mint = new PublicKey(state.mint); }
  else {
    mint = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
    state.mint = mint.toBase58(); save(state);
    console.log("mint created", mint.toBase58());
  }
  const totalClaims = BigInt(SEED_COUNT + state.extraEligible.length + EXTRA_CLAIMS);
  const adminAta = await getOrCreateAssociatedTokenAccount(connection, admin, mint, admin.publicKey);
  const adminBal = (await getAccount(connection, adminAta.address)).amount;
  if (adminBal < totalClaims * AMOUNT) await mintTo(connection, admin, mint, adminAta.address, admin, totalClaims * AMOUNT);

  // ---- 2. create_campaign ----
  if (await exists(connection, campaign)) console.log("campaign exists, skip create");
  else {
    const sig = await program.methods.createCampaign(new anchor.BN(campaignId.toString()), new anchor.BN(AMOUNT.toString()))
      .accountsPartial({ admin: admin.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    console.log("create_campaign", sig);
  }

  // ---- 3. fund vault (vault = ATA of campaign PDA) ----
  const vault = getAssociatedTokenAddressSync(mint, campaign, true);
  const vaultBal = (await getAccount(connection, vault)).amount;
  const target = totalClaims * AMOUNT;
  if (vaultBal < target) {
    await transfer(connection, admin, adminAta.address, vault, admin, target - vaultBal);
  }
  console.log("vault", vault.toBase58(), "balance", Number((await getAccount(connection, vault)).amount) / 10 ** DECIMALS);

  // ---- 5. add_eligible (Eligible PDAs as writable remaining accounts) ----
  const toAllow: PublicKey[] = [];
  for (const w of [...state.entries.map((e) => e.wallet), ...state.extraEligible]) {
    const user = new PublicKey(w);
    const eligible = pda([Buffer.from("eligible"), campaign.toBuffer(), user.toBuffer()]);
    const registration = pda([Buffer.from("registration"), campaign.toBuffer(), user.toBuffer()]);
    if (!(await exists(connection, eligible)) && !(await exists(connection, registration))) toAllow.push(user);
  }
  for (let i = 0; i < toAllow.length; i += ELIGIBLE_BATCH) {
    const batch = toAllow.slice(i, i + ELIGIBLE_BATCH);
    const sig = await program.methods.addEligible(batch)
      .accountsPartial({ admin: admin.publicKey, campaign })
      .remainingAccounts(batch.map((u) => ({
        pubkey: pda([Buffer.from("eligible"), campaign.toBuffer(), u.toBuffer()]), isSigner: false, isWritable: true,
      })))
      .rpc();
    console.log(`add_eligible ${i}..${i + batch.length - 1}`, sig);
    await sleep(PAUSE);
  }

  // ---- 6. register 30 (user signs, admin pays) ----
  for (const [i, e] of state.entries.entries()) {
    const user = loadSeedWallet(i);
    const registration = pda([Buffer.from("registration"), campaign.toBuffer(), user.publicKey.toBuffer()]);
    if (await exists(connection, registration)) continue;
    let sig = "";
    for (let attempt = 1; ; attempt++) {
      try {
        sig = await program.methods.register(Array.from(Buffer.from(e.commitmentHex, "hex")))
          .accountsPartial({ user: user.publicKey, payer: admin.publicKey, campaign })
          .signers([user])
          .rpc();
        break;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        // a previous attempt may have landed before the error: check before retrying
        if (await exists(connection, registration)) { sig = "(landed on earlier attempt)"; break; }
        if (attempt >= 5 || !/429|Too Many|timeout|blockhash|fetch failed/i.test(msg)) throw err;
        console.log(`register ${i}: ${msg.split("\n")[0].slice(0, 80)} - retry ${attempt}/5 in ${attempt * 3}s`);
        await sleep(attempt * 3000);
      }
    }
    console.log(`register ${i}`, sig);
    await sleep(PAUSE);
  }

  // ---- leaf indices from the on-chain tree (Tree layout per Sava: disc 8 | filled 256 | root 32 | leaves 8192 | next_index u32) ----
  const info = await connection.getAccountInfo(tree, "confirmed");
  if (!info) throw new Error("tree account missing");
  const LEAVES_OFF = 8 + 256 + 32;
  const nextIndex = info.data.readUInt32LE(info.data.length - 4);
  const onchain = new Map<string, number>();
  for (let i = 0; i < nextIndex; i++) onchain.set(info.data.subarray(LEAVES_OFF + 32 * i, LEAVES_OFF + 32 * (i + 1)).toString("hex"), i);
  let missing = 0;
  for (const e of state.entries) { e.index = onchain.get(e.commitmentHex) ?? null; if (e.index === null) missing++; }
  save(state);

  console.log(`\nleaves on-chain: ${nextIndex}; seed commitments found: ${SEED_COUNT - missing}/${SEED_COUNT}`);
  console.log(missing === 0 ? "ALL SEED REGISTRATIONS ON-CHAIN" : `${missing} MISSING - re-run the script`);
  console.log(`next: npx tsx check-tree-onchain.ts ${campaignId}`);
  process.exit(missing === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
