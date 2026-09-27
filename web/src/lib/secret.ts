import { poseidon } from './poseidon'

import { FIELD_MODULUS as FIELD_P } from '../config'

export type Backup = {
  app: 'zkclaim'
  version: 1
  campaignId: string
  wallet: string
  secret: string // 0x-hex
  commitment: string // 0x-hex, 32 bytes big-endian
  createdAt: string
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n
  for (const v of b) x = (x << 8n) | BigInt(v)
  return x
}

export function bigIntToBytes32(x: bigint): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

export const toHex32 = (x: bigint) => '0x' + x.toString(16).padStart(64, '0')

export function randomFieldElement(): bigint {
  for (;;) {
    const x = bytesToBigInt(crypto.getRandomValues(new Uint8Array(32))) % FIELD_P
    if (x !== 0n) return x
  }
}

export const commitmentOf = (secret: bigint): Promise<bigint> => poseidon([secret])

export async function makeBackup(campaignId: bigint, wallet: string): Promise<Backup> {
  const secret = randomFieldElement()
  return {
    app: 'zkclaim',
    version: 1,
    campaignId: campaignId.toString(),
    wallet,
    secret: toHex32(secret),
    commitment: toHex32(await commitmentOf(secret)),
    createdAt: new Date().toISOString(),
  }
}

export function downloadBackup(b: Backup) {
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `zkclaim-${b.campaignId}-${b.wallet.slice(0, 6)}.zkclaim`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function parseBackup(text: string): Promise<Backup> {
  const b = JSON.parse(text)
  if (b?.app !== 'zkclaim' || !b.secret || !b.campaignId) {
    throw new Error('This is not a zkClaim backup file')
  }
  // Accept decimal or 0x-hex numbers (scripts write decimal, the web app writes hex); normalize to hex.
  const secret = BigInt(b.secret)
  const commitment = await commitmentOf(secret)
  if (b.commitment !== undefined && BigInt(b.commitment) !== commitment) {
    throw new Error('Backup file is corrupted: secret does not match commitment')
  }
  return {
    app: 'zkclaim',
    version: 1,
    campaignId: String(b.campaignId),
    wallet: b.wallet ?? '(unknown)',
    secret: toHex32(secret),
    commitment: toHex32(commitment),
    createdAt: b.createdAt ?? new Date().toISOString(),
  }
}

const key = (campaignId: string, wallet: string) => `zkclaim:${campaignId}:${wallet}`

export function saveLocal(b: Backup) {
  try {
    localStorage.setItem(key(b.campaignId, b.wallet), JSON.stringify(b))
  } catch {
    /* storage unavailable: the downloaded file is the real backup */
  }
}

export function loadLocal(campaignId: string, wallet: string): Backup | null {
  try {
    const s = localStorage.getItem(key(campaignId, wallet))
    return s ? (JSON.parse(s) as Backup) : null
  } catch {
    return null
  }
}

export function listLocal(campaignId: string): Backup[] {
  const out: Backup[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(`zkclaim:${campaignId}:`)) out.push(JSON.parse(localStorage.getItem(k)!) as Backup)
    }
  } catch {
    /* storage unavailable */
  }
  return out
}
