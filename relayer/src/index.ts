import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import express, { type Express, type Request, type Response } from "express";

const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_U64 = (1n << 64n) - 1n;
const HEX_32_BYTES = /^(?:0x)?[0-9a-fA-F]{64}$/;
const HEX_256_BYTES = /^(?:0x)?[0-9a-fA-F]{512}$/;
const DEFAULT_ORIGIN = "http://localhost:5173";

export type ClaimRequest = {
  proof: string | number[];
  nullifier: string;
  recipient: string;
  campaign: string | number;
};

export type NormalizedClaim = {
  proof: Buffer;
  nullifier: Buffer;
  recipient: PublicKey;
  campaignId: bigint;
};

export type ClaimSubmitter = (claim: NormalizedClaim) => Promise<string>;

type AppOptions = {
  submitClaim: ClaimSubmitter;
  allowedOrigin?: string;
};

function parseCampaign(value: string | number | undefined): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("campaign must be a safe integer or decimal string");
  }
  const campaign = BigInt(value as string | number);
  if (campaign < 0n || campaign > MAX_U64) {
    throw new Error("campaign must fit in an unsigned 64-bit integer");
  }
  return campaign;
}

function stripHexPrefix(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function validateClaimRequest(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["body must be a JSON object"];
  }

  const body = value as Partial<ClaimRequest>;
  const errors: string[] = [];

  const proofIsHex = typeof body.proof === "string" && HEX_256_BYTES.test(body.proof);
  const proofIsBytes =
    Array.isArray(body.proof) &&
    body.proof.length === 256 &&
    body.proof.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (!proofIsHex && !proofIsBytes) {
    errors.push("proof must be 256 bytes or a 256-byte hex string");
  }

  if (typeof body.nullifier !== "string" || !HEX_32_BYTES.test(body.nullifier)) {
    errors.push("nullifier must be a 32-byte hex string");
  } else if (BigInt(`0x${stripHexPrefix(body.nullifier)}`) >= FIELD_MODULUS) {
    errors.push("nullifier must be smaller than the BN254 scalar field modulus");
  }

  if (typeof body.recipient !== "string") {
    errors.push("recipient must be a Solana address");
  } else {
    try {
      new PublicKey(body.recipient);
    } catch {
      errors.push("recipient must be a valid Solana address");
    }
  }

  try {
    parseCampaign(body.campaign);
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : "campaign must be an unsigned integer");
  }

  return errors;
}

export function normalizeClaimRequest(body: ClaimRequest): NormalizedClaim {
  return {
    proof: typeof body.proof === "string"
      ? Buffer.from(stripHexPrefix(body.proof), "hex")
      : Buffer.from(body.proof),
    nullifier: Buffer.from(stripHexPrefix(body.nullifier), "hex"),
    recipient: new PublicKey(body.recipient),
    campaignId: parseCampaign(body.campaign),
  };
}

function u64le(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function loadRelayerKeypair(): Keypair {
  const keypairPath = process.env.RELAYER_KEYPAIR ??
    resolve(homedir(), ".config", "solana", "id.json");
  const secretKey = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

export function createLiveSubmitter(): ClaimSubmitter {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error("RPC_URL is required");
  }

  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const idlPath = resolve(sourceDirectory, "../../shared/idl/zkclaim.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as anchor.Idl;
  const programId = new PublicKey(idl.address);
  const relayer = loadRelayerKeypair();
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(relayer),
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl, provider) as anchor.Program & {
    account: { campaign: { fetch(address: PublicKey): Promise<{ mint: PublicKey }> } };
  };

  const pda = (seeds: Buffer[]): PublicKey =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];

  return async ({ proof, nullifier, recipient, campaignId }): Promise<string> => {
    const campaign = pda([Buffer.from("campaign"), u64le(campaignId)]);
    const campaignAccount = await program.account.campaign.fetch(campaign);
    const mint = new PublicKey(campaignAccount.mint);
    const recipientToken = getAssociatedTokenAddressSync(mint, recipient);

    return program.methods
      .claim(Array.from(proof), Array.from(nullifier))
      .accountsPartial({
        relayer: relayer.publicKey,
        campaign,
        nullifierAccount: pda([
          Buffer.from("nullifier"),
          campaign.toBuffer(),
          nullifier,
        ]),
        recipient,
        recipientToken,
        vault: getAssociatedTokenAddressSync(mint, campaign, true),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAssociatedTokenAccountIdempotentInstruction(
          relayer.publicKey,
          recipientToken,
          recipient,
          mint,
        ),
      ])
      .rpc();
  };
}

export function createApp({ submitClaim, allowedOrigin = DEFAULT_ORIGIN }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((request: Request, response: Response, next) => {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ ok: true, mode: "live" });
  });

  app.post("/claim", async (request: Request, response: Response) => {
    const errors = validateClaimRequest(request.body);
    if (errors.length > 0) {
      response.status(400).json({ error: "invalid claim request", details: errors });
      return;
    }

    try {
      const signature = await submitClaim(normalizeClaimRequest(request.body as ClaimRequest));
      response.json({
        signature,
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("claim submission failed:", message.split("\n")[0]);
      const alreadyUsed = /already in use/i.test(message);
      response.status(alreadyUsed ? 409 : 502).json({
        error: alreadyUsed ? "nullifier already used" : "claim submission failed",
      });
    }
  });

  return app;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  try {
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? "127.0.0.1";
    const app = createApp({
      submitClaim: createLiveSubmitter(),
      allowedOrigin: process.env.WEB_ORIGIN ?? DEFAULT_ORIGIN,
    });
    app.listen(port, host, () => {
      console.log(`zkClaim relayer listening on http://${host}:${port}`);
    });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
