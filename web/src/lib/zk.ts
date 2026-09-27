import type { PublicKey } from '@solana/web3.js'
import { PROOF_BYTES, TREE_DEPTH, ZK_WASM, ZK_ZKEY } from '../config'
import { poseidon } from './poseidon'
import { bigIntToBytes32, bytesToBigInt } from './secret'

// BN254 base field (G1/G2 coordinates). Needed to negate proof_a (spec 4.3).
const BASE_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n

export type MerklePath = { root: bigint; index: number; pathElements: bigint[]; pathIndices: number[] }

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** recipient_hi = bytes 0..16, recipient_lo = bytes 16..32, both big-endian (spec 3.1) */
export function recipientLimbs(pk: PublicKey) {
  const b = pk.toBytes()
  return { hi: bytesToBigInt(b.slice(0, 16)), lo: bytesToBigInt(b.slice(16, 32)) }
}

/** nullifier = Poseidon(secret, campaign_id) */
export const nullifierOf = (secret: bigint, campaignId: bigint) => poseidon([secret, campaignId])

/** zero[0] = 0, zero[i+1] = Poseidon(zero[i], zero[i]) */
export async function zeroChain(): Promise<bigint[]> {
  const z = [0n]
  for (let i = 0; i < TREE_DEPTH; i++) z.push(await poseidon([z[i], z[i]]))
  return z
}

/** Circuit input in declaration order (spec 3.1). All values as decimal strings. */
export function buildInput(a: {
  secret: bigint
  campaignId: bigint
  recipient: PublicKey
  path: MerklePath
  nullifier: bigint
}) {
  const { hi, lo } = recipientLimbs(a.recipient)
  return {
    root: a.path.root.toString(),
    nullifier: a.nullifier.toString(),
    recipient_hi: hi.toString(),
    recipient_lo: lo.toString(),
    campaign_id: a.campaignId.toString(),
    secret: a.secret.toString(),
    pathElements: a.path.pathElements.map(String),
    pathIndices: a.path.pathIndices.map(String),
  };
}

/** True once P1's zkclaim.wasm is in web/public/zk/ */
export async function proverAvailable(): Promise<boolean> {
  try {
    const r = await fetch(ZK_WASM, { method: 'HEAD' })
    return r.ok && (r.headers.get('content-type') ?? '').includes('wasm')
  } catch {
    return false
  }
}

/** snarkjs proof -> 256 bytes: proof_a (64, NEGATED) || proof_b (128) || proof_c (64), big-endian */
export function proofToBytes(p: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): Uint8Array {
  const out = new Uint8Array(PROOF_BYTES)
  const put = (x: string | bigint, off: number) => out.set(bigIntToBytes32(BigInt(x)), off)
  put(p.pi_a[0], 0)
  put((BASE_Q - BigInt(p.pi_a[1])) % BASE_Q, 32) // negate y
  // G2: each Fp2 element as (c1, c0), i.e. imaginary part first (EIP-197 / alt_bn128 syscall order)
  put(p.pi_b[0][1], 64)
  put(p.pi_b[0][0], 96)
  put(p.pi_b[1][1], 128)
  put(p.pi_b[1][0], 160)
  put(p.pi_c[0], 192)
  put(p.pi_c[1], 224)
  return out
}

/** Proves in the browser. The secret never leaves the device (spec 5.2). */
export async function prove(input: ReturnType<typeof buildInput>) {
  const t = performance.now()
  const snarkjs = await import('snarkjs')
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, ZK_WASM, ZK_ZKEY)
  return { proof: proofToBytes(proof), publicSignals: publicSignals as string[], ms: performance.now() - t }
}
