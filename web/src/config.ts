// Team-wide constants live in shared/constants.ts. This file only adds UI-specific values.
export * from '../../shared/constants'
import { CLUSTER_URL } from '../../shared/constants'

export const RPC_URL = CLUSTER_URL
export const RELAYER_URL = 'http://localhost:8787'
export const CAMPAIGN_ID = 1n
export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`
