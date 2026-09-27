import assert from "node:assert/strict";

import { validateClaimRequest } from "./index.ts";

const validRequest = {
  proof: Array(256).fill(0),
  nullifier: `0x${"01".repeat(32)}`,
  recipient: "11111111111111111111111111111111",
  campaign: "1",
};

assert.deepEqual(validateClaimRequest(validRequest), []);
assert.deepEqual(validateClaimRequest({}), [
  "proof must be 256 bytes or a 0x-prefixed 256-byte hex string",
  "nullifier must be a 0x-prefixed 32-byte hex string",
  "recipient must be a Solana address",
  "campaign must be an unsigned integer",
]);
assert.ok(
  validateClaimRequest({ ...validRequest, recipient: "not-a-public-key" }).includes(
    "recipient must be a valid Solana address",
  ),
);
assert.ok(
  validateClaimRequest({ ...validRequest, proof: [256] }).some((error) =>
    error.startsWith("proof must be"),
  ),
);

console.log("Relayer validation tests passed");
