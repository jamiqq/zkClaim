// Contract between the UI (P4) and the TS infra (P3).
// Everything here is a MOCK for now; P3 replaces the bodies, the signatures stay.
import { type Connection, PublicKey } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import { PROGRAM_ID, RELAYER_URL, SEED_CAMPAIGN, SEED_NULLIFIER, SEED_TREE, TREE_DEPTH } from './config'
import { poseidon } from './lib/poseidon'
import { type MerklePath, toHex, zeroChain } from './lib/zk'
import { bigIntToBytes32, bytesToBigInt, toHex32 } from './lib/secret'

/** What talks to devnet for real. Everything else is still a mock. */
export const LIVE = {
  campaign: true, // getCampaign reads Campaign + Tree + vault
  tree: true, // getMerklePath rebuilds the on-chain tree
  claim: true, // submitClaim -> relayer
  register: false,
  admin: false,
  explorer: false,
}
/** @deprecated use LIVE.* */
export const MOCK = !LIVE.claim

// ---------- on-chain layout (programs/zkclaim/src/state.rs) ----------
const programId = new PublicKey(PROGRAM_ID)
const enc = (s: string) => new TextEncoder().encode(s)
function u64le(n: bigint) {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
export const campaignPda = (id: bigint) => PublicKey.findProgramAddressSync([enc(SEED_CAMPAIGN), u64le(id)], programId)[0]
export const treePda = (campaign: PublicKey) => PublicKey.findProgramAddressSync([enc(SEED_TREE), campaign.toBytes()], programId)[0]
export const nullifierPda = (campaign: PublicKey, nullifier: Uint8Array) =>
  PublicKey.findProgramAddressSync([enc(SEED_NULLIFIER), campaign.toBytes(), nullifier], programId)[0]

// Campaign (Borsh): disc 8 | admin 32 | campaign_id 8 | mint 32 | vault 32 | amount 8 | state 1 | root 32 | bump 1
async function readCampaign(connection: Connection, id: bigint) {
  const info = await connection.getAccountInfo(campaignPda(id), 'confirmed')
  if (!info) throw new Error(`Campaign #${id} not found on devnet`)
  const d = info.data
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const pk = (o: number) => new PublicKey(d.subarray(o, o + 32))
  return {
    admin: pk(8),
    mint: pk(48),
    vault: pk(80),
    amount: dv.getBigUint64(112, true),
    state: (d[120] === 1 ? 'Frozen' : 'Registering') as CampaignState,
    root: bytesToBigInt(d.subarray(121, 153)),
  }
}

// Tree (zero-copy): disc 8 | filled_subtrees 8*32 | current_root 32 | leaves 256*32 | next_index u32 LE (last 4 bytes)
async function readTree(connection: Connection, campaign: PublicKey) {
  const info = await connection.getAccountInfo(treePda(campaign), 'confirmed')
  if (!info) throw new Error('Tree account not found')
  return parseTree(info.data)
}
export function parseTree(d: Uint8Array) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const next = dv.getUint32(d.length - 4, true)
  const currentRoot = bytesToBigInt(d.subarray(8 + 256, 8 + 256 + 32))
  const leaves: bigint[] = []
  for (let i = 0; i < next; i++) leaves.push(bytesToBigInt(d.subarray(296 + 32 * i, 296 + 32 * (i + 1))))
  return { currentRoot, leaves }
}

/** Merkle path for leaf `index` (spec 3.2: pathIndices[i] = 0 -> current node is the LEFT child) */
export async function merklePath(leaves: bigint[], index: number) {
  const zero = await zeroChain()
  let layer = leaves.slice()
  let idx = index
  const pathElements: bigint[] = []
  const pathIndices: number[] = []
  for (let level = 0; level < TREE_DEPTH; level++) {
    pathElements.push(layer[idx ^ 1] ?? zero[level])
    pathIndices.push(idx & 1)
    const next: bigint[] = []
    for (let i = 0; i < layer.length; i += 2) next.push(await poseidon([layer[i], layer[i + 1] ?? zero[level]]))
    layer = next
    idx >>= 1
  }
  return { root: layer[0], pathElements, pathIndices }
}

