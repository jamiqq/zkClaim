import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import Admin from './pages/Admin'
import Register from './pages/Register'
import Claim from './pages/Claim'
import Explorer from './pages/Explorer'

export default function App() {
  return (
    <div className="app">
      <header>
        <b className="logo">zkClaim</b>
        <nav>
          <NavLink to="/register">Register</NavLink>
          <NavLink to="/claim">Claim</NavLink>
          <NavLink to="/explorer">Explorer</NavLink>
          <NavLink to="/admin">Admin</NavLink>
        </nav>
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
