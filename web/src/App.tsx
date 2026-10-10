import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useState } from 'react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { CAMPAIGN_ID, switchCampaign } from './config'
import Admin from './pages/Admin'
import Register from './pages/Register'
import Claim from './pages/Claim'
import Explorer from './pages/Explorer'

function CampaignSwitch() {
  const [text, setText] = useState(CAMPAIGN_ID.toString())
  const valid = /^\d+$/.test(text.trim()) && text.trim() !== CAMPAIGN_ID.toString()
  return (
    <form
      className="campaign-switch"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) switchCampaign(BigInt(text.trim()))
      }}
    >
      <label>
        <span className="muted">Campaign #</span>
        <input type="text" className="mono" size={11} value={text} onChange={(e) => setText(e.target.value)} aria-label="Campaign id" />
      </label>
      {valid && <button type="submit">Open</button>}
    </form>
  )
}

export default function App() {
  return (
    <div className="app">
      <header>
        <b className="logo"><img src="/logo.svg" alt="" width="26" height="26" />zkClaim</b>
        <nav>
          <NavLink to="/register">Register</NavLink>
          <NavLink to="/claim">Claim</NavLink>
          <NavLink to="/explorer">Explorer</NavLink>
          <NavLink to="/admin">Admin</NavLink>
        </nav>
        <CampaignSwitch />
        <WalletMultiButton />
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/register" />} />
          <Route path="/register" element={<Register />} />
          <Route path="/claim" element={<Claim />} />
          <Route path="/explorer" element={<Explorer />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </main>
    </div>
  )
}