/** True if this nullifier already claimed (its marker account exists on-chain). */
export async function isClaimed(connection: Connection, id: bigint, nullifier: bigint): Promise<boolean> {
  if (!LIVE.claim) return false
  const info = await connection.getAccountInfo(nullifierPda(campaignPda(id), bigIntToBytes32(nullifier)), 'confirmed')
  return info !== null
}

/** 100000000n, 6 -> "100" */
export function fmtTokens(x: bigint, decimals: number) {
  if (decimals === 0) return x.toString()
  const base = 10n ** BigInt(decimals)
  const frac = (x % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return (x / base).toString() + (frac ? '.' + frac : '')
}

export type CampaignState = 'Registering' | 'Frozen'

export type CampaignInfo = {
  id: bigint
  admin: string
  state: CampaignState
  amount: bigint // per claim, token base units
  mint: string
  vault: string
  vaultBalance: bigint // token base units
  decimals: number // mint decimals, for display
  registered: number // tree.next_index
  capacity: number // 2^TREE_DEPTH
  root: string // 0x-hex: tree.current_root while Registering, campaign.root once Frozen
}

/** From Tree.leaves + `Registered { index, commitment }` events; wallet = tx signer */
export type Registration = { index: number; wallet: string; commitment: string; signature: string; time: number | null }
/** From `Claimed { nullifier }` events; recipient = owner of the destination token account */
export type ClaimRecord = { nullifier: string; recipient: string; signature: string; time: number | null }

export type Ctx = { connection: Connection; wallet: WalletContextState }

export type ClaimRequest = { proof: Uint8Array; nullifier: bigint; recipient: PublicKey; campaignId: bigint }

/** add_eligible batch size (spec 2: about 10 per transaction) */
export const ELIGIBLE_BATCH = 10

// ---------- mock storage (persists in this browser) ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand32 = () => crypto.getRandomValues(new Uint8Array(32))
const fakeSig = () => toHex(rand32())
const fakeRoot = () => '0x' + toHex(rand32())
const nowSec = () => Math.floor(Date.now() / 1000)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const fakeAddr = () => Array.from(crypto.getRandomValues(new Uint8Array(44)), (b) => B58[b % 58]).join('')

type MockDb = {
  admin: string
  state: CampaignState
  amount: string
  mint: string
  vault: string
  eligible: string[]
  root: string
  registrations: Registration[]
  claims: ClaimRecord[]
}
const DB_KEY = 'zkclaim:mock:db'
function seedRegistrations(n: number): Registration[] {
  const start = nowSec() - 6 * 3600
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    wallet: fakeAddr(),
    commitment: '0x' + toHex(bigIntToBytes32(bytesToBigInt(rand32()) >> 4n)),
    signature: fakeSig(),
    time: start + i * 600 + Math.floor(Math.random() * 500),
  }))
}
const defaultDb = (): MockDb => ({
  admin: 'MOCK_ADMIN',
  state: 'Registering',
  amount: '100',
  mint: 'MOCK_MINT',
  vault: '3000',
  eligible: [],
  root: fakeRoot(),
  registrations: seedRegistrations(30), // spec 9: 30 seeded contributors
  claims: [],
})
function load(): MockDb {
  try {
    const s = localStorage.getItem(DB_KEY)
    if (s) return { ...defaultDb(), ...JSON.parse(s) }
  } catch {
    /* ignore */
  }
  const db = defaultDb()
  save(db)
  return db
}
function save(db: MockDb) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db))
  } catch {
    /* ignore */
  }
}
export function mockSetState(s: CampaignState) {
  save({ ...load(), state: s })
}
export function mockReset() {
  try {
    localStorage.removeItem(DB_KEY)
    localStorage.removeItem('zkclaim:mock:state') // old key
  } catch {
    /* ignore */
  }
}

