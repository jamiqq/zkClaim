// Contract between the UI (P4) and the TS infra (P3).
// Everything here is a MOCK for now; P3 replaces the bodies, the signatures stay.
import {
  type Connection,
  type ParsedTransactionWithMeta,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import { Buffer } from 'buffer'
import { utils as anchorUtils } from '@coral-xyz/anchor'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import {
  PROGRAM_ID,
  RELAYER_URL,
  SEED_CAMPAIGN,
  SEED_ELIGIBLE,
  SEED_NULLIFIER,
  SEED_REGISTRATION,
  SEED_TREE,
  TREE_DEPTH,
} from './config'
import { poseidon } from './lib/poseidon'
import { type MerklePath, toHex, zeroChain } from './lib/zk'
import { bigIntToBytes32, bytesToBigInt, toHex32 } from './lib/secret'

/** What talks to devnet for real. Everything else is still a mock. */
export const LIVE = {
  campaign: true, // getCampaign reads Campaign + Tree + vault
  tree: true, // getMerklePath rebuilds the on-chain tree
  claim: true, // submitClaim -> relayer
  register: true, // register -> program (wallet A signs and pays)
  admin: true, // create / add eligible / fund / freeze -> program (admin wallet signs)
  explorer: true, // registrations + claims from the campaign's transaction history
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
export const eligiblePda = (campaign: PublicKey, wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([enc(SEED_ELIGIBLE), campaign.toBytes(), wallet.toBytes()], programId)[0]
export const registrationPda = (campaign: PublicKey, wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([enc(SEED_REGISTRATION), campaign.toBytes(), wallet.toBytes()], programId)[0]

// ---------- sending instructions (hand-built from the IDL, like the explorer decoder) ----------
const IX_CREATE_CAMPAIGN = [111, 131, 187, 98, 160, 193, 114, 244] // args: campaign_id u64, amount u64
const IX_ADD_ELIGIBLE = [181, 45, 41, 132, 148, 165, 2, 11] // args: wallets Vec<Pubkey>; remaining: Eligible PDAs
const IX_FREEZE = [165, 89, 137, 206, 78, 240, 248, 118] // no args
// IX_REGISTER (args: commitment [u8; 32]) is declared with the explorer constants below

const PROGRAM_ERRORS: Record<number, string> = {
  6000: 'Unauthorized: this wallet is not the campaign admin',
  6001: 'NotRegistering: the campaign is already frozen',
  6002: 'NotFrozen: the campaign is still open for registration',
  6003: 'TreeFull: the campaign has 256 registrations already',
  6004: 'InvalidCommitment: commitment must be non-zero and below the field modulus',
  6007: 'InvalidAmount: amount per claim must be greater than zero',
  6008: 'EligibleCountMismatch: wallet list does not match the accounts',
  6009: 'InvalidEligibleAccount: wrong Eligible account',
  6010: 'AlreadyEligible: a wallet in this batch is already on the list',
  6011: 'PoseidonFailed: on-chain hash failed',
  6012: 'NoRegistrations: cannot freeze a campaign with no registrations',
}

const acc = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable })
function concatBytes(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
function u32le(n: number) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
const ix = (keys: ReturnType<typeof acc>[], disc: number[], ...args: Uint8Array[]) =>
  new TransactionInstruction({ programId, keys, data: Buffer.from(concatBytes(Uint8Array.from(disc), ...args)) })

/** Turn simulation logs into a readable reason (Anchor error, custom code, rent, duplicate account). */
function explain(logs: string[] | null | undefined, err: unknown): string {
  const all = (logs ?? []).join('\n')
  const anchor = all.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^\n]+?)\.?(\n|$)/)
  if (anchor) return PROGRAM_ERRORS[Number(anchor[2])] ?? `${anchor[1]}: ${anchor[3]}`
  const custom = all.match(/custom program error: 0x([0-9a-f]+)/i)
  if (custom) {
    const code = parseInt(custom[1], 16)
    return PROGRAM_ERRORS[code] ?? `Program error ${code}`
  }
  if (/already in use/.test(all)) return 'An account already exists (campaign already created, wallet already added or registered)'
  if (/insufficient (funds|lamports)/i.test(all) || /InsufficientFundsForRent/.test(JSON.stringify(err)))
    return 'Not enough devnet SOL in this wallet for rent and fees'
  return `Simulation failed: ${JSON.stringify(err)}`
}

