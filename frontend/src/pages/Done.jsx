import { useLocation, Link } from 'react-router-dom'

export default function Done() {
  const loc = useLocation()
  const { signed_hash, token } = loc.state || {}
  return (
    <div className="card">
      <h1>Signed</h1>
      <p>The document has been signed and emailed to both parties.</p>
      {signed_hash && <p className="muted">Signed SHA-256: {signed_hash}</p>}
      {token && (
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <a className="btn" href={`/api/sign/${token}/signed`} target="_blank" rel="noreferrer">Download signed PDF</a>
          <a className="btn btn-secondary" href={`/api/sign/${token}/evidence`} target="_blank" rel="noreferrer">Download evidence</a>
        </div>
      )}
      <p style={{ marginTop: 16 }}><Link to="/">Send another</Link></p>
    </div>
  )
}
