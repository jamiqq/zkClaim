import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { Connection, PublicKey } from "@solana/web3.js";

import {
  CLUSTER_URL,
  PROGRAM_ID,
  SEED_CAMPAIGN,
  SEED_TREE,
  TREE_DEPTH,
} from "../shared/constants.ts";
import { buildTree } from "./tree.ts";

const MAX_LEAVES = 2 ** TREE_DEPTH;
const DISCRIMINATOR_BYTES = 8;
const FILLED_SUBTREES_BYTES = TREE_DEPTH * 32;
const ROOT_OFFSET = DISCRIMINATOR_BYTES + FILLED_SUBTREES_BYTES;
const LEAVES_OFFSET = ROOT_OFFSET + 32;
const NEXT_INDEX_OFFSET = LEAVES_OFFSET + MAX_LEAVES * 32;
export const TREE_ACCOUNT_SIZE = NEXT_INDEX_OFFSET + 4;

export type OnchainTree = {
  currentRoot: bigint;
  leaves: bigint[];
  nextIndex: number;
};

function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  const hex = Buffer.from(bytes).toString("hex");
  return BigInt(`0x${hex || "0"}`);
}

function bigIntToHex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function parseTreeAccount(data: Uint8Array): OnchainTree {
  const buffer = Buffer.from(data);
  if (buffer.length < TREE_ACCOUNT_SIZE) {
    throw new Error(`Tree account is ${buffer.length} bytes; expected at least ${TREE_ACCOUNT_SIZE}`);
  }

  const expectedDiscriminator = accountDiscriminator("Tree");
  if (!buffer.subarray(0, 8).equals(expectedDiscriminator)) {
    throw new Error("Account discriminator is not Tree");
  }

  const nextIndex = buffer.readUInt32LE(NEXT_INDEX_OFFSET);
  if (nextIndex > MAX_LEAVES) {
    throw new Error(`Tree next_index ${nextIndex} exceeds capacity ${MAX_LEAVES}`);
  }

  const leaves = Array.from({ length: nextIndex }, (_, index) => {
    const start = LEAVES_OFFSET + index * 32;
    return bytesToBigInt(buffer.subarray(start, start + 32));
  });

  return {
    currentRoot: bytesToBigInt(buffer.subarray(ROOT_OFFSET, ROOT_OFFSET + 32)),
    leaves,
    nextIndex,
  };
}

function campaignIdBytes(campaignId: bigint): Buffer {
  if (campaignId < 0n || campaignId > (1n << 64n) - 1n) {
    throw new RangeError("Campaign ID must fit in an unsigned 64-bit integer");
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(campaignId);
  return bytes;
}

export function resolveCampaign(value: string, programId: PublicKey): PublicKey {
  if (/^\d+$/.test(value)) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEED_CAMPAIGN), campaignIdBytes(BigInt(value))],
      programId,
    )[0];
  }
  return new PublicKey(value);
}

export async function checkTreeOnchain(campaignValue: string): Promise<void> {
  const programId = new PublicKey(PROGRAM_ID);
  const campaign = resolveCampaign(campaignValue, programId);
  const tree = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_TREE), campaign.toBuffer()],
    programId,
  )[0];

  const connection = new Connection(process.env.SOLANA_RPC_URL ?? CLUSTER_URL, "confirmed");
  const account = await connection.getAccountInfo(tree, "confirmed");
  if (account === null) {
    throw new Error(`Tree account ${tree.toBase58()} does not exist on devnet`);
  }
  if (!account.owner.equals(programId)) {
    throw new Error(`Tree account is owned by ${account.owner.toBase58()}, not ${programId.toBase58()}`);
  }

  const onchain = parseTreeAccount(account.data);
  const rebuilt = await buildTree(onchain.leaves);
  if (rebuilt.root !== onchain.currentRoot) {
    throw new Error(
      `Merkle root mismatch: TypeScript ${bigIntToHex(rebuilt.root)}, on-chain ${bigIntToHex(onchain.currentRoot)}`,
    );
  }

  console.log(`campaign: ${campaign.toBase58()}`);
  console.log(`tree: ${tree.toBase58()}`);
  console.log(`registrations: ${onchain.nextIndex}`);
  console.log(`root: ${bigIntToHex(onchain.currentRoot)}`);
  console.log("PASS: TypeScript root equals on-chain current_root");
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  const campaign = process.argv[2] ?? process.env.CAMPAIGN;
  if (!campaign) {
    console.error("Usage: yarn check:tree <campaign-id-or-address>");
    process.exitCode = 1;
  } else {
    checkTreeOnchain(campaign).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
