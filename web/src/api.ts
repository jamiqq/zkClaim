// Contract between the UI (P4) and the TS infra (P3).
// Everything here is a MOCK for now; P3 replaces the bodies, the signatures stay.
import type { Connection, PublicKey } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import { RELAYER_URL, TREE_DEPTH } from './config'
import { poseidon } from './lib/poseidon'
import { type MerklePath, toHex, zeroChain } from './lib/zk'
import { bigIntToBytes32 } from './lib/secret'

export const MOCK = true

export type CampaignState = 'Registering' | 'Frozen'

export type CampaignInfo = {
  id: bigint
  state: CampaignState
  amount: bigint
  mint: string
  registered: number
  capacity: number
}

export type Registration = { index: number; wallet: string; commitment: string; signature: string }
export type ClaimRecord = { nullifier: string; recipient: string; signature: string }

export type Ctx = { connection: Connection; wallet: WalletContextState }

export type ClaimRequest = { proof: Uint8Array; nullifier: bigint; recipient: PublicKey; campaignId: bigint }

// ---------- mock helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fakeSig = () => toHex(crypto.getRandomValues(new Uint8Array(32)))
const STATE_KEY = 'zkclaim:mock:state'
function mockState(): CampaignState {
  try {
    return (localStorage.getItem(STATE_KEY) as CampaignState) || 'Registering'
  } catch {
    return 'Registering'
  }
}
export function mockSetState(s: CampaignState) {
  try {
    localStorage.setItem(STATE_KEY, s)
  } catch {
    /* ignore */
  }
}
const mockClaimed = new Map<string, string>() // nullifier -> recipient

// ---------- reads ----------
export async function getCampaign(_connection: Connection, id: bigint): Promise<CampaignInfo> {
  await sleep(300)
  return { id, state: mockState(), amount: 100n, mint: 'MOCKMINT', registered: 12, capacity: 256 }
}

export async function isEligible(_connection: Connection, _id: bigint, _wallet: PublicKey): Promise<boolean> {
  await sleep(200)
  return true
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

// ---------- writes ----------
/** Sends `register(commitment)` signed by wallet A. Returns the tx signature. */
export async function register(_ctx: Ctx, _id: bigint, _commitment: Uint8Array): Promise<string> {
  await sleep(1200)
  return fakeSig()
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
  // MOCK mirrors on-chain order: verify proof (recipient bound) -> init nullifier
  await sleep(1200)
  const prev = mockClaimed.get(body.nullifier)
  if (prev && prev !== body.recipient) throw new Error('ProofInvalid')
  if (prev) throw new Error('Nullifier account already in use')
  mockClaimed.set(body.nullifier, body.recipient)
  return fakeSig()
}
