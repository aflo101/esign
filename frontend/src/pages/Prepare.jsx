import { useEffect, useRef, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { authHeaders } from '../api'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// Field catalog: label + default normalized size (top-left origin, 0-1).
const FIELD_DEFS = {
  signature: { label: 'Signature', w: 0.26, h: 0.07 },
  initials:  { label: 'Initials',  w: 0.10, h: 0.06 },
  date:      { label: 'Date',      w: 0.16, h: 0.035 },
  name:      { label: 'Name',      w: 0.20, h: 0.035 },
  text:      { label: 'Text',      w: 0.20, h: 0.035 },
  checkbox:  { label: 'Checkbox',  w: 0.03, h: 0.022 },
}
const PALETTE = Object.keys(FIELD_DEFS)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const RENDER_SCALE = 1.3

export default function Prepare() {
  const { id } = useParams()
  const location = useLocation()
  const nav = location.state || {}

  const pdfRef = useRef(null)
  const [numPages, setNumPages] = useState(0)
  const [fields, setFields] = useState([])           // {id,type,page,x,y,w,h,required}
  const [activePage, setActivePage] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [signerEmail, setSignerEmail] = useState(nav.signer_email || '')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sentLink, setSentLink] = useState(null)

  // Load the PDF + any previously-saved fields
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ url: `/api/documents/${id}/pdf`, httpHeaders: authHeaders() }).promise
        if (cancelled) return
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        const saved = await fetch(`/api/documents/${id}/fields`, { headers: authHeaders() }).then(r => r.json())
        if (!cancelled && saved.fields?.length) {
          setFields(saved.fields.map(f => ({ ...f, id: crypto.randomUUID() })))
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
  }, [id])

  function addField(type) {
    const def = FIELD_DEFS[type]
    const f = {
      id: crypto.randomUUID(), type, page: activePage,
      x: 0.35, y: 0.4, w: def.w, h: def.h, required: true,
    }
    setFields(prev => [...prev, f])
    setSelectedId(f.id)
  }
  const updateField = (fid, patch) => setFields(prev => prev.map(f => (f.id === fid ? { ...f, ...patch } : f)))
  const removeField = (fid) => { setFields(prev => prev.filter(f => f.id !== fid)); setSelectedId(null) }

  async function saveAndSend() {
    setError(null)
    if (!signerEmail) return setError('Signer email is required')
    if (!fields.length) return setError('Add at least one field before sending')
    setBusy(true)
    try {
      const payload = {
        fields: fields.map((f, i) => ({
          type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
          required: f.required, sort_order: i,
        })),
      }
      const put = await fetch(`/api/documents/${id}/fields`, {
        method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      }).then(r => r.json())
      if (put.error) throw new Error(put.error)
      const send = await fetch(`/api/documents/${id}/send`, {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ signer_email: signerEmail }),
      }).then(r => r.json())
      if (send.error) throw new Error(send.error)
      setSentLink(send.link)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (error && !numPages) return <div className="card" style={{ color: '#dc2626' }}>{error}</div>
  if (!numPages) return <div className="card">Loading document…</div>

  if (sentLink) {
    return (
      <div className="card">
        <h1>Sent for signature</h1>
        <p className="muted">{fields.length} field{fields.length === 1 ? '' : 's'} placed · signer: {signerEmail}</p>
        <p>Signing link (also logged to the backend console in dev):</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{sentLink}</pre>
        <a className="btn" href={sentLink}>Open signing link</a>
      </div>
    )
  }

  return (
    <div>
      <h1>Prepare: {nav.filename || 'document'}</h1>
      <p className="muted">Click a field type to drop it on the active page, then drag to position and resize.</p>

      {/* Field palette */}
      <div className="card" style={{ position: 'sticky', top: 8, zIndex: 20, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <strong style={{ marginRight: 4 }}>Add field:</strong>
        {PALETTE.map(type => (
          <button key={type} className="btn btn-secondary" type="button" onClick={() => addField(type)}>
            + {FIELD_DEFS[type].label}
          </button>
        ))}
        <span className="muted" style={{ marginLeft: 'auto' }}>Active page: {activePage + 1} / {numPages}</span>
      </div>

      {/* Pages */}
      {Array.from({ length: numPages }, (_, i) => (
        <PdfPage
          key={i}
          pdf={pdfRef.current}
          index={i}
          isActive={i === activePage}
          fields={fields.filter(f => f.page === i)}
          selectedId={selectedId}
          onActivate={() => setActivePage(i)}
          onSelect={setSelectedId}
          onUpdate={updateField}
          onRemove={removeField}
        />
      ))}

      {/* Send bar */}
      <div className="card" style={{ position: 'sticky', bottom: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 220, margin: 0 }}>
          <label>Signer's email</label>
          <input type="email" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} placeholder="signer@example.com" />
        </div>
        <div className="muted">{fields.length} field{fields.length === 1 ? '' : 's'}</div>
        <button className="btn" type="button" disabled={busy} onClick={saveAndSend}>
          {busy ? 'Sending…' : 'Send for signature'}
        </button>
      </div>

      {error && <div className="card" style={{ borderColor: '#dc2626', color: '#dc2626' }}>{error}</div>}
    </div>
  )
}