// ---------- reads ----------
export async function getCampaign(connection: Connection, id: bigint): Promise<CampaignInfo> {
  if (LIVE.campaign) {
    const c = await readCampaign(connection, id)
    const [tree, bal] = await Promise.all([
      readTree(connection, campaignPda(id)),
      connection.getTokenAccountBalance(c.vault, 'confirmed'),
    ])
    return {
      id,
      admin: c.admin.toBase58(),
      state: c.state,
      amount: c.amount,
      mint: c.mint.toBase58(),
      vault: c.vault.toBase58(),
      vaultBalance: BigInt(bal.value.amount),
      decimals: bal.value.decimals,
      registered: tree.leaves.length,
      capacity: 2 ** TREE_DEPTH,
      root: toHex32(c.state === 'Frozen' ? c.root : tree.currentRoot),
    }
  }
  await sleep(300)
  const db = load()
  return {
    id,
    admin: db.admin,
    state: db.state,
    amount: BigInt(db.amount),
    mint: db.mint,
    vault: 'MOCK_VAULT',
    vaultBalance: BigInt(db.vault),
    decimals: 0,
    registered: db.registrations.length,
    capacity: 2 ** TREE_DEPTH,
    root: db.root,
  }
}

export async function isEligible(_connection: Connection, _id: bigint, _wallet: PublicKey): Promise<boolean> {
  await sleep(200)
  return true
}

/** All registrations, ordered by leaf index */
export async function getRegistrations(_connection: Connection, _id: bigint): Promise<Registration[]> {
  await sleep(300)
  return load().registrations
}

/** All claims, newest first */
export async function getClaims(_connection: Connection, _id: bigint): Promise<ClaimRecord[]> {
  await sleep(300)
  return [...load().claims].reverse()
}

/**
 * Spec 5.1: read the Tree account, rebuild the tree, check the root against campaign.root,
 * return the path for `commitment`. Throws if the commitment is not in the tree.
 * MOCK: a tree with only this commitment at index 0 (valid for snarkjs, not on-chain).
 */
export async function getMerklePath(connection: Connection, id: bigint, commitment: bigint): Promise<MerklePath> {
  if (LIVE.tree) {
    const [{ currentRoot, leaves }, c] = await Promise.all([readTree(connection, campaignPda(id)), readCampaign(connection, id)])
    const index = leaves.findIndex((l) => l === commitment)
    if (index < 0) throw new Error("This backup's commitment is not in the campaign's on-chain tree")
    const { root, pathElements, pathIndices } = await merklePath(leaves, index)
    if (root !== currentRoot) throw new Error('Rebuilt tree root does not match the on-chain root')
    if (c.state === 'Frozen' && root !== c.root) throw new Error('Tree root does not match the frozen campaign root')
    return { root, index, pathElements, pathIndices }
  }
  const zero = await zeroChain()
  let node = commitment
  const pathElements: bigint[] = []
  for (let i = 0; i < TREE_DEPTH; i++) {
    pathElements.push(zero[i])
    node = await poseidon([node, zero[i]])
  }
  return { root: node, index: 0, pathElements, pathIndices: Array(TREE_DEPTH).fill(0) }
}

// ---------- admin writes (admin wallet signs) ----------
/** create_campaign(campaign_id, amount): Campaign + Tree (root = zero[8]) + vault ATA for `mint` */
export async function createCampaign(ctx: Ctx, _id: bigint, mint: PublicKey, amount: bigint): Promise<string> {
  await sleep(1000)
  const zero = await zeroChain()
  save({
    ...defaultDb(),
    admin: ctx.wallet.publicKey?.toBase58() ?? 'MOCK_ADMIN',
    mint: mint.toBase58(),
    amount: amount.toString(),
    vault: '0',
    root: toHex32(zero[TREE_DEPTH]),
    registrations: [],
  })
  return fakeSig()
}

