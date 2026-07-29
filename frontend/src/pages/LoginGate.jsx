import { useEffect, useState } from 'react'
import { authStatus, login, getToken } from '../api'

// Wraps sender-only pages. If the backend requires auth and we have no token,
// show a password prompt. Off entirely in dev (backend reports authRequired:false).
export default function LoginGate({ children }) {
  const [state, setState] = useState('checking') // checking | open | locked
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    authStatus()
      .then(s => { if (!cancelled) setState(!s.authRequired || getToken() ? 'open' : 'locked') })
      .catch(() => { if (!cancelled) setState('open') }) // fail open in dev if status endpoint unreachable
    return () => { cancelled = true }
  }, [])

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await login(password)
      setState('open')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (state === 'checking') return <div className="card">Loading…</div>
  if (state === 'open') return children

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 380 }}>
      <h1>Sign in</h1>
      <p className="muted">Enter the sender password to prepare and send documents.</p>
      <div className="field">
        <label>Password</label>
        <input type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)} required />
      </div>
      <button className="btn" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p style={{ color: '#dc2626', marginTop: 10 }}>{error}</p>}
    </form>
  )
}
