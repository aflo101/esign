import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import Upload from './pages/Upload'
import Prepare from './pages/Prepare'
import Sign from './pages/Sign'
import Done from './pages/Done'
import LoginGate from './pages/LoginGate'
import Dashboard from './pages/Dashboard'
import LoginToken from './pages/LoginToken'
import { getToken, getUser, signOut } from './api'

// Shown only for a sender session; signer pages have no token so the bar stays empty.
function SenderBar() {
  const user = getUser()
  if (!getToken()) return null
  return (
    <span className="muted">
      {user?.name || user?.email}{' '}
      <button className="btn btn-secondary" style={{ padding: '4px 10px', marginLeft: 8 }} onClick={signOut}>Sign out</button>
    </span>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #ddd', paddingBottom: 12, marginBottom: 24 }}>
          <Link to="/" style={{ textDecoration: 'none', color: '#222', fontWeight: 600 }}>esign</Link>
          <SenderBar />
        </header>
        <Routes>
          <Route path="/" element={<LoginGate><Dashboard /></LoginGate>} />
          <Route path="/new" element={<LoginGate><Upload /></LoginGate>} />
          <Route path="/login/:token" element={<LoginToken />} />
          <Route path="/prepare/:id" element={<LoginGate><Prepare /></LoginGate>} />
          {/* /s/ is the emailed link — short, opaque token. /sign/ kept as an alias
              so any link issued before the token change still resolves. */}
          <Route path="/s/:token" element={<Sign />} />
          <Route path="/sign/:token" element={<Sign />} />
          <Route path="/done" element={<Done />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
