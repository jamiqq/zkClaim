// Deployed program (devnet). Only the upgrade authority (P2) deploys; the address never changes.
// Consumers wrap it themselves: new PublicKey(PROGRAM_ID)
export const PROGRAM_ID = "EHsj9Fz1QuPB9drLUF9SPk63y23pXcSXzfr65MjD3nT3";
export const CLUSTER_URL = "https://api.devnet.solana.com";

// BN254 scalar field modulus
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Merkle tree
export const TREE_DEPTH = 8; // 256 leaves
// zero[0] = 0, zero[i+1] = Poseidon(zero[i], zero[i])  (circomlib Poseidon)
// pathIndices[i] = 0 -> current node is the LEFT child; bits LSB-first from leaf index

// Hashes (circomlib Poseidon, BN254 x^5)
// leaf      = Poseidon(secret)
// nullifier = Poseidon(secret, campaign_id)

// Public input order (must match circuit declaration order)
export const PUBLIC_INPUTS = [
  "root",
  "nullifier",
  "recipient_hi",
  "recipient_lo",
  "campaign_id",
] as const;
// recipient_hi = bytes 0..16 of recipient pubkey, recipient_lo = bytes 16..32, both big-endian

// PDA seeds
export const SEED_CAMPAIGN = "campaign"; // ["campaign", campaign_id as u64 LE]
export const SEED_TREE = "tree"; // ["tree", campaign]
export const SEED_ELIGIBLE = "eligible"; // ["eligible", campaign, wallet]
export const SEED_NULLIFIER = "nullifier"; // ["nullifier", campaign, nullifier 32 bytes BE]

// Proof on-chain: 256 bytes = proof_a (64, NEGATED) || proof_b (128) || proof_c (64), big-endian
export const PROOF_BYTES = 256;

// Browser proving assets (served from web/public/zk)
export const ZK_WASM = "/zk/zkclaim.wasm";
export const ZK_ZKEY = "/zk/zkclaim_final.zkey";
