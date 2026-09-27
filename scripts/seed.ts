import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from "@solana/web3.js";

const DEFAULT_COUNT = 30;
const DEFAULT_TARGET_SOL = 0.1;
const MAX_AIRDROP_ATTEMPTS = 3;

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

async function fundWallet(
  connection: Connection,
  wallet: SeedWallet,
  targetLamports: number,
): Promise<void> {
  const publicKey = wallet.keypair.publicKey;
  const currentBalance = await connection.getBalance(publicKey, "confirmed");
  if (currentBalance >= targetLamports) {
    console.log(`${wallet.index}: ${publicKey.toBase58()} already funded`);
    return;
  }

  const needed = targetLamports - currentBalance;
  for (let attempt = 1; attempt <= MAX_AIRDROP_ATTEMPTS; attempt += 1) {
    try {
      const signature = await connection.requestAirdrop(publicKey, needed);
      await connection.confirmTransaction(signature, "confirmed");
      console.log(`${wallet.index}: ${publicKey.toBase58()} funded (${signature})`);
      return;
    } catch (error: unknown) {
      if (attempt === MAX_AIRDROP_ATTEMPTS) throw error;
      const delayMs = attempt * 5_000;
      console.warn(`${wallet.index}: airdrop attempt ${attempt} failed; retrying`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const count = Math.trunc(parsePositiveNumber(process.env.SEED_WALLET_COUNT, DEFAULT_COUNT));
  const targetSol = parsePositiveNumber(process.env.SEED_WALLET_SOL, DEFAULT_TARGET_SOL);
  const rpcUrl = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");
  const shouldFund = process.argv.includes("--fund");

  await mkdir(walletDirectory, { recursive: true, mode: 0o700 });
  const wallets: SeedWallet[] = [];
  for (let index = 0; index < count; index += 1) {
    wallets.push(await loadOrCreateWallet(index));
  }

  console.log(`Prepared ${wallets.length} seed wallets in ${walletDirectory}`);
  for (const wallet of wallets) {
    console.log(`${wallet.index}: ${wallet.keypair.publicKey.toBase58()}`);
  }

  if (!shouldFund) {
    console.log("Run with --fund to request separate devnet airdrops.");
    return;
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const targetLamports = Math.round(targetSol * LAMPORTS_PER_SOL);
  for (const wallet of wallets) {
    await fundWallet(connection, wallet, targetLamports);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
