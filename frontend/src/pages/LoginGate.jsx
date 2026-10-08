import { useEffect, useState } from 'react'
import { authStatus, requestMagicLink, setToken, setUser } from '../api'

// Wraps sender-only pages. If the backend requires auth and we have no token,
// show an email form that requests a magic sign-in link. Off in dev (authRequired:false).
export default function LoginGate({ children }) {
  const [state, setState] = useState('checking') // checking | open | locked
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    authStatus()
      // Open only when auth is off, or the server confirms the token still verifies.
      // Token *presence* is not proof — a stale one left the app usable-looking but dead.
      .then(s => {
        if (cancelled) return
        if (!s.authRequired) return setState('open')
        if (s.authenticated) { if (s.user) setUser(s.user); return setState('open') }
        setToken(null); setUser(null) // drop the dead token so we don't keep re-testing it
        setState('locked')
      })
      // Fail CLOSED. If we can't establish auth state, showing the prompt is harmless;
      // rendering the app isn't — it 401s on every action with no way back to a login.
      .catch(() => { if (!cancelled) setState('locked') })
    return () => { cancelled = true }
  }, [])

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await requestMagicLink(email)
      setSent(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (state === 'checking') return <div className="card">Loading…</div>
  if (state === 'open') return children

  if (sent) {
    return (
      <div className="card" style={{ maxWidth: 380 }}>
        <h1>Sign in</h1>
        <p>Check your email for a sign-in link.</p>
        <p className="muted">The link works once and expires in 15 minutes.</p>
      </div>
    )
  }

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 380 }}>
      <h1>Sign in</h1>
      <p className="muted">Enter your email and we'll send you a sign-in link.</p>
      <div className="field">
        <label>Email</label>
        <input type="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" />
      </div>
      <button className="btn" disabled={busy || !email}>{busy ? 'Sending…' : 'Email me a link'}</button>
      {error && <p style={{ color: '#dc2626', marginTop: 10 }}>{error}</p>}
    </form>
  )
}
