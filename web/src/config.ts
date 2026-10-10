// Team-wide constants live in shared/constants.ts. This file only adds UI-specific values.
export * from '../../shared/constants'
import { CLUSTER_URL } from '../../shared/constants'

// Put the Helius URL in web/.env.local (gitignored):  VITE_RPC_URL=https://devnet.helius-rpc.com/?api-key=...
export const RPC_URL: string = import.meta.env.VITE_RPC_URL || CLUSTER_URL
// '/relayer' is proxied by Vite to the local relayer (see vite.config.ts), so the browser needs no CORS.
export const RELAYER_URL: string = import.meta.env.VITE_RELAYER_URL || '/relayer'
export const DEFAULT_CAMPAIGN_ID = 2026092701n

// Active campaign: ?campaign=<id> in the URL, else the last one used in this browser, else the demo campaign.
const CAMPAIGN_KEY = 'zkclaim:campaign'
function initialCampaignId(): bigint {
  try {
    const q = new URLSearchParams(window.location.search).get('campaign')
    if (q && /^\d+$/.test(q)) {
      localStorage.setItem(CAMPAIGN_KEY, q)
      return BigInt(q)
    }
    const saved = localStorage.getItem(CAMPAIGN_KEY)
    if (saved && /^\d+$/.test(saved)) return BigInt(saved)
  } catch {
    /* storage blocked: fall through */
  }
  return DEFAULT_CAMPAIGN_ID
}
export const CAMPAIGN_ID = initialCampaignId()

/** Switch the whole app to another campaign (full reload so every page reads the new id). */
export function switchCampaign(id: bigint) {
  try {
    localStorage.setItem(CAMPAIGN_KEY, id.toString())
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href)
  url.searchParams.set('campaign', id.toString())
  window.location.href = url.toString()
}
export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`
export const explorerAddr = (addr: string) =>
  `https://explorer.solana.com/address/${addr}?cluster=devnet`
