import { buildPoseidon } from "circomlibjs";

import { FIELD_MODULUS, TREE_DEPTH } from "../shared/constants.ts";

export type PoseidonHash = (inputs: readonly bigint[]) => bigint;

export type MerklePath = {
  pathElements: bigint[];
  pathIndices: number[];
};

export type MerkleTree = {
  root: bigint;
  getPath(index: number): MerklePath;
};

export async function createPoseidonHash(): Promise<PoseidonHash> {
  const poseidon = await buildPoseidon();

  return (inputs: readonly bigint[]): bigint =>
    BigInt(poseidon.F.toObject(poseidon([...inputs])).toString());
}

export function buildZeroes(depth: number, hash: PoseidonHash): bigint[] {
  assertDepth(depth);

  const zeroes = [0n];
  for (let level = 0; level < depth; level += 1) {
    zeroes.push(hash([zeroes[level], zeroes[level]]));
  }
  return zeroes;
}

export async function buildTree(
  leaves: readonly bigint[],
  depth = TREE_DEPTH,
  providedHash?: PoseidonHash,
): Promise<MerkleTree> {
  assertDepth(depth);

  const capacity = 2 ** depth;
  if (leaves.length > capacity) {
    throw new RangeError(`Tree depth ${depth} supports at most ${capacity} leaves`);
  }

  for (const [index, leaf] of leaves.entries()) {
    if (leaf < 0n || leaf >= FIELD_MODULUS) {
      throw new RangeError(`Leaf ${index} is outside the BN254 scalar field`);
    }
  }

  const hash = providedHash ?? (await createPoseidonHash());
  const zeroes = buildZeroes(depth, hash);
  const levels: bigint[][] = [
    Array.from({ length: capacity }, (_, index) => leaves[index] ?? zeroes[0]),
  ];

  for (let level = 0; level < depth; level += 1) {
    const currentLevel = levels[level];
    const nextLevel: bigint[] = [];
    for (let index = 0; index < currentLevel.length; index += 2) {
      nextLevel.push(hash([currentLevel[index], currentLevel[index + 1]]));
    }
    levels.push(nextLevel);
  }

  return {
    root: levels[depth][0],
    getPath(index: number): MerklePath {
      if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
        throw new RangeError(`Leaf index ${index} is outside 0..${leaves.length - 1}`);
      }

      const pathElements: bigint[] = [];
      const pathIndices: number[] = [];
      let currentIndex = index;

      for (let level = 0; level < depth; level += 1) {
        const isRight = currentIndex & 1;
        const siblingIndex = isRight === 0 ? currentIndex + 1 : currentIndex - 1;
        pathElements.push(levels[level][siblingIndex]);
        pathIndices.push(isRight);
        currentIndex = Math.floor(currentIndex / 2);
      }

      return { pathElements, pathIndices };
    },
  };
}

function assertDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
    throw new RangeError("Tree depth must be an integer from 1 to 30");
  }
}
