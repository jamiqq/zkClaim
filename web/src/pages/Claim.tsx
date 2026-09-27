import { type ChangeEvent, useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Keypair, PublicKey } from '@solana/web3.js'
import { CAMPAIGN_ID, PROOF_BYTES, explorerTx } from '../config'
import * as api from '../api'
import type { CampaignInfo } from '../api'
import { type Backup, listLocal, parseBackup } from '../lib/secret'
import { buildInput, nullifierOf, prove, proverAvailable, recipientLimbs } from '../lib/zk'

type Proved = { proof: Uint8Array; nullifier: bigint; recipient: PublicKey; ms: number; mock: boolean }
type Stage = 'idle' | 'path' | 'proving' | 'sending'
type AttackResult = { name: string; ok: boolean; detail: string }

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
function friendly(m: string) {
  if (/already in use|already claimed/i.test(m)) return 'Already claimed: this nullifier is already on-chain.'
  if (/ProofInvalid/i.test(m)) return 'Proof rejected by the program (ProofInvalid).'
  if (/NotFrozen/i.test(m)) return 'Claims are not open yet: the campaign is not frozen.'
  return m
}

export default function Claim() {
  const { connection } = useConnection()
  const { publicKey } = useWallet()

  const [campaign, setCampaign] = useState<CampaignInfo | null>(null)
  const [hasProver, setHasProver] = useState<boolean | null>(null)
  const [backup, setBackup] = useState<Backup | null>(null)
  const [recipientText, setRecipientText] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [proved, setProved] = useState<Proved | null>(null)
  const [sig, setSig] = useState<string | null>(null)
  const [attacks, setAttacks] = useState<AttackResult[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = () => api.getCampaign(connection, CAMPAIGN_ID).then(setCampaign).catch((e) => setError(msg(e)))
  useEffect(() => {
    reload()
    proverAvailable().then(setHasProver)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection])

  const localBackups = useMemo(() => listLocal(CAMPAIGN_ID.toString()), [])

  const recipient = useMemo(() => {
    try {
      const pk = new PublicKey(recipientText.trim())
      return PublicKey.isOnCurve(pk.toBytes()) ? pk : null
    } catch {
      return null
    }
  }, [recipientText])

  const linked =
    recipient && backup && (recipient.toBase58() === backup.wallet || (publicKey && recipient.equals(publicKey)))

  function resetResult() {
    setProved(null)
    setSig(null)
    setAttacks([])
    setError(null)
  }

  async function pickBackup(b: Backup) {
    resetResult()
    if (b.campaignId !== CAMPAIGN_ID.toString()) {
      setError(`This backup is for campaign #${b.campaignId}, not #${CAMPAIGN_ID}.`)
      return
    }
    setBackup(b)
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      await pickBackup(await parseBackup(await f.text()))
    } catch (err) {
      setError(msg(err))
    }
  }

  async function doProve() {
    if (!backup || !recipient) return
    resetResult()
    try {
      const secret = BigInt(backup.secret)
      setStage('path')
      const path = await api.getMerklePath(connection, CAMPAIGN_ID, BigInt(backup.commitment))
      const nullifier = await nullifierOf(secret, CAMPAIGN_ID)
      setStage('proving')
      if (hasProver) {
        const r = await prove(buildInput({ secret, campaignId: CAMPAIGN_ID, recipient, path, nullifier }))
        const { hi, lo } = recipientLimbs(recipient)
        const expected = [path.root, nullifier, hi, lo, CAMPAIGN_ID].map(String)
        if (r.publicSignals.join() !== expected.join()) {
          throw new Error('Public signals do not match the expected order (root, nullifier, hi, lo, campaign_id)')
        }
        setProved({ proof: r.proof, nullifier, recipient, ms: r.ms, mock: false })
      } else {
        await new Promise((r) => setTimeout(r, 1500))
        const proof = crypto.getRandomValues(new Uint8Array(PROOF_BYTES))
        setProved({ proof, nullifier, recipient, ms: 1500, mock: true })
      }
    } catch (e) {
      setError(msg(e))
    } finally {
      setStage('idle')
    }
  }

  async function doSend() {
    if (!proved) return
    setStage('sending')
    setError(null)
    try {
      setSig(await api.submitClaim({ ...proved, campaignId: CAMPAIGN_ID }))
    } catch (e) {
      setError(friendly(msg(e)))
    } finally {
      setStage('idle')
    }
  }

  // Demo step 5 (spec 9): both must fail
  async function attack(name: string, recipientOverride?: PublicKey) {
    if (!proved) return
    setStage('sending')
    try {
      await api.submitClaim({ ...proved, recipient: recipientOverride ?? proved.recipient, campaignId: CAMPAIGN_ID })
      setAttacks((a) => [...a, { name, ok: false, detail: 'Accepted — this should NOT happen' }])
    } catch (e) {
      setAttacks((a) => [...a, { name, ok: true, detail: friendly(msg(e)) }])
    } finally {
      setStage('idle')
    }
  }

  const busy = stage !== 'idle'
  const frozen = campaign?.state === 'Frozen'

  return (
    <section>
      <h1>Claim</h1>
      {api.MOCK && <p className="note">Demo mode: mock data, nothing is sent on-chain yet.</p>}
      {hasProver === false && (
        <p className="note">Prover files not found in /zk/ — using a mock proof until P1 ships zkclaim.wasm + zkey.</p>
      )}
      {campaign && (
        <p className="muted">
          Campaign #{campaign.id.toString()} · {campaign.state} · {campaign.amount.toString()} tokens per claim
        </p>
      )}

      {campaign && !frozen && (
        <div className="card">
          <p>Claims open after the admin freezes the tree.</p>
          {api.MOCK && (
            <button onClick={() => { api.mockSetState('Frozen'); reload() }}>Simulate freeze (mock)</button>
          )}
        </div>
      )}

      {frozen && (
        <ol className="steps">
          <li className="card">
            <h2>1. Load your backup</h2>
            <p>The .zkclaim file you saved when you registered. It stays in this browser.</p>
            <input type="file" accept=".zkclaim,application/json" onChange={onFile} disabled={busy} />
            {localBackups.length > 0 && !backup && (
              <p style={{ marginTop: 10 }}>
                Or use one saved in this browser:{' '}
                {localBackups.map((b) => (
                  <button key={b.commitment} className="link" onClick={() => pickBackup(b)}>
                    {b.commitment.slice(0, 10)}…
                  </button>
                ))}
              </p>
            )}
            {backup && <p className="mono">commitment {backup.commitment.slice(0, 10)}…{backup.commitment.slice(-8)} ✓</p>}
          </li>

          <li className="card">
            <h2>2. Recipient wallet (B)</h2>
            <p>Use a fresh address that has never touched your eligible wallet. It needs no SOL: the relayer pays.</p>
            <input
              type="text"
              className="wide mono"
              placeholder="Fresh Solana address"
              value={recipientText}
              onChange={(e) => { setRecipientText(e.target.value); resetResult() }}
              disabled={busy}
            />
            <button className="link" onClick={() => { setRecipientText(Keypair.generate().publicKey.toBase58()); resetResult() }}>
              random address (demo)
            </button>
            {recipientText && !recipient && <p className="error">Not a valid wallet address.</p>}
            {linked && <p className="warn">This is your eligible wallet. Claiming here links you to the reward.</p>}
          </li>

          <li className="card">
            <h2>3. Generate the proof</h2>
            <p>Runs on this device. Your secret is never sent anywhere.</p>
            <p className="muted small">Tip: don’t claim right after the freeze. A random delay makes timing harder to link.</p>
            <button onClick={doProve} disabled={!backup || !recipient || busy}>
              {stage === 'path' ? 'Reading the tree…' : stage === 'proving' ? 'Proving…' : 'Generate proof'}
            </button>
            {proved && (
              <p className="mono">
                proof ready in {(proved.ms / 1000).toFixed(1)}s{proved.mock ? ' (mock)' : ''} · nullifier{' '}
                {proved.nullifier.toString(16).slice(0, 10)}…
              </p>
            )}
          </li>

          <li className="card">
            <h2>4. Send to the relayer</h2>
            <p>The relayer pays the fee and creates B’s token account. It only sees the proof, nullifier and B.</p>
            <button onClick={doSend} disabled={!proved || busy || !!sig}>
              {stage === 'sending' && !sig ? 'Sending…' : 'Claim'}
            </button>
          </li>
        </ol>
      )}

      {sig && proved && (
        <div className="card ok">
          <h2>Claimed</h2>
          <p>
            {campaign?.amount.toString()} tokens sent to <span className="mono">{proved.recipient.toBase58()}</span>
          </p>
          <a href={explorerTx(sig)} target="_blank" rel="noreferrer">View transaction ↗</a>

          <h2 style={{ marginTop: 20 }}>Attack demo</h2>
          <p>Both of these must be rejected.</p>
          <button onClick={() => attack('Replay the same proof')} disabled={busy}>Replay same proof</button>
          <button onClick={() => attack('Swap the recipient', Keypair.generate().publicKey)} disabled={busy}>
            Swap recipient
          </button>
          <ul className="attacks">
            {attacks.map((a, i) => (
              <li key={i} className={a.ok ? 'rejected' : 'error'}>
                {a.ok ? '✗ Rejected' : '⚠'} · {a.name}: {a.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  )
}
