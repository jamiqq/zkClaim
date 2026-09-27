# zkClaim — Specification

Private claims for any eligibility list, on Solana.

Status: hackathon spec, v1.3 (2026-09-27), matches the deployed program. Stack: circom + snarkjs + `groth16-solana` (Light Protocol verifier) + Anchor. Target: live devnet demo, judging evening of 2026-09-27.

---

## 1. Summary

zkClaim lets people on an eligibility list claim a fixed amount of tokens to a fresh wallet that nobody can link back to the wallet that qualified. The claim is a zero-knowledge proof of "I registered from an eligible wallet and have not claimed yet" that does not reveal which registration is the claimer's.

**Pitch.** A privacy layer for paying a known group of people on Solana. The issuer knows who should be paid; the payment can't be traced to any one of them. Not a mixer: fixed amounts, a known list, one claim per person, a capped total.

**One-liner for judges.** The a16z / 0xPARC private-airdrop design, cheap enough to verify on Solana, with the StealthDrop double-claim bug fixed.

**Problem.** Payouts on Solana are public. The receiving wallet reveals who got paid and usually ties back to their trading history, holdings or real identity. Recipients who need privacy either skip the payout or expose themselves.

**What the primitive does.** Pay (or hand out a token to) everyone on a known list: once each, in a fixed amount, to a wallet nobody can link back to them. The list and the registrations are public; the payout is not.

**Use cases (all run on the current program):**

| Category | Examples | Why privacy matters |
|---|---|---|
| Rewards and grants (lead) | Retro rewards to contributors, equal grants to a cohort, hackathon participant rewards | Rewards can be sold or used without being traced to the contributor's main wallet |
| Aid and compensation | Stablecoin humanitarian aid to verified recipients; compensation to exploit victims; payments to research participants | Recipients' spending wallets stay unlinked from identities that are known or already public |
| Anonymous credentials | 1 governance token per member for anonymous DAO voting; access passes for private chats or events; one "voice" token per member for honest surveys | Holding the token proves membership without saying which member |
| Recurring stipends | Equal monthly stipends to contributors, one campaign per period | Income stays unlinked from the main wallet over time |

**Who it doesn't fit.** Cases where being on the list is itself the sensitive fact (whistleblowers, some medical studies), or payouts of different sizes per person (each size needs its own campaign, which shrinks the anonymity set). Bug bounties: payouts are tiered and bounty programs usually require KYC anyway; a variant with off-chain commitments is on the roadmap.

---

## 2. Protocol flow

1. **Create campaign.** The admin creates a campaign with a fixed claim amount, a token mint and a program-owned vault, then funds the vault.
2. **Allowlist.** The admin creates one `eligible` account per eligible wallet (batched, about 10 per transaction).
3. **Register.** Eligible wallet A generates a random `secret` on the device and computes `commitment = Poseidon(secret)`. A calls `register(commitment)`, signed by A (`user`, needs no SOL) and a `payer` (A itself in the web app, or a sponsor). The program:
   - checks A signed the transaction,
   - closes A's `Eligible` account (rent goes to the payer) and creates a permanent `Registration` marker, so each wallet registers once even if the admin allowlists it again,
   - **inserts the commitment into the on-chain Merkle tree itself** (Poseidon syscall). The root is computed by the program, never supplied by the admin.
