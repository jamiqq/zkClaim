import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import type { Server } from "node:http";

import {
  createApp,
  type NormalizedClaim,
  validateClaimRequest,
} from "./index.ts";

const validRequest = {
  proof: Array(256).fill(0),
  nullifier: `0x${"01".repeat(32)}`,
  recipient: "11111111111111111111111111111111",
  campaign: "2026092701",
};

assert.deepEqual(validateClaimRequest(validRequest), []);
assert.deepEqual(validateClaimRequest({
  ...validRequest,
  proof: "00".repeat(256),
  nullifier: "01".repeat(32),
}), []);
assert.ok(validateClaimRequest({ ...validRequest, campaign: Number.MAX_SAFE_INTEGER + 1 })
  .includes("campaign must be a safe integer or decimal string"));
assert.ok(validateClaimRequest({ ...validRequest, recipient: "not-a-public-key" })
  .includes("recipient must be a valid Solana address"));
assert.ok(validateClaimRequest({ ...validRequest, proof: [256] })
  .some((error) => error.startsWith("proof must be")));

async function main(): Promise<void> {
  let submitted: NormalizedClaim | undefined;
  const app = createApp({
    submitClaim: async (claim) => {
      submitted = claim;
      return "test-signature";
    },
  });

  let server: Server | undefined;
  try {
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server?.once("listening", resolve);
      server?.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { ok: true, mode: "live" });

    const invalid = await fetch(`${base}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(invalid.status, 400);

    const claim = await fetch(`${base}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRequest),
    });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), {
      signature: "test-signature",
      explorerUrl: "https://explorer.solana.com/tx/test-signature?cluster=devnet",
    });
    assert.equal(submitted?.proof.length, 256);
    assert.equal(submitted?.nullifier.length, 32);
    assert.equal(submitted?.recipient.toBase58(), validRequest.recipient);
    assert.equal(submitted?.campaignId, 2026092701n);

    const options = await fetch(`${base}/claim`, { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "http://localhost:5173");
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
  }

  console.log("Relayer HTTP tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
