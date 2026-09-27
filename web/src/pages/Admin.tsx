import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { CAMPAIGN_ID, explorerTx } from '../config'
import * as api from '../api'
import type { CampaignInfo } from '../api'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const short = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s)

function parseWallets(text: string) {
  const valid: PublicKey[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[\s,]+/)) {
    const s = raw.trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    try {
      valid.push(new PublicKey(s))
    } catch {
      invalid.push(s)
    }
  }
  return { valid, invalid }
}

function parseAmount(s: string): bigint | null {
  return /^\d+$/.test(s.trim()) && BigInt(s.trim()) > 0n ? BigInt(s.trim()) : null
}

export default function Admin() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const ctx = { connection, wallet }

  const [campaign, setCampaign] = useState<CampaignInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<{ text: string; sig?: string; error?: boolean }[]>([])

  const [mintText, setMintText] = useState('')
  const [amountText, setAmountText] = useState('100')
  const [walletsText, setWalletsText] = useState('')
  const [fundText, setFundText] = useState('')
  const [confirmFreeze, setConfirmFreeze] = useState(false)

  const reload = () => api.getCampaign(connection, CAMPAIGN_ID).then(setCampaign).catch((e) => note(msg(e), undefined, true))
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection])

  function note(text: string, sig?: string, error?: boolean) {
    setLog((l) => [{ text, sig, error }, ...l])
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      note(`${label} failed: ${msg(e)}`, undefined, true)
    } finally {
      setBusy(null)
      reload()
    }
  }

  const mint = useMemo(() => {
    try {
      return new PublicKey(mintText.trim())
    } catch {
      return null
    }
  }, [mintText])
  const amount = parseAmount(amountText)
  const fund = parseAmount(fundText)
  const parsed = useMemo(() => parseWallets(walletsText), [walletsText])
  const batches = Math.ceil(parsed.valid.length / api.ELIGIBLE_BATCH)

  const connected = !!wallet.publicKey
  const isAdmin = !campaign || !api.LIVE.admin || campaign.admin === wallet.publicKey?.toBase58()
  const registering = campaign?.state === 'Registering'
  const claimsCovered = campaign && campaign.amount > 0n ? campaign.vaultBalance / campaign.amount : 0n

  const addWallets = () =>
    run('Add eligible', async () => {
      const list = parsed.valid
      for (let i = 0; i < list.length; i += api.ELIGIBLE_BATCH) {
        const chunk = list.slice(i, i + api.ELIGIBLE_BATCH)
        setBusy(`Add eligible: tx ${i / api.ELIGIBLE_BATCH + 1}/${batches}`)
        const sig = await api.addEligible(ctx, CAMPAIGN_ID, chunk)
        note(`Added ${chunk.length} eligible wallets (tx ${i / api.ELIGIBLE_BATCH + 1}/${batches})`, sig)
      }
      setWalletsText('')
    })

  return (
    <section>
      <h1>Admin</h1>
      {!api.LIVE.admin && <p className="note">Admin actions are still mocks: freeze via scripts/claim-cli.ts. The numbers above are live.</p>}
      {!connected && <div className="card">Connect the admin wallet.</div>}
      {connected && !isAdmin && <div className="card warn">This wallet is not the campaign admin.</div>}

      {campaign && (
        <div className="card stats">
          <div><span className="muted">Campaign</span><b>#{campaign.id.toString()}</b></div>
          <div><span className="muted">State</span><b className={registering ? '' : 'rejected'}>{campaign.state}</b></div>
          <div><span className="muted">Per claim</span><b>{api.fmtTokens(campaign.amount, campaign.decimals)}</b></div>
          <div><span className="muted">Registered</span><b>{campaign.registered}/{campaign.capacity}</b></div>
          <div><span className="muted">Vault</span><b>{api.fmtTokens(campaign.vaultBalance, campaign.decimals)}</b></div>
          <div><span className="muted">Covers</span><b>{claimsCovered.toString()} claims</b></div>
          <div className="full"><span className="muted">Mint</span><span className="mono">{campaign.mint}</span></div>
          <div className="full">
            <span className="muted">{registering ? 'Current root (computed on-chain)' : 'Frozen root (computed on-chain)'}</span>
            <span className="mono">{short(campaign.root)}</span>
          </div>
        </div>
      )}

      {connected && isAdmin && (
        <ol className="steps">
          <li className="card">
            <h2>Create campaign</h2>
            <p>Creates the campaign, an empty Merkle tree and a vault owned by the program.</p>
            <input type="text" className="wide mono" placeholder="Token mint address" value={mintText} onChange={(e) => setMintText(e.target.value)} />
            <input type="text" className="mono" placeholder="Amount per claim (base units)" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            <button
              style={{ marginLeft: 12 }}
              disabled={!mint || !amount || !!busy}
              onClick={() => run('Create campaign', async () => note(`Campaign #${CAMPAIGN_ID} created`, await api.createCampaign(ctx, CAMPAIGN_ID, mint!, amount!)))}
            >
              {busy === 'Create campaign' ? 'Creating…' : `Create campaign #${CAMPAIGN_ID}`}
            </button>
            {mintText && !mint && <p className="error">Not a valid mint address.</p>}
          </li>

          <li className="card">
            <h2>Add eligible wallets</h2>
            <p>One address per line. Sent in batches of {api.ELIGIBLE_BATCH} per transaction. Publish this list and where it came from, so anyone can audit it.</p>
            <textarea rows={6} className="wide mono" placeholder={'Wallet1…\nWallet2…'} value={walletsText} onChange={(e) => setWalletsText(e.target.value)} disabled={!registering} />
            <button disabled={!registering || parsed.valid.length === 0 || parsed.invalid.length > 0 || !!busy} onClick={addWallets}>
              {busy?.startsWith('Add eligible') ? busy : `Add ${parsed.valid.length} wallets (${batches} tx)`}
            </button>
            {parsed.invalid.length > 0 && <p className="error">Invalid: {parsed.invalid.slice(0, 3).join(', ')}{parsed.invalid.length > 3 ? '…' : ''}</p>}
          </li>

          <li className="card">
            <h2>Fund the vault</h2>
            <p>Transfers tokens from your wallet into the vault. Claims pay out from here.</p>
            <input type="text" className="mono" placeholder="Amount (base units)" value={fundText} onChange={(e) => setFundText(e.target.value)} />
            {campaign && (
              <button className="link" style={{ marginLeft: 12 }} onClick={() => setFundText((campaign.amount * BigInt(Math.max(campaign.registered, 1))).toString())}>
                amount × registered
              </button>
            )}
            <button
              disabled={!fund || !!busy}
              onClick={() => run('Fund vault', async () => { note(`Vault funded with ${fund}`, await api.fundVault(ctx, CAMPAIGN_ID, fund!)); setFundText('') })}
            >
              {busy === 'Fund vault' ? 'Funding…' : 'Fund vault'}
            </button>
          </li>

          <li className="card">
            <h2>Freeze</h2>
            <p>Locks the root the program computed. Registration closes and claims open. This cannot be undone.</p>
            <label>
              <input type="checkbox" checked={confirmFreeze} onChange={(e) => setConfirmFreeze(e.target.checked)} disabled={!registering} />
              I understand no one can register after this
            </label>
            <br />
            <button
              style={{ marginTop: 12 }}
              disabled={!registering || !confirmFreeze || !!busy}
              onClick={() => run('Freeze', async () => { note('Campaign frozen: claims are open', await api.freeze(ctx, CAMPAIGN_ID)); setConfirmFreeze(false) })}
            >
              {busy === 'Freeze' ? 'Freezing…' : 'Freeze'}
            </button>
          </li>
        </ol>
      )}

      {!api.LIVE.campaign && (
        <div className="card">
          <h2>Mock tools</h2>
          <p>Resets the fake campaign back to Registering. Only exists in demo mode.</p>
          <button onClick={() => { api.mockReset(); setLog([]); reload() }}>Reset mock campaign</button>
        </div>
      )}

      {log.length > 0 && (
        <ul className="attacks">
          {log.map((l, i) => (
            <li key={i} className={l.error ? 'error' : 'rejected'}>
              {l.text}{' '}
              {l.sig && <a href={explorerTx(l.sig)} target="_blank" rel="noreferrer">tx ↗</a>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