/** Simulate first (readable errors, no wallet popup on failure), then sign with the connected wallet. */
async function send(ctx: Ctx, instructions: TransactionInstruction[]): Promise<string> {
  const { connection, wallet } = ctx
  if (!wallet.publicKey) throw new Error('Connect a wallet first')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  )
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' })
  if (sim.value.err) throw new Error(explain(sim.value.logs, sim.value.err))
  const signature = await wallet.sendTransaction(tx, connection)
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`)
  return signature
}

function signer(ctx: Ctx) {
  if (!ctx.wallet.publicKey) throw new Error('Connect a wallet first')
  return ctx.wallet.publicKey
}

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

// ---------- Explorer: registrations + claims from tx history (IDL: shared/idl/zkclaim.json) ----------
const IX_REGISTER = [211, 124, 67, 15, 211, 194, 178, 240] // accounts: user, payer, campaign, ...
const IX_CLAIM = [62, 198, 214, 193, 213, 159, 108, 210] // accounts: relayer, campaign, nullifier_account, recipient, ...
const EV_REGISTERED = [11, 222, 10, 72, 160, 110, 165, 227] // index u32 | commitment [32] | root [32]
const EV_CLAIMED = [217, 192, 123, 72, 108, 150, 248, 33] // campaign pubkey | nullifier [32]
const startsWith = (b: Uint8Array, d: number[]) => b.length >= d.length && d.every((x, i) => b[i] === x)
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

type Activity = { registration?: Registration; claim?: ClaimRecord }

/** Pure: one parsed transaction -> the registration or claim it contains (if any). */
export function decodeActivity(tx: ParsedTransactionWithMeta, signature: string): Activity {
  if (!tx.meta || tx.meta.err) return {}
  const events = (tx.meta.logMessages ?? [])
    .filter((l) => l.startsWith('Program data: '))
    .map((l) => b64(l.slice('Program data: '.length)))
  const ix = tx.transaction.message.instructions.find(
    (i) => i.programId.equals(programId) && 'data' in i,
  ) as { accounts: PublicKey[]; data: string } | undefined
  const ixData = ix ? anchorUtils.bytes.bs58.decode(ix.data) : new Uint8Array()
  const time = tx.blockTime ?? null

  const reg = events.find((e) => startsWith(e, EV_REGISTERED))
  if (reg) {
    const dv = new DataView(reg.buffer, reg.byteOffset, reg.byteLength)
    return {
      registration: {
        index: dv.getUint32(8, true),
        wallet: ix && startsWith(ixData, IX_REGISTER) ? ix.accounts[0].toBase58() : '?',
        commitment: '0x' + toHex(reg.subarray(12, 44)),
        signature,
        time,
      },
    }
  }
  const cl = events.find((e) => startsWith(e, EV_CLAIMED))
  if (cl) {
    return {
      claim: {
        nullifier: '0x' + toHex(cl.subarray(40, 72)),
        recipient: ix && startsWith(ixData, IX_CLAIM) ? ix.accounts[3].toBase58() : '?',
        signature,
        time,
      },
    }
  }
  return {}
}

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (i >= tries - 1 || !/429|413|Too many requests|rate/i.test(m)) throw e
      await sleep(400 * 2 ** i)
    }
  }
}

const activityCache = new Map<string, Activity>() // signature -> decoded (txs never change once confirmed)

let activityInflight: { at: number; id: bigint; p: ReturnType<typeof readActivityUncached> } | null = null
function readActivity(connection: Connection, id: bigint) {
  // getRegistrations + getClaims are called together: share one fetch for 3 s
  if (activityInflight && activityInflight.id === id && Date.now() - activityInflight.at < 3000) return activityInflight.p
  const p = readActivityUncached(connection, id)
  activityInflight = { at: Date.now(), id, p }
  p.catch(() => { activityInflight = null })
  return p
}

async function readActivityUncached(connection: Connection, id: bigint) {
  const campaign = campaignPda(id)
  const sigs: { signature: string; err: unknown }[] = []
  let before: string | undefined
  for (;;) {
    const page = await withRetry(() => connection.getSignaturesForAddress(campaign, { before, limit: 1000 }, 'confirmed'))
    sigs.push(...page)
    if (page.length < 1000) break
    before = page[page.length - 1].signature
  }
  const todo = sigs.filter((s) => !s.err && !activityCache.has(s.signature)).map((s) => s.signature)
  // One request per tx (free RPC plans reject JSON-RPC batches), 3 at a time, retry on rate limits.
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const sig = todo[next++]
      const tx = await withRetry(() =>
        connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
      )
      if (tx) activityCache.set(sig, decodeActivity(tx, sig))
    }
  }
  await Promise.all([worker(), worker(), worker()])
  const all = sigs.map((s) => activityCache.get(s.signature)).filter((a): a is Activity => !!a)
  return {
    registrations: all.flatMap((a) => (a.registration ? [a.registration] : [])).sort((a, b) => a.index - b.index),
    claims: all.flatMap((a) => (a.claim ? [a.claim] : [])), // signatures come newest first
  }
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

/** True while the wallet's Eligible account exists. register() closes it, so a registered wallet returns false. */
export async function isEligible(connection: Connection, id: bigint, wallet: PublicKey): Promise<boolean> {
  if (LIVE.register) return (await connection.getAccountInfo(eligiblePda(campaignPda(id), wallet), 'confirmed')) !== null
  await sleep(200)
  return true
}

/** True if the wallet already registered in this campaign. */
export async function isRegistered(connection: Connection, id: bigint, wallet: PublicKey): Promise<boolean> {
  if (!LIVE.register) return false
  return (await connection.getAccountInfo(registrationPda(campaignPda(id), wallet), 'confirmed')) !== null
}

/** All registrations, ordered by leaf index */
export async function getRegistrations(connection: Connection, id: bigint): Promise<Registration[]> {
  if (LIVE.explorer) return (await readActivity(connection, id)).registrations
  await sleep(300)
  return load().registrations
}

/** All claims, newest first */
export async function getClaims(connection: Connection, id: bigint): Promise<ClaimRecord[]> {
  if (LIVE.explorer) return (await readActivity(connection, id)).claims
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
export async function createCampaign(ctx: Ctx, id: bigint, mint: PublicKey, amount: bigint): Promise<string> {
  if (LIVE.admin) {
    const admin = signer(ctx)
    const campaign = campaignPda(id)
    if (await ctx.connection.getAccountInfo(campaign, 'confirmed')) throw new Error(`Campaign #${id} already exists`)
    const mintInfo = await ctx.connection.getAccountInfo(mint, 'confirmed')
    if (!mintInfo) throw new Error('Mint not found on devnet')
    if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error('Only classic SPL Token mints are supported (not Token-2022)')
    const vault = getAssociatedTokenAddressSync(mint, campaign, true)
    return send(ctx, [
      ix(
        [
          acc(admin, true, true),
          acc(campaign, false, true),
          acc(treePda(campaign), false, true),
          acc(mint),
          acc(vault, false, true),
          acc(TOKEN_PROGRAM_ID),
          acc(ASSOCIATED_TOKEN_PROGRAM_ID),
          acc(SystemProgram.programId),
        ],
        IX_CREATE_CAMPAIGN,
        u64le(id),
        u64le(amount),
      ),
    ])
  }
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
export async function addEligible(ctx: Ctx, id: bigint, wallets: PublicKey[]): Promise<string> {
  if (wallets.length > ELIGIBLE_BATCH) throw new Error(`At most ${ELIGIBLE_BATCH} wallets per transaction`)
  if (LIVE.admin) {
    const admin = signer(ctx)
    const campaign = campaignPda(id)
    return send(ctx, [
      ix(
        [
          acc(admin, true, true),
          acc(campaign),
          acc(SystemProgram.programId),
          ...wallets.map((w) => acc(eligiblePda(campaign, w), false, true)),
        ],
        IX_ADD_ELIGIBLE,
        u32le(wallets.length),
        ...wallets.map((w) => w.toBytes()),
      ),
    ])
  }
  await sleep(700)
  const db = load()
  if (db.state !== 'Registering') throw new Error('NotRegistering')
  const set = new Set(db.eligible)
  wallets.forEach((w) => set.add(w.toBase58()))
  save({ ...db, eligible: [...set] })
  return fakeSig()
}

