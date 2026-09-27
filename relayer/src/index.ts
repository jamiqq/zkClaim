import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { PublicKey } from "@solana/web3.js";
import express, { type Express, type Request, type Response } from "express";

const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_U64 = (1n << 64n) - 1n;
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
const HEX_256_BYTES = /^0x[0-9a-fA-F]{512}$/;

export type ClaimRequest = {
  proof: string | number[];
  nullifier: string;
  recipient: string;
  campaign: string | number;
};

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
    errors.push("proof must be 256 bytes or a 0x-prefixed 256-byte hex string");
  }

  if (typeof body.nullifier !== "string" || !HEX_32_BYTES.test(body.nullifier)) {
    errors.push("nullifier must be a 0x-prefixed 32-byte hex string");
  } else if (BigInt(body.nullifier) >= FIELD_MODULUS) {
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
    const campaign = BigInt(body.campaign as string | number);
    if (campaign < 0n || campaign > MAX_U64) {
      errors.push("campaign must fit in an unsigned 64-bit integer");
    }
  } catch {
    errors.push("campaign must be an unsigned integer");
  }

  return errors;
}

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ ok: true, mode: "mock" });
  });

  app.post("/claim", (request: Request, response: Response) => {
    const errors = validateClaimRequest(request.body);
    if (errors.length > 0) {
      response.status(400).json({ error: "invalid claim request", details: errors });
      return;
    }

    response.json({ signature: `mock-${randomUUID()}` });
  });

  return app;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  const port = Number(process.env.PORT ?? 8787);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`zkClaim relayer mock listening on http://127.0.0.1:${port}`);
  });
}
