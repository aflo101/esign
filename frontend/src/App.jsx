import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import Upload from './pages/Upload'
import Prepare from './pages/Prepare'
import Sign from './pages/Sign'
import Done from './pages/Done'
import LoginGate from './pages/LoginGate'

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <header style={{ borderBottom: '1px solid #ddd', paddingBottom: 12, marginBottom: 24 }}>
          <Link to="/" style={{ textDecoration: 'none', color: '#222', fontWeight: 600 }}>esign</Link>
        </header>
        <Routes>
          <Route path="/" element={<LoginGate><Upload /></LoginGate>} />
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
