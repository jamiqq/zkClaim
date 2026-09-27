import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { TREE_DEPTH } from "../shared/constants.ts";
import {
  TREE_ACCOUNT_SIZE,
  parseTreeAccount,
} from "./check-tree-onchain.ts";
import { buildTree, createPoseidonHash } from "./tree.ts";

const MAX_LEAVES = 2 ** TREE_DEPTH;
const ROOT_OFFSET = 8 + TREE_DEPTH * 32;
const LEAVES_OFFSET = ROOT_OFFSET + 32;
const NEXT_INDEX_OFFSET = LEAVES_OFFSET + MAX_LEAVES * 32;

function bigintBytes(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

async function main(): Promise<void> {
  const hash = await createPoseidonHash();
  const leaves = [hash([1n]), hash([2n]), hash([3n]), hash([4n]), hash([5n])];
  const tree = await buildTree(leaves);
  const account = Buffer.alloc(TREE_ACCOUNT_SIZE);
  createHash("sha256").update("account:Tree").digest().copy(account, 0, 0, 8);
  bigintBytes(tree.root).copy(account, ROOT_OFFSET);
  leaves.forEach((leaf, index) => bigintBytes(leaf).copy(account, LEAVES_OFFSET + index * 32));
  account.writeUInt32LE(leaves.length, NEXT_INDEX_OFFSET);

  const parsed = parseTreeAccount(account);
  assert.equal(parsed.currentRoot, tree.root);
  assert.deepEqual(parsed.leaves, leaves);
  assert.equal(parsed.nextIndex, leaves.length);

  const badDiscriminator = Buffer.from(account);
  badDiscriminator[0] ^= 0xff;
  assert.throws(() => parseTreeAccount(badDiscriminator), /discriminator/);

  const badIndex = Buffer.from(account);
  badIndex.writeUInt32LE(MAX_LEAVES + 1, NEXT_INDEX_OFFSET);
  assert.throws(() => parseTreeAccount(badIndex), /exceeds capacity/);

  console.log("On-chain Tree parser tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
