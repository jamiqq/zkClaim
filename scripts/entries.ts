// Demo-campaign entries: which are still unused, and a .zkclaim backup for any of them.
// Reads scripts/demo-secrets.json (written by demo-campaign.ts, gitignored).
//
//   npx tsx entries.ts list                 # every entry: unused / USED / reserved
//   npx tsx entries.ts backup <i>           # writes zkclaim-entry-<i>.zkclaim (load it on the Claim page)
//   SECRETS_FILE=video-secrets.json npx tsx entries.ts list   # another campaign's secrets file
//
// Uses RPC_URL (Helius) if set. Output .zkclaim files contain secrets: *.zkclaim is gitignored.
import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { buildPoseidon } from "circomlibjs";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const FILE = process.env.SECRETS_FILE
  ? path.resolve(process.env.SECRETS_FILE)
  : path.join(__dirname, "demo-secrets.json");
const RESERVED = new Set([23, 24]); // live demo + backup: never use for tests
const PROGRAM_ID = new PublicKey(
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "shared", "idl", "zkclaim.json"),
      "utf8",
    ),
  ).address,
);

type Entry = {
  wallet: string;
  secret: string;
  commitment: string;
  index: number | null;
};
const state: { campaignId: string; entries: Entry[] } = JSON.parse(
  fs.readFileSync(FILE, "utf8"),
);
const campaignId = BigInt(state.campaignId);

const be32 = (v: bigint) =>
  Buffer.from(v.toString(16).padStart(64, "0"), "hex");
const hex32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const pda = (seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const poseidon = await buildPoseidon();
  const H = (xs: bigint[]) => poseidon.F.toObject(poseidon(xs)) as bigint;

  if (cmd === "backup") {
    const i = Number(arg);
    const e = state.entries[i];
    if (!Number.isInteger(i) || !e)
      throw new Error(`no entry ${arg} (0..${state.entries.length - 1})`);
    if (RESERVED.has(i))
      console.warn(`warning: entry ${i} is reserved for the live demo`);
    const secret = BigInt(e.secret);
    if (H([secret]) !== BigInt(e.commitment))
      throw new Error(`entry ${i}: secret does not match commitment`);
    const out = `zkclaim-entry-${i}.zkclaim`;
    const backup = {
      app: "zkclaim",
      version: 1,
      campaignId: state.campaignId,
      wallet: e.wallet,
      secret: hex32(secret),
      commitment: hex32(BigInt(e.commitment)),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(out, JSON.stringify(backup, null, 2), { mode: 0o600 });
    console.log(
      `wrote ${path.resolve(out)} (campaign ${state.campaignId}, leaf ${e.index})`,
    );
    return;
  }

  if (cmd !== "list") {
    console.log("usage: npx tsx entries.ts list | backup <i>");
    process.exit(1);
  }
  const campaign = pda([Buffer.from("campaign"), u64le(campaignId)]);
  const nullifierPdas = state.entries.map((e) =>
    pda([
      Buffer.from("nullifier"),
      campaign.toBuffer(),
      be32(H([BigInt(e.secret), campaignId])),
    ]),
  );
  const conn = new Connection(RPC, "confirmed");
  const infos = await conn.getMultipleAccountsInfo(nullifierPdas, "confirmed");
  const free: number[] = [];
  state.entries.forEach((e, i) => {
    const used = infos[i] !== null;
    const tag = used
      ? "USED"
      : RESERVED.has(i)
        ? "unused (RESERVED - don't touch)"
        : "unused";
    if (!used && !RESERVED.has(i)) free.push(i);
    console.log(
      `entry ${String(i).padStart(2)}  leaf ${String(e.index ?? "?").padStart(3)}  ${tag}`,
    );
  });
  console.log(
    `\ncampaign ${state.campaignId}: ${free.length} free for testing -> ${free.join(", ")}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
