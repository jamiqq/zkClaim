# zkClaim — Specification

Private claims for any eligibility list, on Solana.

Status: hackathon spec, v1.1 (2026-09-26). Target: live devnet demo, judging evening of 2026-09-27.

---

## 1. Summary

zkClaim lets people on an eligibility list claim a fixed amount of tokens to a fresh wallet that nobody can link back to the wallet that qualified. The claim is a zero-knowledge proof of "I registered from an eligible wallet and have not claimed yet" that does not reveal which registration is the claimer's.

**Pitch.** Private claims for any eligibility list. Not a mixer: fixed amounts, a known list, one claim per person, a capped total, and optional blocklist checks.

**One-liner for judges.** The a16z / 0xPARC private-airdrop design, cheap enough to verify on Solana, with the StealthDrop double-claim bug fixed.

**Problem.** Claims on Solana are public. The receiving wallet reveals which eligible person claimed and usually ties back to their trading history, holdings or real identity. Recipients who need privacy either skip the claim or expose themselves.

**Target users.** Issuers rewarding wallets that are *already public*, where the risk is linking the reward back to them:
- Retroactive rewards to on-chain contributors. **This is the lead use case for the demo.**
- Equal-size grants to a cohort, such as hackathon participants or a DAO's contributor list.
- Later (roadmap): bug-bounty payouts, in a variant where the issuer distributes commitments off-chain so the researcher's wallet never appears on-chain.
- Airdrop issuers are a weaker fit: they often *want* linkable claims for sybil analysis.

**Hook.** Rewarded tokens can be sold or used to vote without being traced back to the contributor's main wallet.

**Why not bug bounties or whistleblowers first.** Registering puts the eligible wallet on a public allowlist, which is worse than today's practice of privately handing the issuer a fresh address. Bounty payouts are tiered by severity (anonymity sets of 1–3), and most bounty programs require KYC anyway. Whistleblowers aren't on a pre-drawn list, and being on one is itself the sensitive fact.

---

## 2. Protocol flow

1. **Create campaign.** The admin creates a campaign with a fixed claim amount, a token mint and a program-owned vault, then funds the vault.
2. **Allowlist.** The admin creates one `eligible` account per eligible wallet (batched, about 10 per transaction).
3. **Register.** Eligible wallet A generates a random `secret` on the device and computes `commitment = Poseidon(secret)`. A calls `register(commitment)`. The program:
   - checks A signed the transaction,
   - consumes A's `eligible` account (closes it), so each wallet registers once,
   - **inserts the commitment into the on-chain Merkle tree itself** (Poseidon syscall). The root is computed by the program, never supplied by the admin.
