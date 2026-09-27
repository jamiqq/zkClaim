import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { CAMPAIGN_ID, explorerTx } from '../config'
import * as api from '../api'
import type { CampaignInfo, ClaimRecord, Registration } from '../api'

const short = (s: string, n = 4) => (s.length > n * 2 + 2 ? `${s.slice(0, n + (s.startsWith('0x') ? 2 : 0))}…${s.slice(-n)}` : s)
const addrUrl = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`
const fmtTime = (t: number | null) =>
  t ? new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

export default function Explorer() {
  const { connection } = useConnection()
  const [campaign, setCampaign] = useState<CampaignInfo | null>(null)
  const [regs, setRegs] = useState<Registration[]>([])
  const [claims, setClaims] = useState<ClaimRecord[]>([])
  const [error, setError] = useState<string | null>(null)

  // "Trace it" (spec 9.6): pick a claim, then guess which registration made it
  const [picked, setPicked] = useState<ClaimRecord | null>(null)
  const [guess, setGuess] = useState<Registration | null>(null)

  async function reload() {
    // Load independently: a rate-limited history fetch must not hide the campaign, and vice versa.
    const [c, r, cl] = await Promise.allSettled([
      api.getCampaign(connection, CAMPAIGN_ID),
      api.getRegistrations(connection, CAMPAIGN_ID),
      api.getClaims(connection, CAMPAIGN_ID),
    ])
    if (c.status === 'fulfilled') setCampaign(c.value)
    if (r.status === 'fulfilled') setRegs(r.value)
    if (cl.status === 'fulfilled') setClaims(cl.value)
    const failed = [c, r, cl].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
    setError(failed ? 'Could not load everything from devnet (will retry): ' + String(failed.reason?.message ?? failed.reason).slice(0, 120) : null)
  }

  useEffect(() => {
    reload()
    const t = setInterval(reload, 15_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection])

  const n = regs.length

  return (
    <section className="explorer">
      <h1>Explorer</h1>
      {!api.LIVE.explorer && <p className="note">Demo mode: mock data, nothing is read from chain yet.</p>}

      <div className="card stats">
        <div><span className="muted">State</span><b>{campaign?.state ?? '…'}</b></div>
        <div><span className="muted">Registrations</span><b>{n}</b></div>
        <div><span className="muted">Claims</span><b>{claims.length}</b></div>
        <div className="full">
          <span className="muted">Anonymity set</span>
          <span>
            Every claim is a proof of “one of these {n} registrations” — nothing on-chain says which.
            {n > 0 && <> A guess is right with probability <b>1/{n}</b>.</>}
          </span>
        </div>
      </div>

      <div className="card trace">
        {!picked && <p>🔍 <b>Trace it:</b> click a claim on the right, then guess which registration made it.</p>}
        {picked && !guess && (
          <p>
            Claim to <span className="mono">{short(picked.recipient, 6)}</span> selected. Now pick the registration you think made it.{' '}
            <button className="link" onClick={() => setPicked(null)}>cancel</button>
          </p>
        )}
        {picked && guess && (
          <p>
            You guessed registration <b>#{guess.index}</b> (<span className="mono">{short(guess.wallet, 6)}</span>).
            Nothing on-chain can confirm or rule that out: the proof only shows the claimer is one of {n}.{' '}
            <button className="link" onClick={() => { setPicked(null); setGuess(null) }}>try again</button>
          </p>
        )}
      </div>

      <div className="columns">
        <div className="card">
          <h2>Registrations <span className="muted">wallet → commitment</span></h2>
          <p className="small muted">Public: everyone sees which wallets are eligible and registered.</p>
          <table>
            <thead><tr><th>#</th><th>Wallet</th><th>Commitment</th><th>Time</th></tr></thead>
            <tbody>
              {regs.map((r) => (
                <tr
                  key={r.index}
                  className={picked ? 'pickable' + (guess?.index === r.index ? ' guessed' : '') : ''}
                  onClick={() => picked && setGuess(r)}
                >
                  <td className="muted">{r.index}</td>
                  <td className="mono">{!api.LIVE.explorer ? short(r.wallet) : <a href={addrUrl(r.wallet)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{short(r.wallet)}</a>}</td>
                  <td className="mono">{short(r.commitment, 6)}</td>
                  <td className="muted">{fmtTime(r.time)}</td>
                </tr>
              ))}
              {regs.length === 0 && <tr><td colSpan={4} className="muted">No registrations yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Claims <span className="muted">nullifier → recipient</span></h2>
          <p className="small muted">No wallet, commitment or leaf index. Only a nullifier and a fresh recipient.</p>
          <table>
            <thead><tr><th>Nullifier</th><th>Recipient</th><th>Time</th><th /></tr></thead>
            <tbody>
              {claims.map((c) => (
                <tr
                  key={c.nullifier}
                  className={'pickable' + (picked?.nullifier === c.nullifier ? ' guessed' : '')}
                  onClick={() => { setPicked(c); setGuess(null) }}
                >
                  <td className="mono">{short(c.nullifier, 6)}</td>
                  <td className="mono">{short(c.recipient)}</td>
                  <td className="muted">{fmtTime(c.time)}</td>
                  <td>{api.LIVE.explorer && <a href={explorerTx(c.signature)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>tx ↗</a>}</td>
                </tr>
              ))}
              {claims.length === 0 && <tr><td colSpan={4} className="muted">No claims yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  )
}