/** SPL transfer from the admin's token account into the campaign vault */
export async function fundVault(ctx: Ctx, id: bigint, amount: bigint): Promise<string> {
  if (LIVE.admin) {
    const owner = signer(ctx)
    const c = await readCampaign(ctx.connection, id)
    const { decimals } = await getMint(ctx.connection, c.mint, 'confirmed')
    const source = getAssociatedTokenAddressSync(c.mint, owner)
    const bal = await ctx.connection.getTokenAccountBalance(source, 'confirmed').catch(() => null)
    if (!bal) throw new Error('This wallet has no token account for the campaign mint')
    if (BigInt(bal.value.amount) < amount) throw new Error(`This wallet only holds ${bal.value.amount} base units of the mint`)
    return send(ctx, [createTransferCheckedInstruction(source, c.mint, c.vault, owner, amount, decimals)])
  }
  await sleep(1000)
  const db = load()
  save({ ...db, vault: (BigInt(db.vault) + amount).toString() })
  return fakeSig()
}

/** freeze(): campaign.root = tree.current_root, state = Frozen. The admin never passes a root. */
export async function freeze(ctx: Ctx, id: bigint): Promise<string> {
  if (LIVE.admin) {
    const admin = signer(ctx)
    const campaign = campaignPda(id)
    return send(ctx, [ix([acc(admin, true), acc(campaign, false, true), acc(treePda(campaign))], IX_FREEZE)])
  }
  await sleep(1000)
  const db = load()
  if (db.state !== 'Registering') throw new Error('NotRegistering')
  save({ ...db, state: 'Frozen' })
  return fakeSig()
}

// ---------- user writes ----------
/** Sends `register(commitment)` signed by wallet A. Returns the tx signature. */
export async function register(ctx: Ctx, id: bigint, commitment: Uint8Array): Promise<string> {
  if (LIVE.register) {
    const user = signer(ctx) // wallet A signs and pays rent for its Registration account
    const campaign = campaignPda(id)
    return send(ctx, [
      ix(
        [
          acc(user, true),
          acc(user, true, true),
          acc(campaign),
          acc(treePda(campaign), false, true),
          acc(eligiblePda(campaign, user), false, true),
          acc(registrationPda(campaign, user), false, true),
          acc(SystemProgram.programId),
        ],
        IX_REGISTER,
        commitment,
      ),
    ])
  }
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
