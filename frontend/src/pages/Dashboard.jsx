import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { senderFetch, downloadVia } from '../api'

const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—')
// linkExpiresAt is epoch ms (not ISO) per the API contract.
const fmtMs = (ms) => (ms ? fmt(new Date(ms).toISOString()) : '—')

export default function Dashboard() {
  const navigate = useNavigate()
  const [docs, setDocs] = useState(null)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  async function load() {
    try {
      const r = await senderFetch('/api/documents').then(r => r.json())
      if (r.error) throw new Error(r.error)
      setDocs(r.documents || [])
    } catch (e) {
      setError(e.message)
    }
  }
  useEffect(() => { load() }, [])

  async function revoke(d) {
    if (!window.confirm(`Revoke the signing link for "${d.filename}"? The signer's link will stop working. You can re-send it later.`)) return
    setBusyId(d.id); setError(null)
    try {
      const r = await senderFetch(`/api/documents/${d.id}/revoke`, { method: 'POST' }).then(r => r.json())
      if (r.error) throw new Error(r.error)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  async function download(d, kind) {
    setBusyId(d.id); setError(null)
    try {
      await downloadVia(`/api/documents/${d.id}/${kind}`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  const th = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, fontSize: 13 }
  const td = { padding: '8px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 14, verticalAlign: 'top' }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>My documents</h1>
        <Link to="/new" className="btn" style={{ textDecoration: 'none' }}>New document</Link>
      </div>

      {error && <div className="card" style={{ borderColor: '#dc2626', color: '#dc2626', marginTop: 16 }}>{error}</div>}

      <div className="card" style={{ marginTop: 16, overflowX: 'auto' }}>
        {docs === null && !error && <p className="muted">Loading…</p>}
        {docs && docs.length === 0 && <p className="muted">No documents yet. Start with “New document”.</p>}
        {docs && docs.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Document</th><th style={th}>Signer</th><th style={th}>Status</th>
                <th style={th}>Sent</th><th style={th}>Signed / link expires</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map(d => (
                <tr key={d.id}>
                  <td style={td}>{d.filename}</td>
                  <td style={td}>{d.signerEmail || '—'}</td>
                  <td style={td}>{d.status}</td>
                  <td style={td}>{fmt(d.sentAt)}</td>
                  <td style={td}>
                    {d.status === 'signed' ? fmt(d.signedAt)
                      : d.status === 'sent' ? <>expires {fmtMs(d.linkExpiresAt)}</>
                      : d.status === 'revoked' ? <>revoked {fmt(d.revokedAt)}</>
                      : '—'}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {(d.status === 'uploaded' || d.status === 'revoked') && (
                      <button className="btn btn-secondary" onClick={() => navigate(`/prepare/${d.id}`)}>Continue</button>
                    )}
                    {d.status === 'sent' && (
                      <button className="btn btn-secondary" disabled={busyId === d.id} onClick={() => revoke(d)}>Revoke</button>
                    )}
                    {d.status === 'signed' && (
                      <>
                        <button className="btn btn-secondary" disabled={busyId === d.id} onClick={() => download(d, 'signed')}>Download signed</button>{' '}
                        <button className="btn btn-secondary" disabled={busyId === d.id} onClick={() => download(d, 'evidence')}>Download evidence</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
