import { useEffect, useState } from 'react'

/** Like useState for a message, but the message clears itself after `ms`. */
export function useFlash(ms = 5000): [string | null, (m: string | null) => void] {
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), ms)
    return () => clearTimeout(t)
  }, [message, ms])
  return [message, setMessage]
}

/** getCampaign() error for a campaign id that has no account on devnet */
export const isMissingCampaign = (e: unknown) => /not found on devnet/i.test(e instanceof Error ? e.message : String(e))
