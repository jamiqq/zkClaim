import { useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { CAMPAIGN_ID, explorerTx } from '../config'
import * as api from '../api'
import { isMissingCampaign, useFlash } from '../lib/useFlash'
import type { CampaignInfo } from '../api'
import { type Backup, bigIntToBytes32, downloadBackup, loadLocal, makeBackup, saveLocal } from '../lib/secret'

export default function Register() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const addr = wallet.publicKey?.toBase58()

  const [campaign, setCampaign] = useState<CampaignInfo | null>(null)
  const [eligible, setEligible] = useState<boolean | null>(null)
  const [registered, setRegistered] = useState(false)
  const [backup, setBackup] = useState<Backup | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sig, setSig] = useState<string | null>(null)
  const [error, setError] = useFlash()
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    api.getCampaign(connection, CAMPAIGN_ID).then(setCampaign).catch((e) => (isMissingCampaign(e) ? setMissing(true) : setError(String(e))))
  }, [connection])

  useEffect(() => {
    setEligible(null)
    setRegistered(false)
    setBackup(null)
    setSaved(false)
    setSig(null)
    setError(null)
    if (!wallet.publicKey) return
    const existing = loadLocal(CAMPAIGN_ID.toString(), wallet.publicKey.toBase58())
    if (existing) setBackup(existing)
    api.isEligible(connection, CAMPAIGN_ID, wallet.publicKey).then(setEligible).catch((e) => setError(String(e)))
    api.isRegistered(connection, CAMPAIGN_ID, wallet.publicKey).then(setRegistered).catch(() => {})
  }, [connection, wallet.publicKey])

  async function generate() {
    if (!addr) return
    const b = await makeBackup(CAMPAIGN_ID, addr)
    saveLocal(b)
    setBackup(b)
    setSaved(false)
  }

  async function doRegister() {
    if (!backup) return
    setBusy(true)
    setError(null)
    try {
      setSig(await api.register({ connection, wallet }, CAMPAIGN_ID, bigIntToBytes32(BigInt(backup.commitment))))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  let body
  if (missing) body = <div className="card">Campaign #{CAMPAIGN_ID.toString()} does not exist on devnet. Open another campaign in the header.</div>
  else if (!addr) body = <div className="card">Connect the eligible wallet (A) to register.</div>
  else if (!campaign || eligible === null) body = <div className="card">Loading…</div>
  else if (campaign.state !== 'Registering') body = <div className="card">Registration is closed.</div>
  else if (registered && !sig)
    body = <div className="card">This wallet is already registered. Keep your backup file and claim after the freeze.</div>
  else if (!eligible) body = <div className="card">This wallet is not on the eligible list for this campaign.</div>
  else if (sig)
    body = (
      <div className="card ok">
        <h2>Registered</h2>
        <p>Your commitment is in the tree. Keep the backup file: you need it to claim after the freeze.</p>
        <a href={explorerTx(sig)} target="_blank" rel="noreferrer">View transaction ↗</a>
      </div>
    )
  else
    body = (
      <ol className="steps">
        <li className="card">
          <h2>Generate your secret</h2>
          <p>It is created on this device and never sent anywhere. Only its hash goes on-chain.</p>
          <button onClick={generate} disabled={busy}>{backup ? 'Generate a new one' : 'Generate secret'}</button>
          {backup && (
            <p className="mono">commitment {backup.commitment.slice(0, 10)}…{backup.commitment.slice(-8)}</p>
          )}
        </li>
        <li className="card">
          <h2>Save the backup</h2>
          <p className="warn">If you lose this file you cannot claim. Nobody can recover it.</p>
          <button onClick={() => backup && downloadBackup(backup)} disabled={!backup}>Download .zkclaim file</button>
          <label>
            <input type="checkbox" checked={saved} disabled={!backup} onChange={(e) => setSaved(e.target.checked)} />
            I saved the backup file
          </label>
        </li>
        <li className="card">
          <h2>Register</h2>
          <p>Sign with wallet A. This shows A is eligible, but not which future claim is yours. Wallet A pays about 0.002 devnet SOL for its registration record.</p>
          <button onClick={doRegister} disabled={!backup || !saved || busy}>{busy ? 'Registering…' : 'Register'}</button>
        </li>
      </ol>
    )

  return (
    <section>
      <h1>Register</h1>
      {campaign && (
        <p className="muted">
          Campaign #{campaign.id.toString()} · {campaign.state} · {campaign.registered}/{campaign.capacity} registered
        </p>
      )}
      {body}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
