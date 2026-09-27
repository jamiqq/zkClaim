import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";

const DEFAULT_COUNT = 30;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const walletDirectory = resolve(scriptDirectory, ".seed-wallets");

type SeedWallet = {
  index: number;
  path: string;
  keypair: Keypair;
};

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received ${value}`);
  }
  return parsed;
}

async function loadOrCreateWallet(index: number): Promise<SeedWallet> {
  const filename = `seed-${index.toString().padStart(2, "0")}-keypair.json`;
  const path = resolve(walletDirectory, filename);

  try {
    const secretKey = JSON.parse(await readFile(path, "utf8")) as number[];
    return { index, path, keypair: Keypair.fromSecretKey(Uint8Array.from(secretKey)) };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const keypair = Keypair.generate();
  await writeFile(path, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return { index, path, keypair };
}

async function main(): Promise<void> {
  const count = Math.trunc(parsePositiveNumber(process.env.SEED_WALLET_COUNT, DEFAULT_COUNT));
  if (process.argv.includes("--fund")) {
    throw new Error(
      "Seed wallets do not need SOL. Use the funded sponsor as tx.feePayer and sign with both sponsor and seed wallet.",
    );
  }

  await mkdir(walletDirectory, { recursive: true, mode: 0o700 });
  const wallets: SeedWallet[] = [];
  for (let index = 0; index < count; index += 1) {
    wallets.push(await loadOrCreateWallet(index));
  }

  console.log(`Prepared ${wallets.length} seed wallets in ${walletDirectory}`);
  for (const wallet of wallets) {
    console.log(`${wallet.index}: ${wallet.keypair.publicKey.toBase58()}`);
  }

  console.log(
    "Seed wallets need no SOL; registration transactions use the funded sponsor as fee payer.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