4. **Freeze.** The admin calls `freeze`. The program locks the root it computed. Registration closes and claims open. No commitment can be added after this point.
5. **Wait.** Users should not claim immediately after the freeze (see section 7).
6. **Claim.** On their own device, the user builds a proof for recipient wallet B. The relayer submits `claim(proof, nullifier)` and pays the fee. The program:
   - builds the public inputs **itself** from on-chain state (frozen root, `campaign_id`, B's address) plus the submitted nullifier,
   - verifies the Groth16 proof,
   - creates the `nullifier` account (this fails if it already exists, so a double claim fails),
   - transfers the fixed amount from the vault to B's token account.
7. **Relay.** The relayer is the fee payer and creates B's associated token account (paying the rent), so B never needs SOL from A.

A second claim with the same secret produces the same nullifier, and the transaction fails.

---

## 3. Circuit

### 3.1 Inputs

| Name | Visibility | Meaning |
|---|---|---|
| `root` | public | Frozen Merkle root of all commitments |
| `nullifier` | public | `Poseidon(secret, campaign_id)` |
| `recipient_hi` | public | First 16 bytes of B's address, as a big-endian integer |
| `recipient_lo` | public | Last 16 bytes of B's address, as a big-endian integer |
| `campaign_id` | public | Campaign's u64 id |
| `secret` | private | Random field element generated on the device |
| `path_elements[8]` | private | Merkle siblings |
| `path_indices[8]` | private | Left/right bits (0/1) |

**Why the recipient is split:** a Solana address is 256 bits and a BN254 field element holds only about 254 bits. A single field element would either be rejected or silently reduced mod p.

### 3.2 Constraints

```
leaf        = Poseidon(secret)
computed    = MerkleRoot(leaf, path_elements, path_indices)   // depth 8, Poseidon(left, right)
assert computed == root
assert nullifier == Poseidon(secret, campaign_id)
assert path_indices[i] * (1 - path_indices[i]) == 0           // each bit is boolean
assert recipient_hi < 2^128 ; assert recipient_lo < 2^128     // range checks
// Binding: keeps the optimizer from dropping unused public inputs (Tornado Cash pattern)
recipient_sq = (recipient_hi + recipient_lo) * (recipient_hi + recipient_lo)
```

- Tree depth: **8** (up to 256 registrations).
- Empty leaves use a precomputed zero chain: `zero[0] = 0`, `zero[i+1] = Poseidon(zero[i], zero[i])`. It must be identical in the circuit, the program and the TypeScript code.
- Hash: **Poseidon over BN254, circomlib-compatible parameters (x^5 S-box)**. In Noir, use the `poseidon` library's `bn254::hash_1` and `hash_2`. **Do not use Poseidon2**: it is a black-box function, and Sunspot's gnark backend may not support it.

### 3.3 Hash parity (the top integration risk)

The same Poseidon has to produce identical outputs in four places: the Noir circuit, the on-chain `solana-poseidon` syscall (`Parameters::Bn254X5`, big-endian), the TypeScript tree builder (`circomlibjs` or `light-poseidon` WASM), and the prover's witness. **Hour-1 task:** compute `Poseidon(1)`, `Poseidon(1,2)` and `zero[8]` in all four and compare them byte for byte.

---

## 4. On-chain program (Anchor)

### 4.1 Accounts

| Account | Seeds | Fields |
|---|---|---|
| `Campaign` | `["campaign", campaign_id]` | `admin`, `campaign_id: u64`, `mint`, `vault`, `amount: u64`, `state: {Registering, Frozen}`, `root: [u8;32]`, `bump` |
| `Tree` (zero-copy) | `["tree", campaign]` | `next_index: u32`, `filled_subtrees: [[u8;32];8]`, `current_root: [u8;32]`, `leaves: [[u8;32];256]` |
| `Eligible` | `["eligible", campaign, wallet]` | empty marker (closed on registration) |
| `Nullifier` | `["nullifier", campaign, nullifier_bytes]` | empty marker |
| Vault | associated token account owned by the `Campaign` account | token balance |

Notes:
- `Tree` is about 8.6 KB. That is under the 10,240-byte limit for creating an account from a program. Use `#[account(zero_copy)]` / `AccountLoader`, because Borsh-deserializing an 8 KB array blows the stack.
- The leaves are stored on-chain so any client can rebuild the tree and generate a proof by reading one account. No indexer is needed.

### 4.2 Instructions

**`create_campaign(campaign_id, amount)`** — admin signs
- Initializes the `Campaign` and the `Tree` (the root of the empty tree is `zero[8]`) and creates the vault account.

**`add_eligible(wallets: Vec<Pubkey>)`** — admin signs; requires `state == Registering`
- Creates one `Eligible` account per wallet; the addresses are passed in as remaining accounts.

**`register(commitment: [u8;32])`** — wallet A signs; requires `state == Registering`
- Closes `Eligible[campaign, A]` and refunds the rent to the admin. If the account is missing, A is either not eligible or already registered.
- Requires `commitment < BN254 modulus` and `commitment != 0`.
- Requires `next_index < 256`.
- Does an incremental Merkle insert (Tornado-style `filled_subtrees`): 8 Poseidon syscalls, which should cost only a few thousand compute units (CU; to be measured).
- Stores the leaf, updates `current_root`, increments `next_index`, and emits `Registered { index, commitment }`.

**`freeze()`** — admin signs; requires `state == Registering`
- Sets `campaign.root = tree.current_root` and `state = Frozen`.
- The admin cannot pass in a root, so there is no way to fake one.

**`claim(proof: [u8;256], nullifier: [u8;32])`** — the relayer signs as fee payer; B does **not** sign; requires `state == Frozen`
- Requires `nullifier < modulus`.
- Builds the public inputs on-chain, in circuit order:
  `[campaign.root, nullifier, be32(B[0..16]), be32(B[16..32]), be32(campaign_id)]`
- Verifies the Groth16 proof (see 4.3).
- `init` of `Nullifier[campaign, nullifier]`, paid by the relayer. The instruction fails if the account already exists.
- Transfers `amount` from the vault to B's associated token account, signed by the `Campaign` account's seeds.
- Emits `Claimed { nullifier }`, with no link to any leaf.

The client supplies only the nullifier and the proof. The root, recipient and campaign are taken from accounts the program already checks, so a proof can't be reused against a different root, recipient or campaign.

### 4.3 Verifier

| Path | How it is called | Notes |
|---|---|---|
| **A. Noir + Sunspot (primary)** | `claim` calls Sunspot's generated verifier program, with instruction data = proof ‖ public witness in Sunspot's expected layout | Reuses Noir skills. Unaudited, and its `setup` is marked unsafe (acceptable for a demo; say so). Copy the public-witness layout from `solana-foundation/noir-examples` clients. |
| **B. circom + snarkjs (fallback)** | `groth16-solana` crate, verified inside `claim` | Audited (v0.0.1, Light Protocol), under ~200k CU for small circuits, in-browser proving. |

**Compute budget:** request 400k–600k CU on `claim` with `SetComputeUnitLimit`. Verification costs about 170k–500k CU, depending on the circuit and the number of public inputs.

**Transaction size:** 256-byte proof + 32-byte nullifier + about 10 accounts + compute-budget instruction ≈ 700–800 bytes, under the 1,232-byte limit. **Measure it early.**

### 4.4 Errors

`NotRegistering`, `NotFrozen`, `TreeFull`, `InvalidCommitment`, `InvalidNullifier`, `ProofInvalid`, `Unauthorized`. A double claim or double registration surfaces as Anchor's "account already in use" error, or as a missing `Eligible` account.

---

## 5. Off-chain components

### 5.1 Tree / witness builder (TypeScript)
- Reads the `Tree` account, rebuilds the full tree from `leaves[0..next_index]`, and checks the result against the on-chain `current_root` / `campaign.root`.
- Given the user's commitment, returns its `index`, `path_elements` and `path_indices`.

### 5.2 Prover
- **Path A:** the Sunspot Go CLI (`prove`) runs **on the user's machine** behind a localhost helper (`localhost:PORT/prove`). The secret never leaves the device. Present it as "desktop prover today, browser prover on the roadmap."
- **Path B:** snarkjs `groth16.fullProve` in the browser, using the WASM file and the proving key.

### 5.3 Secret handling
- Generated with `crypto.getRandomValues` and reduced mod p.
- Saved locally (download a `.zkclaim` JSON backup plus a localStorage copy). **If it's lost, the claim can't be made.** Say so in the UI.

### 5.4 Relayer (Node/TypeScript)
- `POST /claim { proof, nullifier, recipient, campaign }`
- Builds the transaction: compute-budget instruction, idempotent creation of B's associated token account, then `claim`. Signs as fee payer and submits.
- Sponsored (no relayer fee in v1). If a fee is added later, it **must** become a public input to the proof.
- Rate limit per IP. Logs contain no IPs or secrets.

### 5.5 Web UI (React)
- **Admin:** create campaign, add eligible wallets, fund the vault, freeze.
- **Register:** connect wallet A, generate the secret, back it up, sign `register`.
- **Claim:** load the backup, enter recipient B (fresh address), prove, send to the relayer, show the transaction.
- **Explorer view:** list of registrations (wallets and commitments) and list of claims (nullifiers and recipients), showing that nothing links the two.

---

## 6. Security design

| # | Attack | Defence |
|---|---|---|
| 1 | Front-running: the relayer or an observer copies a proof and swaps in their own recipient | The recipient is a public input, constrained in the circuit, and the **program derives it from B's account**, so a changed recipient makes the proof fail |
| 2 | Vault drain via fake registrations | Registration requires A's signature and consumes A's `Eligible` account, so each allowlisted wallet registers once |
| 3 | Admin diluting the anonymity set with sock-puppet registrations | The admin cannot insert commitments directly: **the root is computed on-chain** by `register`, and `freeze` locks the program's own root. The admin *can* allowlist wallets it controls; this mostly returns its own funds, but it shrinks the true anonymity set. Mitigation: publish the allowlist and its source (e.g. contributor list) so anyone can audit it |
| 4 | Double claim | Per-campaign `Nullifier` account, created with `init` (fails if it exists) |
| 5 | Cross-campaign replay | `campaign_id` is a public input, part of the nullifier hash, and part of the `Nullifier` account address |
| 6 | Field overflow / aliasing | Recipient split into two 128-bit limbs with range checks; `commitment` and `nullifier` checked `< modulus` on-chain |
| 7 | Stale-root proofs | The root is frozen before claims open; there is no root history to manage |
| 8 | Signature-based nullifier forgery (the StealthDrop bug) | Nullifiers come from a secret commitment, not from signatures. ECDSA and Ed25519 signatures aren't unique per key/message pair |

**Trust assumptions that remain (state them):**
- The admin chooses the allowlist and holds the vault until it is funded. An admin that allowlists its own wallets weakens privacy for everyone else (row 3).
- Sunspot's trusted setup was done by one party and is marked unsafe; production needs a proper ceremony.
- Sunspot is unaudited (on path B, groth16-solana v0.0.1 is audited).

---

## 7. Privacy limitations (stated in the demo)

- **Anonymity set = registered users, not the whole list.** Registrations are public, so observers know the set. The demo seeds **30 or more** registrations.
- **Registration is public.** Wallet A appears on the allowlist and calls `register`, so everyone learns A is eligible. That is why zkClaim targets wallets that are already public (contributors, cohorts), not recipients who must hide that they are eligible at all.
- **Timing.** The freeze already separates registering from claiming, which removes the obvious "register then claim a minute later" link. Claim order and time of day can still leak; users should wait a random delay after the freeze.
- **Amounts.** One fixed amount per campaign. Tiers would need a separate campaign/tree each.
- **Funding the fresh wallet.** Handled by the relayer. Without it, privacy is lost.
- **Funding clusters.** If registering wallets were all funded from one source, an observer can group them. The demo seed wallets are funded separately (see section 9).
- **Network metadata.** The relayer sees the requester's IP. Recommend Tor/VPN; the relayer keeps no logs.
- **Lost secret = lost claim.**

Research on Railgun users on Ethereum ("A Tattered Cloak of Invisibility", arXiv) found anonymity is lost mainly through timing and amounts, which is why both are handled explicitly.

---

## 8. Competitive landscape

As far as we can find in past Colosseum hackathons (Hyperdrive through Cypherpunk, searched with Colosseum Copilot), no project does unlinkable claims:

| Project | Hackathon / status | What it does | Difference |
|---|---|---|---|
| dropsy | Cypherpunk, Sep 2025 | Transparent airdrops | No privacy |
| fairdrop | Renaissance, Mar 2024 | Anti-sybil airdrops | No privacy |
| zk-cpop-interface | Breakout, Apr 2025 | Private event attendance with Merkle proofs | No token claims |
| privatevote-dao | Cypherpunk, Sep 2025 | Same commitment/nullifier pattern, for voting | Voting, not claims |
| solana-mixer, pivy-v2 | Breakout / Cypherpunk | General private transfers | Arbitrary amounts; mixer optics |
| Privacy Cash | Live on mainnet since mid-2025 | Groth16 privacy pool with relayer and address screening | General-purpose pool; used *after* a public claim |
| Hinkal | Live on Solana | Private transfers | General-purpose privacy, no eligibility |

**Expected judge question: "Why not claim publicly, then run it through Privacy Cash?"**
Answer: a public claim already linked A to the reward, and mixing afterwards is too late. zkClaim never creates that link, the issuer keeps a known list and a capped total, and the recipient never touches a general-purpose pool.

- Privacy winners so far were in payments and trading: `cloak-or-solana-privacy-layer` (accelerator C4), `blackpool` (C2), `bagel`. zkClaim applies that winning vertical to a use case none of them cover.
- Reward-distribution builders exist (e.g. gitrant for OSS funding; Torque for reward campaigns, accelerator C1), which shows issuer demand and a possible integration partner.
- **Known blind spot:** the **Solana Privacy Hack (Jan 2026)** is not in the Copilot corpus. It had a private-launchpad track and Anoncoin and Aztec/Noir bounties. **Check its project gallery before judging.**
- **Prior art outside Solana:**
  - a16z, "Privacy-Protecting Crypto Airdrops with Zero Knowledge Proofs" (Sam Ragsdale, Mar 2022) describes nearly this flow and notes that verification cost on Ethereum limited adoption. Solana's cheap Groth16 verification is the "why now, why Solana" answer.
  - StealthDrop (0xPARC, Ethereum) proved eligibility from a wallet signature and hit the double-claim bug that zkClaim's commitment design avoids (see also PLUME nullifiers). ZKDrop is Semaphore-based.

---

## 9. Demo script (3 minutes)

1. **Problem (20s):** show a public reward claim on the explorer, where the claiming wallet links straight to the contributor's main wallet and its whole history.
2. **Setup (20s):** a retroactive-reward campaign for 30 on-chain contributors (seeded by script, each wallet funded separately), all already registered. Show the registration list.
3. **Freeze (10s):** the root is computed on-chain; the admin never supplied it.
4. **Live claim (60s):** load the secret backup, generate a proof locally, the relayer submits it, and fresh wallet B receives the tokens. Show the devnet transaction.
5. **Attacks (40s):** replay the same proof (fails: nullifier exists); swap the recipient (fails: proof invalid).
6. **"Trace it" (20s):** ask a judge to guess which of the 30 registrations claimed.
7. **Limitations + roadmap (10s):** browser proving, a proper trusted-setup ceremony, blocklist exclusion proofs, tiered campaigns, off-chain commitments for bug bounties.

---

## 10. Build plan (~30h, 4 people)

**Kill switch:** if a proof from our own circuit is not verifying on devnet by **H6**, switch to path B (circom + snarkjs + groth16-solana).

| Hours | Person 1 (ZK) | Person 2 (Anchor) | Person 3 (TS infra) | Person 4 (UI) |
|---|---|---|---|---|
| 0–1.5 | **All:** install Solana CLI, Anchor, nargo (version pinned by noir-examples), Go 1.24+, Sunspot. Run the noir-examples `one` client against its devnet verifier. **Checkpoint: one devnet verification transaction.** | | | |
| 1.5–3 | Circuit v0 (membership + nullifier), `nargo execute` | Anchor basics; `create_campaign`, vault | Poseidon parity test vectors (section 3.3) | Wallet connect, page skeleton |
| 3–6 | Recipient limbs + binding; Sunspot compile/setup/prove/verify; deploy the verifier to devnet | `add_eligible`, `register` with on-chain Poseidon insert | Tree builder + witness generation, checked against on-chain root. **Start funding 30 seed wallets separately** (devnet faucet is rate-limited) | Register flow + secret backup |
| 6–12 | Localhost prover helper; public-witness layout | `freeze`, `claim` calling the verifier, nullifier account, transfer | Relayer: create B's token account + `claim` | Claim flow → relayer |
| 12–14 | **All:** first full end-to-end run on devnet | | | |
| 14–20 | Sleep in shifts | | | |
| 20–24 | Attack tests (replay, recipient swap) | Compute-unit and transaction-size tuning; error handling | Seed script: register the 30 separately funded wallets | Explorer view (registrations vs claims) |
| 24–28 | Bug fixes, freeze the code | | README + architecture diagram | Demo polish |
| 28–30 | **All:** rehearse the demo twice (including the Privacy Cash answer); record a backup video | | | |

**Riskiest dependencies (in order):**
1. Poseidon parity across Noir, the syscall and TypeScript.
2. Sunspot's handling of the custom circuit and its public-witness layout.
3. Claim transaction size or compute units.

Fallbacks:
1. Use circomlib Poseidon everywhere (path B).
2. Switch to path B.
3. Split the claim so the verifier call is a separate instruction checked through the instructions sysvar.

---

## 11. Roadmap (after the hackathon)

- In-browser proving for the Noir path (Barretenberg WASM → a Groth16-compatible backend) or move to circom permanently.
- A proper multi-party trusted-setup ceremony; audit.
- **Bug-bounty variant:** the issuer distributes commitments off-chain (the a16z model), so the researcher's wallet never goes on-chain and is never visible as eligible.
- Blocklist exclusion proof on the recipient (based on noir-examples `smt_exclusion`).
- Merkle-root allowlist instead of per-wallet accounts (scales past 256).
- Tiered campaigns; deeper trees; optional relayer fee bound into the proof.
- SDK for grant and reward platforms (possible integration: Torque).

## 12. References

- Sunspot (Noir → Groth16 → Solana): https://github.com/reilabs/sunspot
- Solana Noir examples: https://github.com/solana-foundation/noir-examples
- groth16-solana: https://github.com/Lightprotocol/groth16-solana
- Chainstack, Solana ZK proofs with Noir and Groth16: https://docs.chainstack.com/docs/solana-zk-proofs
- a16z, Privacy-Protecting Crypto Airdrops with Zero Knowledge Proofs (Mar 2022)
- StealthDrop: https://github.com/stealthdrop/stealthdrop
- PLUME nullifiers: https://blog.aayushg.com/nullifier/
- 0xPARC zk-bug-tracker: https://github.com/0xPARC/zk-bug-tracker
- Solana Privacy Hack: https://solana.com/privacyhack
