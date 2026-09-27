// Contract between the UI (P4) and the TS infra (P3).
// Everything here is a MOCK for now; P3 replaces the bodies, the signatures stay.
import type { Connection, PublicKey } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import { RELAYER_URL, TREE_DEPTH } from './config'
import { poseidon } from './lib/poseidon'
import { type MerklePath, toHex, zeroChain } from './lib/zk'
import { bigIntToBytes32, bytesToBigInt, toHex32 } from './lib/secret'

export const MOCK = true

export type CampaignState = 'Registering' | 'Frozen'

export type CampaignInfo = {
  id: bigint
  admin: string
  state: CampaignState
  amount: bigint // per claim, token base units
  mint: string
  vaultBalance: bigint // token base units
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
export async function getCampaign(_connection: Connection, id: bigint): Promise<CampaignInfo> {
  await sleep(300)
  const db = load()
  return {
    id,
    admin: db.admin,
    state: db.state,
    amount: BigInt(db.amount),
    mint: db.mint,
    vaultBalance: BigInt(db.vault),
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
export async function getMerklePath(_connection: Connection, _id: bigint, commitment: bigint): Promise<MerklePath> {
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
    proof: toHex(req.proof),
    nullifier: toHex(bigIntToBytes32(req.nullifier)),
    recipient: req.recipient.toBase58(),
    campaign: req.campaignId.toString(),
  }
  if (!MOCK) {
    const res = await fetch(`${RELAYER_URL}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error ?? `Relayer error ${res.status}`)
    return json.signature as string
  }
  // MOCK mirrors on-chain order: NotFrozen -> verify proof (recipient bound) -> init nullifier -> transfer
  await sleep(1200)
  const db = load()
  if (db.state !== 'Frozen') throw new Error('NotFrozen')
  const prev = db.claims.find((c) => c.nullifier === '0x' + body.nullifier)
  if (prev && prev.recipient !== body.recipient) throw new Error('ProofInvalid')
  if (prev) throw new Error('Nullifier account already in use')
  const sig = fakeSig()
  const claim: ClaimRecord = { nullifier: '0x' + body.nullifier, recipient: body.recipient, signature: sig, time: nowSec() }
  save({ ...db, claims: [...db.claims, claim], vault: (BigInt(db.vault) - BigInt(db.amount)).toString() })
  return sig
}