function PdfPage({ pdf, index, isActive, fields, selectedId, onActivate, onSelect, onUpdate, onRemove }) {
  const canvasRef = useRef(null)
  const boxRef = useRef(null)
  const gesture = useRef(null) // { mode, id, startX, startY, orig }
  const [dims, setDims] = useState(null)

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    let task
    ;(async () => {
      const page = await pdf.getPage(index + 1)
      if (cancelled) return
      const viewport = page.getViewport({ scale: RENDER_SCALE })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      setDims({ w: viewport.width, h: viewport.height })
      task = page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas })
      try { await task.promise } catch { /* render cancelled */ }
    })()
    return () => { cancelled = true; if (task) task.cancel() }
  }, [pdf, index])

  function rect() { return boxRef.current.getBoundingClientRect() }

  function beginGesture(mode, f, e) {
    e.stopPropagation()
    onActivate(); onSelect(f.id)
    gesture.current = { mode, id: f.id, startX: e.clientX, startY: e.clientY, orig: { ...f } }
    boxRef.current.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    const g = gesture.current
    if (!g) return
    const r = rect()
    const dx = (e.clientX - g.startX) / r.width
    const dy = (e.clientY - g.startY) / r.height
    const o = g.orig
    if (g.mode === 'move') {
      onUpdate(g.id, { x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.h) })
    } else {
      onUpdate(g.id, { w: clamp(o.w + dx, 0.02, 1 - o.x), h: clamp(o.h + dy, 0.015, 1 - o.y) })
    }
  }
  function endGesture(e) {
    if (gesture.current && boxRef.current.hasPointerCapture?.(e.pointerId)) {
      boxRef.current.releasePointerCapture(e.pointerId)
    }
    gesture.current = null
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="muted" style={{ marginBottom: 6 }}>Page {index + 1}{isActive ? ' · active' : ''}</div>
      <div
        ref={boxRef}
        onPointerDown={() => onActivate()}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        style={{
          position: 'relative', display: 'inline-block', lineHeight: 0,
          border: isActive ? '2px solid #2563eb' : '1px solid #ddd', touchAction: 'none',
          maxWidth: '100%',
        }}
      >
        <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
        {dims && fields.map(f => {
          const selected = f.id === selectedId
          return (
            <div
              key={f.id}
              onPointerDown={(e) => beginGesture('move', f, e)}
              style={{
                position: 'absolute',
                left: `${f.x * 100}%`, top: `${f.y * 100}%`,
                width: `${f.w * 100}%`, height: `${f.h * 100}%`,
                boxSizing: 'border-box',
                border: `1.5px solid ${selected ? '#2563eb' : '#60a5fa'}`,
                background: 'rgba(37,99,235,0.10)',
                cursor: 'move', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, color: '#1e3a8a', fontFamily: 'system-ui, sans-serif',
                userSelect: 'none', overflow: 'hidden', lineHeight: 1.1,
              }}
              title={`${FIELD_DEFS[f.type].label}${f.required ? ' (required)' : ''}`}
            >
              <span style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>{FIELD_DEFS[f.type].label}</span>
              {selected && (
                <>
                  <button
                    type="button"
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onRemove(f.id) }}
                    style={{
                      position: 'absolute', top: -10, right: -10, width: 20, height: 20, borderRadius: '50%',
                      border: 'none', background: '#dc2626', color: '#fff', fontSize: 12, lineHeight: '20px',
                      cursor: 'pointer', padding: 0,
                    }}
                    aria-label="Remove field"
                  >×</button>
                  <span
                    onPointerDown={(e) => beginGesture('resize', f, e)}
                    style={{
                      position: 'absolute', right: -6, bottom: -6, width: 12, height: 12,
                      background: '#2563eb', border: '2px solid #fff', borderRadius: 2, cursor: 'nwse-resize',
                    }}
                  />
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