/** add_eligible(wallets): one call = one transaction, at most ELIGIBLE_BATCH wallets */
export async function addEligible(_ctx: Ctx, _id: bigint, wallets: PublicKey[]): Promise<string> {
  if (wallets.length > ELIGIBLE_BATCH) throw new Error(`At most ${ELIGIBLE_BATCH} wallets per transaction`)
  await sleep(700)
  const db = load()
  if (db.state !== 'Registering') throw new Error('NotRegistering')
  const set = new Set(db.eligible)
  wallets.forEach((w) => set.add(w.toBase58()))
  save({ ...db, eligible: [...set] })
  return fakeSig()
}

/** SPL transfer from the admin's token account into the campaign vault */
export async function fundVault(_ctx: Ctx, _id: bigint, amount: bigint): Promise<string> {
  await sleep(1000)
  const db = load()
  save({ ...db, vault: (BigInt(db.vault) + amount).toString() })
  return fakeSig()
}

/** freeze(): campaign.root = tree.current_root, state = Frozen. The admin never passes a root. */
export async function freeze(_ctx: Ctx, _id: bigint): Promise<string> {
  await sleep(1000)
  const db = load()
  if (db.state !== 'Registering') throw new Error('NotRegistering')
  save({ ...db, state: 'Frozen' })
  return fakeSig()
}

// ---------- user writes ----------
/** Sends `register(commitment)` signed by wallet A. Returns the tx signature. */
export async function register(ctx: Ctx, _id: bigint, commitment: Uint8Array): Promise<string> {
  await sleep(1200)
  const db = load()
  if (db.state !== 'Registering') throw new Error('NotRegistering')
  const sig = fakeSig()
  const reg: Registration = {
    index: db.registrations.length,
    wallet: ctx.wallet.publicKey?.toBase58() ?? fakeAddr(),
    commitment: '0x' + toHex(commitment),
    signature: sig,
    time: nowSec(),
  }
  save({ ...db, registrations: [...db.registrations, reg], root: fakeRoot() })
  return sig
}

/**
 * Spec 5.4: POST {RELAYER_URL}/claim
 * body: { proof: hex(256 bytes), nullifier: hex(32 bytes BE), recipient: base58, campaign: "<campaign_id>" }
 * response: { signature: string } or { error: string }
 */
export async function submitClaim(req: ClaimRequest): Promise<string> {
  const body = {
    proof: '0x' + toHex(req.proof),
    nullifier: '0x' + toHex(bigIntToBytes32(req.nullifier)),
    recipient: req.recipient.toBase58(),
    campaign: req.campaignId.toString(),
  }
  if (LIVE.claim) {
    let res: Response
    try {
      res = await fetch(`${RELAYER_URL}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error('Relayer is not reachable. Is it running on port 8787?')
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.signature) {
      const parts = [json.error, json.message, ...(json.details ?? []), ...(json.logs ?? [])].filter(Boolean)
      throw new Error(parts.join(' | ') || `Relayer error ${res.status}`)
    }
    if (String(json.signature).startsWith('mock-')) throw new Error('Relayer is still in mock mode (no real transaction)')
    return json.signature as string
  }
  // MOCK mirrors on-chain order: NotFrozen -> verify proof (recipient bound) -> init nullifier -> transfer
  await sleep(1200)
  const db = load()
  if (db.state !== 'Frozen') throw new Error('NotFrozen')
  const prev = db.claims.find((c) => c.nullifier === body.nullifier)
  if (prev && prev.recipient !== body.recipient) throw new Error('ProofInvalid')
  if (prev) throw new Error('Nullifier account already in use')
  const sig = fakeSig()
  const claim: ClaimRecord = { nullifier: body.nullifier, recipient: body.recipient, signature: sig, time: nowSec() }
  save({ ...db, claims: [...db.claims, claim], vault: (BigInt(db.vault) - BigInt(db.amount)).toString() })
  return sig
}
