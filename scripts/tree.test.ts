import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TREE_DEPTH } from "../shared/constants.ts";
import {
  buildTree,
  buildZeroes,
  createPoseidonHash,
  type MerklePath,
  type PoseidonHash,
} from "./tree.ts";

type TestVectors = {
  zeros: Array<{ dec: string }>;
};

type ExampleInput = {
  root: string;
  pathElements: string[];
  pathIndices: number[];
};

type ExampleMeta = {
  leafIndex: number;
  leaves: string[];
};

function calculateRoot(
  leaf: bigint,
  path: MerklePath,
  hash: PoseidonHash,
): bigint {
  return path.pathElements.reduce((current, sibling, level) => {
    const isRight = path.pathIndices[level] === 1;
    return isRight ? hash([sibling, current]) : hash([current, sibling]);
  }, leaf);
}

async function main(): Promise<void> {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const vectorsPath = resolve(scriptDirectory, "../shared/test-vectors.json");
  const vectors = JSON.parse(await readFile(vectorsPath, "utf8")) as TestVectors;
  const exampleInputPath = resolve(scriptDirectory, "../circuits/input.example.json");
  const exampleMetaPath = resolve(scriptDirectory, "../circuits/input.example.meta.json");
  const exampleInput = JSON.parse(
    await readFile(exampleInputPath, "utf8"),
  ) as ExampleInput;
  const exampleMeta = JSON.parse(await readFile(exampleMetaPath, "utf8")) as ExampleMeta;
  const hash = await createPoseidonHash();

  const expectedZeroes = vectors.zeros.map(({ dec }) => BigInt(dec));
  assert.deepEqual(buildZeroes(TREE_DEPTH, hash), expectedZeroes);

  const emptyTree = await buildTree([], TREE_DEPTH, hash);
  assert.equal(emptyTree.root, expectedZeroes[TREE_DEPTH]);

  const leaves = [hash([11n]), hash([22n]), hash([33n])];
  const tree = await buildTree(leaves, TREE_DEPTH, hash);
  for (const [index, leaf] of leaves.entries()) {
    const path = tree.getPath(index);
    assert.equal(path.pathElements.length, TREE_DEPTH);
    assert.equal(path.pathIndices.length, TREE_DEPTH);
    assert.equal(calculateRoot(leaf, path, hash), tree.root);
  }

  assert.deepEqual(tree.getPath(2).pathIndices.slice(0, 3), [0, 1, 0]);
  assert.throws(() => tree.getPath(3), RangeError);
  await assert.rejects(() => buildTree(Array(257).fill(0n), TREE_DEPTH, hash), RangeError);

  const referenceTree = await buildTree(exampleMeta.leaves.map(BigInt), TREE_DEPTH, hash);
  const referencePath = referenceTree.getPath(exampleMeta.leafIndex);
  assert.equal(referenceTree.root, BigInt(exampleInput.root));
  assert.deepEqual(referencePath.pathElements, exampleInput.pathElements.map(BigInt));
  assert.deepEqual(referencePath.pathIndices, exampleInput.pathIndices);

  console.log("Tree builder tests passed");
  console.log(`root: 0x${tree.root.toString(16).padStart(64, "0")}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
