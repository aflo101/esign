import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { verifyLoginToken } from '../api'

// Landing page for the emailed magic link. Not behind LoginGate — it's what creates the session.
export default function LoginToken() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    verifyLoginToken(token)
      .then(() => navigate('/', { replace: true }))
      .catch(e => setError(e.message))
  }, [token, navigate])

  if (error) {
    return (
      <div className="card" style={{ maxWidth: 380 }}>
        <h1>Sign in</h1>
        <p style={{ color: '#dc2626' }}>{error}</p>
        <Link to="/">Request a new link</Link>
      </div>
    )
  }
  return <div className="card">Signing you in…</div>
}
