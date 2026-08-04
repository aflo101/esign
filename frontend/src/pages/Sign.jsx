import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

const RENDER_SCALE = 1.3
const LABEL = { signature: 'Signature', initials: 'Initials', date: 'Date', name: 'Name', text: 'Text', checkbox: 'Checkbox' }
const today = () => new Date().toISOString().slice(0, 10)

export default function Sign() {
  const { token } = useParams()
  const navigate = useNavigate()
  const pdfRef = useRef(null)
  const fieldEls = useRef({})            // id -> DOM node (for scroll)
  const [meta, setMeta] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [values, setValues] = useState({})   // field_id -> value
  const [editing, setEditing] = useState(null) // field being filled via modal
  const [flash, setFlash] = useState(null)      // field id to highlight
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [consented, setConsented] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const m = await fetch(`/api/sign/${token}`).then(r => r.json())
        if (m.error) throw new Error(m.error)
        if (cancelled) return
        setMeta(m)
        // The API hands back a short-lived presigned S3 URL; bytes come straight from S3.
        const { url, error } = await fetch(`/api/sign/${token}/pdf`).then(r => r.json())
        if (error) throw new Error(error)
        const pdf = await pdfjsLib.getDocument({ url }).promise
        if (cancelled) return
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
  }, [token])

  const fields = meta?.fields || []
  const isFilled = (f) => {
    const v = values[f.id]
    if (f.type === 'checkbox') return v === true
    return typeof v === 'string' ? v.trim().length > 0 : !!v
  }
  const required = fields.filter(f => f.required)
  const remaining = required.filter(f => !isFilled(f))
  const allDone = remaining.length === 0 && fields.length > 0

  function setValue(id, v) { setValues(prev => ({ ...prev, [id]: v })) }

  function clickField(f) {
    if (!consented) return // fields are inert until consent is given
    if (f.type === 'checkbox') return setValue(f.id, !values[f.id])
    if (f.type === 'date') return setValue(f.id, values[f.id] ? '' : today())
    setEditing(f) // signature/initials/name/text → modal
  }

  function goNext() {
    const next = remaining[0]
    if (!next) return
    const el = fieldEls.current[next.id]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlash(next.id)
      setTimeout(() => setFlash(null), 1400)
    }
  }

  async function finish() {
    setSubmitting(true); setError(null)
    try {
      const res = await fetch(`/api/sign/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values, consent: consented }),
      }).then(r => r.json())
      if (res.error) throw new Error(res.error)
      navigate('/done', { state: { signed_hash: res.signed_hash, token } })
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (error && !meta) return <div className="card" style={{ color: '#dc2626' }}>{error}</div>
  if (!meta) return <div className="card">Loading…</div>

  return (
    <div>
      <h1>Sign: {meta.filename}</h1>
      <p className="muted">Signing as {meta.signer}</p>

      {/* ESIGN Act / UETA: consent to transact electronically and intent to be bound must
          be captured affirmatively, before signing, and recorded in the audit trail. */}
      {!consented && (
        <div className="card" style={{ borderColor: '#2563eb', background: '#eff6ff' }}>
          <h2 style={{ marginTop: 0, fontSize: 17 }}>Before you sign</h2>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' }}>
            {meta.consent?.statement}
          </p>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 14px' }}>
            You may request a paper copy or withdraw consent at any time by replying to the
            email that delivered this document. To view and sign, you need a current web
            browser and the ability to receive PDF attachments by email.
          </p>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: 14 }}>
            <input type="checkbox" style={{ marginTop: 3 }} onChange={e => setConsented(e.target.checked)} />
            <span>I agree to sign this document electronically.</span>
          </label>
        </div>
      )}

      {/* Guided action bar */}
      <div className="card" style={{ position: 'sticky', top: 8, zIndex: 20, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {!consented ? (
          <span className="muted">Agree to sign electronically above to begin.</span>
        ) : allDone ? (
          <>
            <strong style={{ color: '#15803d' }}>All required fields complete.</strong>
            <button className="btn" style={{ marginLeft: 'auto' }} disabled={submitting} onClick={finish}>
              {submitting ? 'Submitting…' : 'Finish & sign'}
            </button>
          </>
        ) : (
          <>
            <span>{required.length - remaining.length} of {required.length} required fields done</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={goNext}>
              {remaining.length === required.length ? 'Start' : 'Next field'} →
            </button>
          </>
        )}
      </div>

      {fields.length === 0 && (
        <div className="card" style={{ color: '#b45309' }}>This document has no fields to complete. Contact the sender.</div>
      )}

      {Array.from({ length: numPages }, (_, i) => (
        <SignPage
          key={i}
          pdf={pdfRef.current}
          index={i}
          fields={fields.filter(f => f.page === i)}
          values={values}
          flash={flash}
          isFilled={isFilled}
          onClickField={clickField}
          registerEl={(id, el) => { fieldEls.current[id] = el }}
        />
      ))}

      {error && <div className="card" style={{ borderColor: '#dc2626', color: '#dc2626' }}>{error}</div>}

      {editing && (
        <FieldModal
          field={editing}
          initial={values[editing.id]}
          signerEmail={meta.signer}
          onCancel={() => setEditing(null)}
          onSave={(v) => { setValue(editing.id, v); setEditing(null) }}
        />
      )}
    </div>
  )
}

function SignPage({ pdf, index, fields, values, flash, isFilled, onClickField, registerEl }) {
  const canvasRef = useRef(null)
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
      try { await task.promise } catch { /* cancelled */ }
    })()
    return () => { cancelled = true; if (task) task.cancel() }
  }, [pdf, index])

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="muted" style={{ marginBottom: 6 }}>Page {index + 1}</div>
      <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0, border: '1px solid #ddd', maxWidth: '100%' }}>
        <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
        {dims && fields.map(f => {
          const filled = isFilled(f)
          const v = values[f.id]
          const isFlash = flash === f.id
          return (
            <div
              key={f.id}
              ref={el => registerEl(f.id, el)}
              onClick={() => onClickField(f)}
              style={{
                position: 'absolute',
                left: `${f.x * 100}%`, top: `${f.y * 100}%`,
                width: `${f.w * 100}%`, height: `${f.h * 100}%`,
                boxSizing: 'border-box', cursor: 'pointer',
                border: `1.5px solid ${filled ? '#15803d' : (isFlash ? '#f59e0b' : '#2563eb')}`,
                background: filled ? 'rgba(21,128,61,0.08)' : (isFlash ? 'rgba(245,158,11,0.25)' : 'rgba(37,99,235,0.10)'),
                boxShadow: isFlash ? '0 0 0 3px rgba(245,158,11,0.4)' : 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, color: '#1e3a8a', overflow: 'hidden', lineHeight: 1.1,
                transition: 'box-shadow .2s, background .2s',
              }}
              title={LABEL[f.type] + (f.required ? ' (required)' : '')}
            >
              {renderFieldContent(f, v)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function renderFieldContent(f, v) {
  if (!v) return <span style={{ pointerEvents: 'none' }}>{f.required ? '★ ' : ''}{LABEL[f.type]}</span>
  if (f.type === 'signature' || f.type === 'initials') {
    return <img src={v} alt="signature" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
  }
  if (f.type === 'checkbox') return <span style={{ pointerEvents: 'none', fontWeight: 700 }}>✓</span>
  return <span style={{ pointerEvents: 'none', color: '#111', whiteSpace: 'nowrap' }}>{v}</span>
}

function FieldModal({ field, initial, signerEmail, onCancel, onSave }) {
  const drawing = field.type === 'signature' || field.type === 'initials'
  const [text, setText] = useState(typeof initial === 'string' && !drawing ? initial : (field.type === 'name' ? '' : ''))
  const canvasRef = useRef(null)
  const isDrawing = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  function pos(e) {
    const r = canvasRef.current.getBoundingClientRect()
    const p = e.touches ? e.touches[0] : e
    return { x: p.clientX - r.left, y: p.clientY - r.top }
  }
  function start(e) { isDrawing.current = true; const c = canvasRef.current.getContext('2d'); const { x, y } = pos(e); c.beginPath(); c.moveTo(x, y) }
  function move(e) {
    if (!isDrawing.current) return
    e.preventDefault()
    const c = canvasRef.current.getContext('2d'); const { x, y } = pos(e)
    c.lineWidth = 2.2; c.lineCap = 'round'; c.strokeStyle = '#111'; c.lineTo(x, y); c.stroke(); setHasInk(true)
  }
  function end() { isDrawing.current = false }
  function clear() { const c = canvasRef.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); setHasInk(false) }

  function save() {
    if (drawing) {
      if (!hasInk) return
      onSave(canvasRef.current.toDataURL('image/png'))
    } else {
      if (!text.trim()) return
      onSave(text.trim())
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center', zIndex: 50 }} onClick={onCancel}>
      <div className="card" style={{ background: '#fff', minWidth: 340, maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{drawing ? `Draw your ${LABEL[field.type].toLowerCase()}` : `Enter ${LABEL[field.type].toLowerCase()}`}</h2>
        {drawing ? (
          <>
            <canvas
              ref={canvasRef} width={500} height={150}
              style={{ border: '1px dashed #999', background: '#fff', display: 'block', width: '100%', touchAction: 'none' }}
              onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
              onTouchStart={start} onTouchMove={move} onTouchEnd={end}
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn btn-secondary" type="button" onClick={clear}>Clear</button>
            </div>
          </>
        ) : (
          <div className="field">
            <input
              autoFocus type="text" value={text}
              placeholder={field.type === 'name' ? signerEmail : `Enter ${LABEL[field.type].toLowerCase()}`}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save() }}
            />
          </div>
        )}
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn" type="button" onClick={save}>Apply</button>
        </div>
      </div>
    </div>
  )
}