4. **Freeze.** The admin calls `freeze_campaign`. The program locks the root it computed. Registration closes and claims open. No commitment can be added after this point.
5. **Wait.** Users should not claim immediately after the freeze (see section 7).
6. **Claim.** On their own device, the user builds a proof for recipient wallet B. The relayer submits `claim(proof, nullifier)` and pays the fee. The program:
   - builds the public inputs **itself** from on-chain state (frozen root, `campaign_id`, B's address) plus the submitted nullifier,
   - verifies the Groth16 proof,
   - creates the `nullifier` account (this fails if it already exists, so a double claim fails),
   - transfers the fixed amount from the vault to B's token account.
7. **Relay.** The relayer is the fee payer, creates B's associated token account and pays the nullifier record's rent, so B never needs SOL from A. Anyone can submit a claim; the relayer has no special rights in the program.

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
| `pathElements[8]` | private | Merkle siblings |
| `pathIndices[8]` | private | Left/right bits (0/1) |

**Why the recipient is split:** a Solana address is 256 bits and a BN254 field element holds only about 254 bits. A single field element would either be rejected or silently reduced mod p.

### 3.2 Constraints

```
leaf        = Poseidon(secret)
computed    = MerkleRoot(leaf, pathElements, pathIndices)   // depth 8, Poseidon(left, right)
assert computed == root
assert nullifier == Poseidon(secret, campaign_id)
assert pathIndices[i] * (1 - pathIndices[i]) == 0           // each bit is boolean
assert recipient_hi < 2^128 ; assert recipient_lo < 2^128     // range checks
// Binding: keeps the optimizer from dropping unused public inputs (Tornado Cash pattern)
recipient_sq = (recipient_hi + recipient_lo) * (recipient_hi + recipient_lo)
```

- Tree depth: **8** (up to 256 registrations).
- Empty leaves use a precomputed zero chain: `zero[0] = 0`, `zero[i+1] = Poseidon(zero[i], zero[i])`. It must be identical in the circuit, the program and the TypeScript code.
- Hash: **Poseidon over BN254, circomlib parameters (x^5 S-box)**, via circomlib's `Poseidon(1)` and `Poseidon(2)` templates.
- Path convention: `pathIndices[i] = 0` means the current node is the left child; bits are taken LSB-first from the leaf index.
- Public signals are declared in the template in the order of the table above, because snarkjs orders public inputs by declaration.
- Implementation: `circuits/zkclaim.circom` (circom 2.2), built by `circuits/scripts/build.sh`.

### 3.3 Hash parity (the top integration risk)

The same Poseidon has to produce identical outputs in three places: the circom circuit (circomlib), the on-chain Poseidon syscall (`Parameters::Bn254X5`, big-endian), and the TypeScript tree builder (`circomlibjs`). circomlib and the Solana syscall use the same parameters, so parity is expected, but it must be tested. **Hour-1 task:** compute `Poseidon(1)`, `Poseidon(1,2)` and `zero[8]` in all three and compare them byte for byte (`shared/test-vectors.json`).

### 3.4 Trusted setup

- Powers of Tau: `2^12` (the circuit is about 2.5k constraints), generated locally with `snarkjs powersoftau`.
- Phase 2: `snarkjs groth16 setup` + one `zkey contribute`.
- Both phases are single-party, so the setup is **demo-only**. Production needs a multi-party ceremony (see roadmap).
- Outputs: `zkclaim.wasm` and `zkclaim_final.zkey` (served by the web app for in-browser proving) and `verification_key.json` (converted to `programs/zkclaim/src/verifying_key.rs`).

---

## 4. On-chain program (Anchor)

### 4.1 Accounts

| Account | Seeds | Fields |
|---|---|---|
| `Campaign` | `["campaign", campaign_id]` | `admin`, `campaign_id: u64`, `mint`, `vault`, `amount: u64`, `state: {Registering, Frozen}`, `root: [u8;32]`, `bump` |
| `Tree` (zero-copy) | `["tree", campaign]` | `next_index: u32`, `filled_subtrees: [[u8;32];8]`, `current_root: [u8;32]`, `leaves: [[u8;32];256]` |
| `Eligible` | `["eligible", campaign, wallet]` | empty marker (closed on registration) |
| `Registration` | `["registration", campaign, wallet]` | permanent marker: this wallet registered |
| `Nullifier` | `["nullifier", campaign, nullifier_bytes]` | empty marker |
| Vault | associated token account owned by the `Campaign` account | token balance |

Notes:
- `Tree` is about 8.6 KB. That is under the 10,240-byte limit for creating an account from a program. Use `#[account(zero_copy)]` / `AccountLoader`, because Borsh-deserializing an 8 KB array blows the stack.
- The leaves are stored on-chain so any client can rebuild the tree and generate a proof by reading one account. No indexer is needed.

### 4.2 Instructions

**`create_campaign(campaign_id, amount)`** — admin signs
- Initializes the `Campaign` and the `Tree` (the root of the empty tree is `zero[8]`) and creates the vault account.

**`add_eligible(wallets: Vec<Pubkey>)`** — admin signs (`has_one = admin`); requires `state == Registering`
- Creates one `Eligible` account per wallet; the addresses are passed in as remaining accounts.

**`register(commitment: [u8;32])`** — `user` (wallet A) and `payer` sign; requires `state == Registering`
- `user` needs no SOL; `payer` pays rent for `Registration` and receives `Eligible`'s rent. Web users pass themselves as both; seed scripts pass a sponsor.
- Closes `Eligible[campaign, A]`. If the account is missing, A is either not eligible or already registered.
- Creates `Registration[campaign, A]` with `init`, so a second registration fails even if the admin re-adds A.
- Requires `commitment < BN254 modulus` and `commitment != 0`.
- Requires `next_index < 256`.
- Does an incremental Merkle insert (Tornado-style `filled_subtrees`): 8 Poseidon syscalls, which should cost only a few thousand compute units (CU; to be measured).
- Stores the leaf, updates `current_root`, increments `next_index`, and emits `Registered { index, commitment }`.

**`freeze_campaign()`** — admin signs (`has_one = admin`); requires `state == Registering`
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

`claim` verifies the proof in-program with the **`groth16-solana`** crate (Light Protocol; audited, used in production by ZK Compression), which uses Solana's `alt_bn128` syscalls.

- Verifying key: a Rust constant in `verifying_key.rs`, generated from snarkjs's `verification_key.json` with the conversion script from the `groth16-solana` repo.
- Proof layout (256 bytes, big-endian): `proof_a` (64, **negated**) ‖ `proof_b` (128) ‖ `proof_c` (64). snarkjs outputs a different encoding; the client converts it before sending. A proof that passes `snarkjs groth16 verify` but fails on-chain almost always means the negation or byte order is wrong.
- Why not Noir: Noir's default UltraHonk backend has no Solana verifier, and the Noir → Groth16 path (Sunspot) is unaudited and proves outside the browser. circom + `groth16-solana` gives in-browser proving and an audited verifier.

**Compute budget:** request 400k CU on `claim` with `SetComputeUnitLimit`. Measured: the whole claim uses ~149k CU (LiteSVM).

**Cost per claim:** the transaction fee is a fraction of a cent; the real cost is rent, about 0.003 SOL per claim (recipient token account ~0.002 SOL, nullifier record ~0.001 SOL, never closed). The relayer fronts both.

**Transaction size:** measured 814 bytes (compute budget + idempotent ATA + claim), under the 1,232-byte limit.

### 4.4 Errors

`NotRegistering`, `NotFrozen`, `TreeFull`, `InvalidCommitment`, `InvalidNullifier`, `ProofInvalid`, `Unauthorized`. A double claim or double registration surfaces as Anchor's "account already in use" error, or as a missing `Eligible` account.

---

## 5. Off-chain components

### 5.1 Tree / witness builder (TypeScript)
- Reads the `Tree` account, rebuilds the full tree from `leaves[0..next_index]`, and checks the result against the on-chain `current_root` / `campaign.root`.
- Given the user's commitment, returns its `index`, `pathElements` and `pathIndices`.

### 5.2 Prover (in the browser)
- `snarkjs.groth16.fullProve(input, "/zk/zkclaim.wasm", "/zk/zkclaim_final.zkey")` runs in the user's browser. **The secret never leaves the device.**
- The client then converts the proof to the 256-byte layout from section 4.3.
- If snarkjs fails to bundle under Vite, load `snarkjs.min.js` from `web/public/` with a `<script>` tag.

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
| 2 | Vault drain via fake registrations | Registration requires A's signature, consumes A's `Eligible` account and creates a permanent `Registration` marker, so each allowlisted wallet registers once; only the admin can allowlist (`has_one = admin`) |
| 3 | Admin diluting the anonymity set with sock-puppet registrations | The admin cannot insert commitments directly: **the root is computed on-chain** by `register`, and `freeze` locks the program's own root. The admin *can* allowlist wallets it controls; this mostly returns its own funds, but it shrinks the true anonymity set. Mitigation: publish the allowlist and its source (e.g. contributor list) so anyone can audit it |
| 4 | Double claim | Per-campaign `Nullifier` account, created with `init` (fails if it exists) |
| 5 | Cross-campaign replay | `campaign_id` is a public input, part of the nullifier hash, and part of the `Nullifier` account address |
| 6 | Field overflow / aliasing | Recipient split into two 128-bit limbs with range checks; `commitment` and `nullifier` checked `< modulus` on-chain |
| 7 | Stale-root proofs | The root is frozen before claims open; there is no root history to manage |
| 8 | Signature-based nullifier forgery (the StealthDrop bug) | Nullifiers come from a secret commitment, not from signatures. ECDSA and Ed25519 signatures aren't unique per key/message pair |

**Trust assumptions that remain (state them):**
- Two parties have power, and neither can see who claimed: the issuer decides who is on the list, and whoever ran the trusted setup could forge proofs.
- The relayer can refuse to submit (then submit yourself or use another relayer) but cannot steal or redirect: the recipient is a public input of the proof. It does see the requester's IP and the fresh wallet, not which registration is theirs.
- The admin chooses the allowlist and holds the vault until it is funded. An admin that allowlists its own wallets weakens privacy for everyone else (row 3).
- The Groth16 trusted setup (Powers of Tau and phase 2) was done by one party; whoever ran it could forge proofs. Production needs a multi-party ceremony.
- The program and circuit are unaudited hackathon code. The verifier library (`groth16-solana`) is audited.

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
7. **Limitations + roadmap (10s):** a proper trusted-setup ceremony, blocklist exclusion proofs, tiered campaigns, off-chain commitments for bug bounties.

---

## 10. Build plan (~19.5h, 4 people)

The detailed schedule, handoffs and gates live in the team's implementation plan doc. Summary (Warsaw time, judging assumed Sun 19:00):

| Time | Phase | Checkpoint |
|---|---|---|
| Sat 23:30–Sun 00:30 | Setup: toolchains, repo, `shared/constants.ts` | Empty program deployed to devnet; circom compiles |
| 00:30–04:00 | Build in isolation: circuit (P1), program (P2), TS infra (P3), UI (P4) | 02:00: snarkjs proof verifies in a Rust unit test with `groth16-solana` |
| 04:00–09:00 | Sleep | |
| 09:00–13:00 | Integrate | 13:00: one full claim from the browser on devnet |
| 13:00–19:00 | Attack tests, seed 30 wallets, code freeze 15:30, rehearsals | All "definition of done" items checked on devnet |

**Riskiest dependencies (in order):**
1. Proof encoding for `groth16-solana` (negated `proof_a`, big-endian).
2. Poseidon parity across circomlib, the syscall and `circomlibjs`.
3. Claim transaction size or compute units.

Fallbacks:
1. Copy the conversion from the `groth16-solana` tests; last resort for the demo is off-chain verification by the relayer, stated openly.
2. Compare hashes step by step against `shared/test-vectors.json`.
3. Split the claim so the verifier call is a separate instruction checked through the instructions sysvar.

---

## 11. Roadmap (after the hackathon)

- A proper multi-party trusted-setup ceremony; audit.
- **Bug-bounty variant:** the issuer distributes commitments off-chain (the a16z model), so the researcher's wallet never goes on-chain and is never visible as eligible.
- Blocklist exclusion proof on the recipient (sparse Merkle tree non-membership).
- Merkle-root allowlist instead of per-wallet accounts (scales past 256).
- Tiered campaigns; deeper trees; optional relayer fee bound into the proof.
- SDK for grant and reward platforms (possible integration: Torque).

## 12. References

- groth16-solana (Light Protocol): https://github.com/Lightprotocol/groth16-solana
- circom: https://docs.circom.io
- snarkjs: https://github.com/iden3/snarkjs
- circomlib: https://github.com/iden3/circomlib
- a16z, Privacy-Protecting Crypto Airdrops with Zero Knowledge Proofs (Mar 2022)
- StealthDrop: https://github.com/stealthdrop/stealthdrop
- PLUME nullifiers: https://blog.aayushg.com/nullifier/
- 0xPARC zk-bug-tracker: https://github.com/0xPARC/zk-bug-tracker
- Solana Privacy Hack: https://solana.com/privacyhack
