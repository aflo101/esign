import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authHeaders } from '../api'

export default function Upload() {
  const navigate = useNavigate()
  const [file, setFile] = useState(null)
  const [senderEmail, setSenderEmail] = useState('')
  const [signerEmail, setSignerEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('sender_email', senderEmail)
      const up = await fetch('/api/documents', { method: 'POST', headers: authHeaders(), body: fd }).then(r => r.json())
      if (up.error) throw new Error(up.error)
      // Hand off to the Prepare step (place fields, then send) — carry the emails forward.
      navigate(`/prepare/${up.id}`, {
        state: { sender_email: senderEmail, signer_email: signerEmail, filename: up.filename },
      })
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div>
      <h1>Send a document for signature</h1>
      <p className="muted">Upload a PDF, then place the fields your signer needs to complete.</p>
      <form className="card" onSubmit={submit}>
        <div className="field">
          <label>PDF document</label>
          <input type="file" accept="application/pdf" onChange={e => setFile(e.target.files[0])} required />
        </div>
        <div className="field">
          <label>Your email (sender)</label>
          <input type="email" value={senderEmail} onChange={e => setSenderEmail(e.target.value)} required placeholder="you@example.com" />
        </div>
        <div className="field">
          <label>Signer's email</label>
          <input type="email" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} required placeholder="signer@example.com" />
        </div>
        <button className="btn" disabled={busy || !file}>{busy ? 'Uploading…' : 'Upload & prepare'}</button>
      </form>

      {error && <div className="card" style={{ borderColor: '#dc2626', color: '#dc2626' }}>{error}</div>}
    </div>
  )
}
