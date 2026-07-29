import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import PDFKitDocument from 'pdfkit';
import 'dotenv/config';

import { pool, logEvent } from './db.js';
import { putObject, getObject } from './storage.js';
import { sendEmail } from './email.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Sender auth (env-gated: enforced only when SENDER_PASSWORD is set) ---
const SENDER_PASSWORD = process.env.SENDER_PASSWORD || null;

function requireSender(req, res, next) {
  if (!SENDER_PASSWORD) return next(); // auth disabled in dev
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  try {
    const p = jwt.verify(t, process.env.JWT_SECRET);
    if (p.role !== 'sender') throw new Error('bad role');
    return next();
  } catch {
    return res.status(401).json({ error: 'sender auth required' });
  }
}

app.get('/auth/status', (_req, res) => res.json({ authRequired: !!SENDER_PASSWORD }));
app.post('/auth/login', (req, res) => {
  if (!SENDER_PASSWORD) return res.json({ token: null, authRequired: false });
  if (req.body?.password !== SENDER_PASSWORD) return res.status(401).json({ error: 'invalid password' });
  const token = jwt.sign({ role: 'sender' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// 1. Upload PDF
app.post('/documents', requireSender, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'pdf only' });
    const id = crypto.randomUUID();
    const hash = sha256(req.file.buffer);
    const key = `documents/${id}/original.pdf`;
    await putObject(key, req.file.buffer, 'application/pdf');
    await pool.query(
      `INSERT INTO documents (id, filename, original_hash, s3_key_original, sender_email) VALUES ($1,$2,$3,$4,$5)`,
      [id, req.file.originalname, hash, key, req.body.sender_email || null]
    );
    await logEvent(id, 'document_uploaded', req, { filename: req.file.originalname, size: req.file.size, hash });
    res.json({ id, hash, filename: req.file.originalname });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 2. Send signing link
app.post('/documents/:id/send', requireSender, async (req, res) => {
  try {
    const { id } = req.params;
    const { signer_email } = req.body;
    if (!signer_email) return res.status(400).json({ error: 'signer_email required' });
    const { rows } = await pool.query(`SELECT * FROM documents WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const token = jwt.sign({ doc_id: id, signer: signer_email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    await pool.query(`UPDATE documents SET signer_email=$1, status='sent' WHERE id=$2`, [signer_email, id]);
    const link = `${process.env.APP_BASE_URL}/sign/${token}`;
    await sendEmail({
      to: signer_email,
      subject: `Signature requested: ${rows[0].filename}`,
      html: `<p>You have a document to sign.</p><p><a href="${link}">Open and sign</a></p>`
    });
    await logEvent(id, 'link_sent', req, { signer_email, link });
    res.json({ ok: true, link });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Sender-side: view PDF + place fields (Prepare step) ---
// NOTE: no sender auth yet (localhost only) — Phase 4 adds it before public exposure.

const FIELD_TYPES = new Set(['signature', 'initials', 'date', 'name', 'text', 'checkbox']);

// Stream the original PDF for the sender's Prepare page
app.get('/documents/:id/pdf', requireSender, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT s3_key_original FROM documents WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).end();
    const buf = await getObject(rows[0].s3_key_original);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// List placed fields for a document
app.get('/documents/:id/fields', requireSender, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, page, x, y, w, h, required, sort_order FROM fields WHERE doc_id=$1 ORDER BY sort_order ASC`,
      [req.params.id]
    );
    res.json({ fields: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Replace the full set of fields for a document (idempotent save from the Prepare page)
app.put('/documents/:id/fields', requireSender, async (req, res) => {
  const { id } = req.params;
  const incoming = Array.isArray(req.body?.fields) ? req.body.fields : null;
  if (!incoming) return res.status(400).json({ error: 'fields array required' });

  const client = await pool.connect();
  try {
    const doc = await client.query(`SELECT id, status FROM documents WHERE id=$1`, [id]);
    if (!doc.rows.length) return res.status(404).json({ error: 'not found' });
    if (doc.rows[0].status === 'signed') return res.status(409).json({ error: 'already signed' });

    // Validate before touching anything
    const clean = incoming.map((f, i) => {
      if (!FIELD_TYPES.has(f.type)) throw new Error(`invalid field type: ${f.type}`);
      const num = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
      const x = num(f.x), y = num(f.y), w = num(f.w), h = num(f.h);
      if ([x, y, w, h].some(v => v === null)) throw new Error('x/y/w/h must be normalized 0-1');
      if (!Number.isInteger(f.page) || f.page < 0) throw new Error('page must be a 0-based integer');
      return {
        type: f.type, page: f.page, x, y, w, h,
        required: f.required !== false,
        sort_order: Number.isInteger(f.sort_order) ? f.sort_order : i,
      };
    });

    await client.query('BEGIN');
    await client.query(`DELETE FROM fields WHERE doc_id=$1`, [id]);
    for (const f of clean) {
      await client.query(
        `INSERT INTO fields (doc_id, type, page, x, y, w, h, required, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.sort_order]
      );
    }
    await client.query('COMMIT');
    await logEvent(id, 'fields_placed', req, { count: clean.length, types: clean.map(f => f.type) });
    res.json({ ok: true, count: clean.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// 3. Open signing link (signer side)
app.get('/sign/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    const { rows } = await pool.query(`SELECT id, filename, status FROM documents WHERE id=$1`, [payload.doc_id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].status === 'signed') return res.status(410).json({ error: 'already signed' });
    const fieldsRes = await pool.query(
      `SELECT id, type, page, x, y, w, h, required, sort_order FROM fields WHERE doc_id=$1 ORDER BY sort_order ASC`,
      [payload.doc_id]
    );
    await logEvent(payload.doc_id, 'link_opened', req, { signer: payload.signer });
    res.json({ doc_id: payload.doc_id, filename: rows[0].filename, signer: payload.signer, fields: fieldsRes.rows });
  } catch (e) {
    res.status(401).json({ error: 'invalid or expired token' });
  }
});

// Stream the original PDF for the signer to view
app.get('/sign/:token/pdf', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    const { rows } = await pool.query(`SELECT s3_key_original FROM documents WHERE id=$1`, [payload.doc_id]);
    if (!rows.length) return res.status(404).end();
    const buf = await getObject(rows[0].s3_key_original);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(buf);
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
});

// Post-sign downloads for the signer (token stays valid for the 7d window)
app.get('/sign/:token/signed', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    const { rows } = await pool.query(`SELECT s3_key_signed, filename FROM documents WHERE id=$1`, [payload.doc_id]);
    if (!rows.length || !rows[0].s3_key_signed) return res.status(404).json({ error: 'not signed yet' });
    const buf = await getObject(rows[0].s3_key_signed);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="signed-${rows[0].filename}"`);
    res.send(buf);
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
});

app.get('/sign/:token/evidence', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    const buf = await buildEvidencePdf(payload.doc_id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="evidence.pdf"');
    res.send(buf);
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
});

// 4. Submit — apply values to all placed fields, flatten, email
app.post('/sign/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};

    const { rows } = await pool.query(`SELECT * FROM documents WHERE id=$1`, [payload.doc_id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].status === 'signed') return res.status(410).json({ error: 'already signed' });

    const fieldsRes = await pool.query(`SELECT * FROM fields WHERE doc_id=$1 ORDER BY sort_order ASC`, [payload.doc_id]);
    const fields = fieldsRes.rows;
    if (!fields.length) return res.status(400).json({ error: 'document has no fields to sign' });

    // Validate: every required field must have a non-empty value
    const isFilled = (f) => {
      const v = values[f.id];
      if (f.type === 'checkbox') return v === true;
      return typeof v === 'string' ? v.trim().length > 0 : !!v;
    };
    const missing = fields.filter(f => f.required && !isFilled(f));
    if (missing.length) return res.status(400).json({ error: `missing required fields: ${missing.map(m => m.type).join(', ')}` });

    await logEvent(payload.doc_id, 'signature_drawn', req, {
      signer: payload.signer, filled: fields.filter(isFilled).map(f => ({ type: f.type, page: f.page })),
    });

    // Flatten every filled field onto the PDF
    const originalBuf = await getObject(rows[0].s3_key_original);
    const pdfDoc = await PDFDocument.load(originalBuf);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const nowIso = new Date().toISOString();

    for (const f of fields) {
      if (!isFilled(f)) continue;
      const page = pages[Math.min(f.page, pages.length - 1)];
      const { width: pw, height: ph } = page.getSize();
      const px = f.x * pw;
      const boxW = f.w * pw;
      const boxH = f.h * ph;
      const boxBottom = ph - (f.y + f.h) * ph; // top-left → bottom-left origin
      const v = values[f.id];

      if (f.type === 'signature' || f.type === 'initials') {
        const png = await pdfDoc.embedPng(Buffer.from(String(v).replace(/^data:image\/png;base64,/, ''), 'base64'));
        // Preserve aspect ratio inside the box
        const scale = Math.min(boxW / png.width, boxH / png.height);
        const dw = png.width * scale, dh = png.height * scale;
        page.drawImage(png, { x: px + (boxW - dw) / 2, y: boxBottom + (boxH - dh) / 2, width: dw, height: dh });
      } else if (f.type === 'checkbox') {
        const size = Math.min(boxH, boxW) * 0.9;
        page.drawText('X', { x: px + (boxW - size * 0.6) / 2, y: boxBottom + boxH * 0.1, size, font, color: rgb(0.1, 0.1, 0.1) });
      } else {
        // date | name | text
        const size = Math.max(6, Math.min(boxH * 0.7, 22));
        page.drawText(String(v), { x: px + 2, y: boxBottom + (boxH - size) / 2 + size * 0.15, size, font, color: rgb(0.05, 0.05, 0.05) });
      }
    }

    // Footer stamp on the first page for a visible completion trace
    const first = pages[0];
    first.drawText(`Electronically signed via esign · ${payload.signer} · ${nowIso}`, {
      x: 24, y: 14, size: 6.5, font, color: rgb(0.45, 0.45, 0.45),
    });

    // Persist field values (redact signature images to avoid DB bloat)
    for (const f of fields) {
      if (!isFilled(f)) continue;
      const stored = (f.type === 'signature' || f.type === 'initials') ? { image: true } : values[f.id];
      await pool.query(`UPDATE fields SET value=$1 WHERE id=$2`, [JSON.stringify(stored), f.id]);
    }

    const signedBytes = await pdfDoc.save();
    const signedHash = sha256(Buffer.from(signedBytes));
    const signedKey = `documents/${payload.doc_id}/signed.pdf`;
    await putObject(signedKey, Buffer.from(signedBytes), 'application/pdf');

    await pool.query(
      `UPDATE documents SET signed_hash=$1, s3_key_signed=$2, status='signed' WHERE id=$3`,
      [signedHash, signedKey, payload.doc_id]
    );
    await logEvent(payload.doc_id, 'document_signed', req, { signer: payload.signer, signed_hash: signedHash });

    // Email both parties
    const doc = rows[0];
    const signedBuffer = Buffer.from(signedBytes);
    const evidenceBuffer = await buildEvidencePdf(payload.doc_id);
    const recipients = [doc.signer_email, doc.sender_email].filter(Boolean);
    for (const to of recipients) {
      await sendEmail({
        to,
        subject: `Signed: ${doc.filename}`,
        html: `<p>The document has been signed.</p><p>Original hash: ${doc.original_hash}<br/>Signed hash: ${signedHash}</p>`,
        attachments: [
          { filename: doc.filename, content: signedBuffer },
          { filename: 'evidence.pdf', content: evidenceBuffer }
        ]
      });
    }
    await logEvent(payload.doc_id, 'completion_emailed', req, { recipients });

    res.json({ ok: true, signed_hash: signedHash });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 5. Evidence package
app.get('/documents/:id/evidence', requireSender, async (req, res) => {
  try {
    const buf = await buildEvidencePdf(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function buildEvidencePdf(docId) {
  const docRes = await pool.query(`SELECT * FROM documents WHERE id=$1`, [docId]);
  const evRes = await pool.query(`SELECT * FROM events WHERE doc_id=$1 ORDER BY created_at ASC`, [docId]);
  const fieldsRes = await pool.query(`SELECT type, page, required, value FROM fields WHERE doc_id=$1 ORDER BY sort_order ASC`, [docId]);
  const doc = docRes.rows[0];
  if (!doc) throw new Error('not found');

  return await new Promise((resolve, reject) => {
    const pdf = new PDFKitDocument({ margin: 50 });
    const chunks = [];
    pdf.on('data', c => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.fontSize(18).text('Signature Evidence Package', { align: 'center' });
    pdf.moveDown();
    pdf.fontSize(10);
    pdf.text(`Document ID: ${doc.id}`);
    pdf.text(`Filename: ${doc.filename}`);
    pdf.text(`Sender: ${doc.sender_email || '(unknown)'}`);
    pdf.text(`Signer: ${doc.signer_email || '(unknown)'}`);
    pdf.text(`Status: ${doc.status}`);
    pdf.text(`Original SHA-256: ${doc.original_hash}`);
    pdf.text(`Signed SHA-256:   ${doc.signed_hash || '(unsigned)'}`);

    pdf.moveDown();
    pdf.fontSize(14).text('Completed Fields');
    pdf.fontSize(9);
    if (!fieldsRes.rows.length) pdf.text('   (none)');
    for (const f of fieldsRes.rows) {
      const val = f.value == null ? '(empty)'
        : (f.value.image ? '[signature image]' : JSON.stringify(f.value));
      pdf.text(`   ${f.type} (page ${f.page + 1}${f.required ? ', required' : ''}): ${val}`);
    }

    pdf.moveDown();
    pdf.fontSize(14).text('Event Log');
    pdf.fontSize(9);
    for (const e of evRes.rows) {
      pdf.moveDown(0.5);
      pdf.text(`[${e.created_at.toISOString()}] ${e.type}`);
      pdf.text(`   ip=${e.ip || '-'}  ua=${(e.user_agent || '').slice(0, 80)}`);
      if (e.metadata && Object.keys(e.metadata).length) {
        pdf.text(`   meta=${JSON.stringify(e.metadata)}`, { width: 500 });
      }
    }
    pdf.end();
  });
}

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`esign backend listening on :${port}`));
