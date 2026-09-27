// Team-wide constants live in shared/constants.ts. This file only adds UI-specific values.
export * from '../../shared/constants'
import { CLUSTER_URL } from '../../shared/constants'

// Put the Helius URL in web/.env.local (gitignored):  VITE_RPC_URL=https://devnet.helius-rpc.com/?api-key=...
export const RPC_URL: string = import.meta.env.VITE_RPC_URL || CLUSTER_URL
// '/relayer' is proxied by Vite to the local relayer (see vite.config.ts), so the browser needs no CORS.
export const RELAYER_URL: string = import.meta.env.VITE_RELAYER_URL || '/relayer'
export const CAMPAIGN_ID = 2026092701n
export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`
export const explorerAddr = (addr: string) =>
  `https://explorer.solana.com/address/${addr}?cluster=devnet`
