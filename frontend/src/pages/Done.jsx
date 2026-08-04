import { useState } from 'react'
import { useLocation, Link } from 'react-router-dom'

export default function Done() {
  const loc = useLocation()
  const { signed_hash, token } = loc.state || {}
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  // Downloads are presigned S3 URLs fetched on demand, not direct hrefs to the API —
  // the files never stream through the backend, and the URLs are short-lived so they
  // can't be minted into the page and shared later.
  async function download(kind) {
    setBusy(kind); setError(null)
    try {
      const r = await fetch(`/api/sign/${token}/${kind}`).then(r => r.json())
      if (r.error) throw new Error(r.error)
      window.location.href = r.url
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="card">
      <h1>Signed</h1>
      <p>The document has been signed and emailed to both parties.</p>
      {signed_hash && <p className="muted">Signed SHA-256: {signed_hash}</p>}
      {token && (
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn" disabled={!!busy} onClick={() => download('signed')}>
            {busy === 'signed' ? 'Preparing…' : 'Download signed PDF'}
          </button>
          <button className="btn btn-secondary" disabled={!!busy} onClick={() => download('evidence')}>
            {busy === 'evidence' ? 'Preparing…' : 'Download evidence'}
          </button>
        </div>
      )}
      {error && <p style={{ color: '#dc2626', marginTop: 12 }}>{error}</p>}
      <p style={{ marginTop: 16 }}><Link to="/">Send another</Link></p>
    </div>
  )
}
