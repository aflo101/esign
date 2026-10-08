import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { verifyLoginToken } from '../api'

// Landing page for the emailed magic link. Not behind LoginGate — it's what creates the session.
//
// The token is consumed on a button CLICK, never on page load. Mail scanners (Microsoft
// Defender Safe Links, observed 2026-10-08) open links in a sandbox browser that runs
// JavaScript: verifying on mount let the scanner spend the single-use token, and the real
// user then hit "invalid or expired". Scanners load pages; they don't click buttons.
export default function LoginToken() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function signIn() {
    setBusy(true); setError(null)
    try {
      await verifyLoginToken(token)
      navigate('/', { replace: true })
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 380 }}>
      <h1>Sign in</h1>
      {error ? (
        <>
          <p style={{ color: '#dc2626' }}>{error}</p>
          <Link to="/">Request a new link</Link>
        </>
      ) : (
        <>
          <p className="muted">Click below to finish signing in.</p>
          <button className="btn" disabled={busy} onClick={signIn}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </>
      )}
    </div>
  )
}
