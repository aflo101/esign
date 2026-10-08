import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import PDFKitDocument from 'pdfkit';
import 'dotenv/config';

import { logEvent, clientIp } from './db.js';
import * as repo from './repo.js';
import { putObject, getObject, presignPut, presignGet, headObject } from './storage.js';
import { sendEmail, normalizeCc } from './email.js';
import { signatureRequestEmail, completionEmail, magicLinkEmail } from './templates.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Every unauthenticated signer route shares one budget per IP.
const signerLimit = () => rateLimit({ max: 120, windowSeconds: 900, name: 'sign' });

// The Lambda Function URL is AuthType:NONE, so CloudFront proves it's the caller with a
// shared secret header instead. OAC was rejected: it SigV4-signs into the Authorization
// header — clobbering the sender's Bearer token — and requires the client to compute
// x-amz-content-sha256 on every POST/PUT, which CloudFront does not do.
const ORIGIN_SECRET = process.env.ORIGIN_SECRET || null;
if (ORIGIN_SECRET) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-esign-origin'] !== ORIGIN_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });
}

// PDF bytes never transit this service — the browser PUTs to S3 and GETs from S3 via
// presigned URLs. Lambda caps request AND response payloads at 6MB, so streaming a real
// document through Express would fail in production on anything but a tiny file.
// 10MB ceiling: the completion email attaches the signed PDF + evidence and base64
// inflates ~37%, so a larger upload produces a message mail servers reject — after the
// document is already signed.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const EVENT_RENDER_CAP = 500;

// Recorded verbatim into the audit trail so the evidence package shows exactly what the
// signer agreed to. Bump the version if the wording ever changes.
const CONSENT_VERSION = '1.0';
const CONSENT_STATEMENT =
  'I agree to use electronic records and signatures for this document, and I intend my ' +
  'electronic signature to be as legally binding as a handwritten one.';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Short, non-reversible handle for a signing token — safe to write into the audit log.
const tokenFingerprint = (token) => sha256(Buffer.from(token)).slice(0, 12);

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Sender auth ---------------------------------------------------------------
// Invite-only accounts (USER# items). A sender proves identity by session JWT (magic-link
// login, for the browser) or X-Api-Key (for scripts). Both resolve to a user record, and
// requireSender sets req.sender = { email, name, accountId } — every ownership check and
// every audit actor downstream derives from that, never from request bodies.
const SENDER_PASSWORD = process.env.SENDER_PASSWORD || null;       // legacy cutover only
const LEGACY_SENDER_EMAIL = (process.env.LEGACY_SENDER_EMAIL || '').trim().toLowerCase() || null;
const IS_PROD = process.env.NODE_ENV === 'production';
// Dev bypass can never be reached in production, even if the env var leaks in.
const DEV_SENDER_EMAIL = !IS_PROD
  ? ((process.env.DEV_SENDER_EMAIL || '').trim().toLowerCase() || null) : null;

// Fail closed: auth is always enforced; without a signing secret nothing can be verified.
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required');
}
// Magic links and signing links are built from this; unset would mail out "undefined/login/...".
if (IS_PROD && !process.env.APP_BASE_URL) {
  throw new Error('APP_BASE_URL is required when NODE_ENV=production');
}

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL = '12h';
const normEmail = (e) => String(e ?? '').trim().toLowerCase();

const senderOf = (user) => ({ email: user.email, name: user.name, accountId: user.accountId });
const signSession = (user) => jwt.sign(
  { role: 'sender', sub: user.email, name: user.name, acct: user.accountId },
  process.env.JWT_SECRET, { expiresIn: SESSION_TTL },
);

/**
 * Resolve the caller to a sender, or null. The user record is reloaded on every request
 * (not trusted from the JWT) so disabling an account takes effect immediately rather than
 * after the 12h session runs out.
 */
async function authenticate(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const rec = await repo.getApiKey(String(apiKey));
    if (!rec) return null;
    const user = await repo.getUser(rec.email);
    return user && !user.disabled ? senderOf(user) : null;
  }
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (t) {
    try {
      // Pin the algorithm (review hardening): never let the token header pick the verifier.
      const p = jwt.verify(t, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      if (p.role !== 'sender' || !p.sub) return null; // pre-accounts tokens carry no sub
      const user = await repo.getUser(p.sub);
      return user && !user.disabled ? senderOf(user) : null;
    } catch { return null; }
  }
  if (DEV_SENDER_EMAIL) {
    const user = await repo.getUser(DEV_SENDER_EMAIL).catch(() => null);
    return user && !user.disabled
      ? senderOf(user)
      : { email: DEV_SENDER_EMAIL, name: user?.name || DEV_SENDER_EMAIL, accountId: user?.accountId || null };
  }
  return null;
}

async function requireSender(req, res, next) {
  try {
    const sender = await authenticate(req);
    if (!sender) return res.status(401).json({ error: 'sender auth required' });
    req.sender = sender;
    next();
  } catch (e) {
    console.error('auth failed:', e);
    res.status(500).json({ error: 'auth unavailable' });
  }
}

// Load a document the caller owns. 404 — not 403 — for both missing and not-yours, so
// document ids can't be probed for existence. Docs without ownerEmail are inaccessible
// until the backfill script assigns them. Sends the response itself and returns null.
async function loadOwnedDoc(req, res, opts) {
  const doc = await repo.getDocument(req.params.id, opts);
  if (!doc || !doc.ownerEmail || doc.ownerEmail !== req.sender.email) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return doc;
}

// Reports whether the caller's credential is actually USABLE, not just present. The UI gate
// previously opened on the mere existence of a token in localStorage, so an expired or
// invalid one left the app rendered with no working credential.
app.get('/auth/status', async (req, res) => {
  try {
    const sender = await authenticate(req);
    res.json({
      authRequired: true, authenticated: !!sender,
      ...(sender ? { user: { email: sender.email, name: sender.name } } : {}),
    });
  } catch (e) {
    console.error(e);
    res.json({ authRequired: true, authenticated: false });
  }
});

app.get('/auth/me', requireSender, (req, res) => {
  res.json({ email: req.sender.email, name: req.sender.name, accountId: req.sender.accountId });
});

// Always 200 {ok:true}: the response must not reveal whether an address has an account.
// Per-email limiting (on top of per-IP) stops a victim's inbox being flooded from many IPs.
app.post('/auth/magic-link', rateLimit({ max: 10, windowSeconds: 900, name: 'magic' }), async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    if (email && email.length <= 254 && LOOKS_LIKE_EMAIL.test(email)) {
      const n = await repo.bumpRateLimit(`magicemail#${email}`, 900);
      if (n <= 5) {
        const user = await repo.getUser(email);
        if (user && !user.disabled) {
          // 256 bits; only the hash is stored, so a table read can't yield a usable link.
          const token = crypto.randomBytes(32).toString('base64url');
          await repo.putLoginToken({ token, email: user.email, expiresAt: Date.now() + MAGIC_LINK_TTL_MS });
          const link = `${process.env.APP_BASE_URL}/login/${token}`;
          try {
            await sendEmail({ to: user.email, ...magicLinkEmail({ name: user.name, link, expiresMinutes: 15 }) });
          } catch (err) {
            console.error(`magic-link email to ${user.email} failed:`, err.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('magic-link failed:', e);
  }
  res.json({ ok: true });
});

app.post('/auth/verify', rateLimit({ max: 20, windowSeconds: 900, name: 'verify' }), async (req, res) => {
  try {
    const token = String(req.body?.token ?? '');
    if (!token || token.length > 200) return res.status(401).json({ error: 'invalid or expired link' });
    const rec = await repo.consumeLoginToken(token);
    // Expiry is checked in code; the TTL attribute is only garbage collection.
    if (!rec || Date.now() > rec.expiresAt) return res.status(401).json({ error: 'invalid or expired link' });
    const user = await repo.getUser(rec.email);
    if (!user || user.disabled) return res.status(401).json({ error: 'invalid or expired link' });
    res.json({ token: signSession(user), user: { email: user.email, name: user.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'verify failed' });
  }
});

// Legacy shared password — cutover only. Issues a session for LEGACY_SENDER_EMAIL, which
// must already exist as a user. Remove once everyone is on magic links.
app.post('/auth/login', rateLimit({ max: 10, windowSeconds: 900, name: 'login' }), async (req, res) => {
  try {
    if (!SENDER_PASSWORD || !LEGACY_SENDER_EMAIL) return res.status(401).json({ error: 'password login disabled' });
    const supplied = String(req.body?.password ?? '');
    // Constant-time compare over equal-length digests — a direct !== leaks the shared
    // prefix length through timing.
    const ok = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(supplied).digest(),
      crypto.createHash('sha256').update(SENDER_PASSWORD).digest(),
    );
    if (!ok) return res.status(401).json({ error: 'invalid password' });
    const user = await repo.getUser(LEGACY_SENDER_EMAIL);
    if (!user || user.disabled) return res.status(401).json({ error: 'invalid password' });
    res.json({ token: signSession(user), user: { email: user.email, name: user.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login failed' });
  }
});

// --- Rate limiting -----------------------------------------------------------
// DynamoDB atomic counter rather than AWS WAF: a WAF web ACL costs $5/mo, which is more
// than the entire rest of this system. Windowed counters are TTL'd away automatically.
function rateLimit({ max, windowSeconds, name }) {
  return async (req, res, next) => {
    try {
      const n = await repo.bumpRateLimit(`${name}#${clientIp(req) || 'unknown'}`, windowSeconds);
      if (n > max) {
        res.setHeader('Retry-After', String(windowSeconds));
        return res.status(429).json({ error: 'too many requests' });
      }
    } catch (e) {
      console.error('rate limiter unavailable, allowing request:', e.message);
    }
    next();
  };
}

const SIGNING_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// CC plumbing. Deliberately permissive on shape (comma OR semicolon separated, since these
// get pasted out of mail clients) and strict on the result — a malformed address makes SES
// reject the whole SendEmail call, which would fail a send whose token is already live.
const MAX_CC = 10;
const LOOKS_LIKE_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const splitAddresses = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map(a => String(a).trim()).filter(Boolean);

/**
 * Resolve an opaque signing token and bind it to the document's *current* state.
 *
 * Opaque + DB-backed rather than a JWT: a JWT can't be revoked, so a leaked link stayed
 * live for its full 7 days with no way to kill it. Expiry is checked HERE, in code —
 * DynamoDB TTL is best-effort garbage collection and can lag for hours, so it is never
 * the security boundary.
 *
 * The nonce comparison is what kills superseded links: re-sending rotates the document's
 * nonce, so every previously issued token stops resolving.
 */
async function resolveSigningToken(token, { consistent = false } = {}) {
  const rec = await repo.getToken(token);
  if (!rec) throw Object.assign(new Error('invalid or expired link'), { status: 401 });
  if (Date.now() > rec.expiresAt) throw Object.assign(new Error('this signing link has expired'), { status: 401 });

  const doc = await repo.getDocument(rec.docId, { consistent });
  if (!doc) throw Object.assign(new Error('not found'), { status: 404 });
  if (doc.signerEmail !== rec.signerEmail || doc.tokenNonce !== rec.nonce) {
    throw Object.assign(new Error('this signing link has been superseded'), { status: 401 });
  }
  return { payload: { doc_id: rec.docId, signer: rec.signerEmail }, doc };
}

// Wire shape the frontend expects (snake_case sort_order), minus internal keys.
const wireField = (f) => ({
  id: f.id, type: f.type, page: f.page,
  x: f.x, y: f.y, w: f.w, h: f.h,
  required: f.required, sort_order: f.sortOrder,
});

// 1a. Mint a direct-to-S3 upload URL. Writes nothing — an abandoned upload leaves an
// orphan object, not a phantom document record. Orphans currently persist (no lifecycle
// rule targets them — a blanket age rule would delete live originals; a proper sweep
// needs tag-on-complete + expire-untagged, deferred). Cost is pennies; do not claim
// they are cleaned up. Presigned PUT also cannot enforce a size cap (that's a presigned
// POST feature), so an oversized object can land in S3 — /complete rejects it there.
app.post('/documents/init', requireSender, async (req, res) => {
  try {
    const filename = String(req.body?.filename || '').trim();
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (!/\.pdf$/i.test(filename)) return res.status(400).json({ error: 'pdf only' });
    const id = crypto.randomUUID();
    const key = `documents/${id}/original.pdf`;
    res.json({ id, key, uploadUrl: await presignPut(key), maxBytes: MAX_UPLOAD_BYTES });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 1b. Register the uploaded object. The hash is computed HERE, from the bytes actually in
// S3 — never taken from the client, since it's the document's integrity anchor.
app.post('/documents/:id/complete', requireSender, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'bad id' });
    const filename = String(req.body?.filename || '').trim();
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const key = `documents/${id}/original.pdf`;
    const head = await headObject(key);
    if (!head) return res.status(400).json({ error: 'upload not found — PUT the file first' });
    if (head.size > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'file too large (max 10MB)' });

    const buf = await getObject(key);
    // Trust the bytes, not the declared content type — a presigned PUT lets the client
    // claim any Content-Type it likes.
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ error: 'not a PDF' });
    }
    const hash = sha256(buf);

    try {
      await repo.createDocument({
        id, filename, originalHash: hash,
        s3KeyOriginal: key, senderEmail: req.sender.email,
        ownerEmail: req.sender.email, accountId: req.sender.accountId,
      });
    } catch (e) {
      // Review fix: an id that already exists (any owner) must never be re-registered, and
      // must not surface DynamoDB's raw error text as a 500. createDocument is conditional,
      // so nothing was overwritten; answer 409 without saying whose document it is.
      if (e?.name === 'ConditionalCheckFailedException') return res.status(409).json({ error: 'document already registered' });
      throw e;
    }
    await logEvent(id, 'document_uploaded', req, { filename, size: head.size, hash, actor: req.sender.email });
    res.json({ id, hash, filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 2. Send signing link
app.post('/documents/:id/send', requireSender, async (req, res) => {
  try {
    const { id } = req.params;
    const { signer_email, cc_email, cc_sender } = req.body;
    if (!signer_email) return res.status(400).json({ error: 'signer_email required' });
    const doc = await loadOwnedDoc(req, res);
    if (!doc) return;

    // CC defaults to the sender. The sender already receives the completion mail but was
    // never copied on the request itself, so they had no record of what went out or of the
    // link they may need to re-share — which is exactly the gap that stranded two envelopes
    // for a fortnight. Derived from the document's own senderEmail rather than configured,
    // so a per-sender deployment needs no env var. Pass cc_sender:false to suppress it.
    const senderCc = cc_sender === false ? [] : splitAddresses(req.sender.email);
    const ccList = normalizeCc(
      [...senderCc, ...splitAddresses(process.env.SES_DEFAULT_CC), ...splitAddresses(cc_email)],
      signer_email,
    );
    // Validate before the token is minted: a malformed address makes SES reject the whole
    // SendEmail call, which would fail a send whose link is already live.
    const badCc = ccList.find(a => !LOOKS_LIKE_EMAIL.test(a));
    if (badCc) return res.status(400).json({ error: `invalid cc address: ${badCc}` });
    if (ccList.length > MAX_CC) return res.status(400).json({ error: `at most ${MAX_CC} cc addresses` });

    // New nonce per send → every previously issued link for this document stops working.
    const nonce = crypto.randomBytes(9).toString('base64url');
    // An executed document is final — re-sending would reset it to 'sent' and allow
    // the signed contract to be signed again over the top of itself.
    const linkExpiresAt = Date.now() + SIGNING_TOKEN_TTL_MS;
    const updated = await repo.markSent({ id, signerEmail: signer_email, ccEmails: ccList, tokenNonce: nonce, linkExpiresAt });
    if (!updated) return res.status(409).json({ error: 'already signed' });

    // 128 bits of opaque randomness — short enough for a clean link, revocable, and
    // carrying no readable claims.
    const token = crypto.randomBytes(16).toString('base64url');
    await repo.putToken({
      token, docId: id, signerEmail: signer_email, nonce,
      expiresAt: linkExpiresAt,
    });
    const link = `${process.env.APP_BASE_URL}/s/${token}`;

    // The email failing (SES throttle, suppressed recipient) must not 500 this route:
    // by this point the document is already 'sent' with a live token, so an uncaught
    // throw told the sender "failed" about a send that half-happened, logged nothing,
    // and withheld the one thing that still works — the link. Report honestly instead.
    let emailError = null;
    try {
      await sendEmail({
        to: signer_email,
        cc: ccList,
        ...signatureRequestEmail({
          senderName: req.sender.name,
          senderEmail: req.sender.email,
          filename: doc.filename,
          link,
          expiresDays: 7,
        }),
      });
    } catch (err) {
      console.error(`signature-request email to ${signer_email} failed:`, err);
      emailError = err.message;
    }
    // Never log the link itself — event metadata is printed verbatim into the evidence
    // PDF that goes to both parties, which would publish a live credential.
    // cc recipients are recorded because they hold a signable credential — the evidence
    // package must show who else received the link, not just the named signer.
    await logEvent(id, emailError ? 'link_send_failed' : 'link_sent', req, {
      actor: req.sender.email, signer_email, ...(ccList.length ? { cc_emails: ccList } : {}),
      token_fp: tokenFingerprint(token), ...(emailError ? { error: emailError } : {}),
    });
    res.json({
      ok: true, link, email_sent: !emailError,
      ...(ccList.length ? { cc_emails: ccList } : {}),
      ...(emailError ? { email_error: emailError } : {}),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Sender-side: view PDF + place fields (Prepare step) ---
// All routes below are behind requireSender (enforced whenever SENDER_PASSWORD is set,
// and mandatory under NODE_ENV=production — see the startup guard above).

const FIELD_TYPES = new Set(['signature', 'initials', 'date', 'name', 'text', 'checkbox']);

// Presigned URL for the original PDF (sender's Prepare page). Returns {url}, not bytes.
app.get('/documents/:id/pdf', requireSender, async (req, res) => {
  try {
    const doc = await loadOwnedDoc(req, res);
    if (!doc) return;
    res.json({ url: await presignGet(doc.s3KeyOriginal) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// List placed fields for a document
app.get('/documents/:id/fields', requireSender, async (req, res) => {
  try {
    if (!await loadOwnedDoc(req, res)) return;
    const fields = await repo.listFields(req.params.id);
    res.json({ fields: fields.map(wireField) });
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

  try {
    const doc = await loadOwnedDoc(req, res, { consistent: true });
    if (!doc) return;
    // 'signing' means a submit is mid-flight against the current field set — moving the
    // fields underneath it would flatten values at coordinates the signer never saw.
    if (['signed', 'signing'].includes(doc.status)) {
      return res.status(409).json({ error: `cannot edit fields while status=${doc.status}` });
    }

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

    await repo.replaceFields(id, clean);
    await logEvent(id, 'fields_placed', req, { count: clean.length, types: clean.map(f => f.type), actor: req.sender.email });
    res.json({ ok: true, count: clean.length });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// 3. Open signing link (signer side)
app.get('/sign/:token', signerLimit(), async (req, res) => {
  try {
    const { payload, doc } = await resolveSigningToken(req.params.token);
    if (doc.status === 'signed') return res.status(410).json({ error: 'already signed' });
    const fields = await repo.listFields(payload.doc_id);
    await logEvent(payload.doc_id, 'link_opened', req, { signer: payload.signer });
    res.json({
      doc_id: payload.doc_id, filename: doc.filename, signer: payload.signer,
      fields: fields.map(wireField),
      consent: { version: CONSENT_VERSION, statement: CONSENT_STATEMENT },
    });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.status ? e.message : 'invalid or expired token' });
  }
});

// Presigned URL for the original PDF (signer's view)
app.get('/sign/:token/pdf', signerLimit(), async (req, res) => {
  try {
    const { doc } = await resolveSigningToken(req.params.token);
    res.json({ url: await presignGet(doc.s3KeyOriginal) });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.status ? e.message : 'invalid token' });
  }
});

// Post-sign downloads for the signer (token stays valid for the 7d window)
app.get('/sign/:token/signed', signerLimit(), async (req, res) => {
  try {
    const { doc } = await resolveSigningToken(req.params.token, { consistent: true });
    if (!doc.s3KeySigned) return res.status(404).json({ error: 'not signed yet' });
    res.json({ url: await presignGet(doc.s3KeySigned, `signed-${doc.filename}`) });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.status ? e.message : 'invalid token' });
  }
});

app.get('/sign/:token/evidence', signerLimit(), async (req, res) => {
  try {
    const { payload } = await resolveSigningToken(req.params.token, { consistent: true });
    const key = await ensureEvidence(payload.doc_id);
    res.json({ url: await presignGet(key, 'evidence.pdf') });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.status ? e.message : 'invalid token' });
  }
});

// 4. Submit — apply values to all placed fields, flatten, email
app.post('/sign/:token', signerLimit(), async (req, res) => {
  let claimedDocId = null;
  try {
    // Strongly consistent: an eventually-consistent read can serve a stale 'sent' status
    // for a document that was just executed.
    const { payload, doc } = await resolveSigningToken(req.params.token, { consistent: true });
    const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};

    if (doc.status === 'signed') return res.status(410).json({ error: 'already signed' });

    // ESIGN Act §101(c) / UETA: an electronic signature is only enforceable if the signer
    // affirmatively consented to transact electronically and intended to be bound. Refusing
    // without it is the point — "they clicked a button" is not a defensible record.
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'electronic signature consent is required' });
    }

    const fields = await repo.listFields(payload.doc_id, { consistent: true });
    if (!fields.length) return res.status(400).json({ error: 'document has no fields to sign' });

    // Validate: every required field must have a non-empty value
    const isFilled = (f) => {
      const v = values[f.id];
      if (f.type === 'checkbox') return v === true;
      return typeof v === 'string' ? v.trim().length > 0 : !!v;
    };
    const missing = fields.filter(f => f.required && !isFilled(f));
    if (missing.length) return res.status(400).json({ error: `missing required fields: ${missing.map(m => m.type).join(', ')}` });

    // Claim before doing any work. Validation runs first so a rejected submit never
    // locks the document.
    const claimed = await repo.claimForSigning(payload.doc_id);
    if (!claimed) return res.status(410).json({ error: 'already signed or in progress' });
    claimedDocId = payload.doc_id;

    // Recorded before the signature itself so the evidence package shows consent
    // preceding execution.
    await logEvent(payload.doc_id, 'consent_given', req, {
      signer: payload.signer,
      disclosure_version: CONSENT_VERSION,
      statement: CONSENT_STATEMENT,
    });

    await logEvent(payload.doc_id, 'signature_drawn', req, {
      signer: payload.signer, filled: fields.filter(isFilled).map(f => ({ type: f.type, page: f.page })),
    });

    // Flatten every filled field onto the PDF
    const originalBuf = await getObject(doc.s3KeyOriginal);
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

    // Persist field values (redact signature images — the PNG lives in the flattened PDF)
    await repo.setFieldValues(payload.doc_id, fields.filter(isFilled).map(f => ({
      sk: f.SK,
      value: (f.type === 'signature' || f.type === 'initials') ? { image: true } : values[f.id],
    })));

    const signedBytes = await pdfDoc.save();
    const signedHash = sha256(Buffer.from(signedBytes));
    const signedKey = `documents/${payload.doc_id}/signed.pdf`;
    await putObject(signedKey, Buffer.from(signedBytes), 'application/pdf');

    await repo.commitSigned({ id: payload.doc_id, signedHash, s3KeySigned: signedKey });
    claimedDocId = null; // committed — nothing to roll back
    await logEvent(payload.doc_id, 'document_signed', req, { signer: payload.signer, signed_hash: signedHash });

    // Deliver BEFORE responding, and swallow failures.
    //
    // This must be awaited: Lambda freezes the execution environment the instant the
    // handler returns, so fire-and-forget work scheduled after res.json() silently never
    // runs. That shipped once — a document was signed and committed and neither party was
    // ever emailed, with no error anywhere to show for it.
    //
    // Errors are caught rather than thrown because the signature is already committed at
    // this point; a delivery failure must never surface to the signer as a signing
    // failure. deliverCompletion() records its own success/failure events.
    await deliverCompletion({ doc, signedHash, signedBytes, req })
      .catch(err => console.error('completion delivery failed:', err));

    res.json({ ok: true, signed_hash: signedHash });
  } catch (e) {
    // A failure after the claim would otherwise strand the document in 'signing',
    // locking out the signer permanently.
    if (claimedDocId) {
      await repo.releaseClaim(claimedDocId).catch(err => console.error('failed to release signing claim:', err));
    }
    console.error(e);
    if (res.headersSent) return;
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Completion delivery runs outside the request path on purpose. The signature is already
// committed by the time this runs, so a bounced or throttled email must not surface to the
// signer as a signing failure — that drove a retry which then 410s, leaving them with an
// executed contract and no copy of it. Failures are logged as events instead.
async function deliverCompletion({ doc, signedHash, signedBytes, req }) {
  // CC'd parties get the executed PDF + evidence too — a copy of the request without a copy
  // of the result is the useless half. Deduped so a cc that equals the sender sends once.
  const recipients = normalizeCc([doc.signerEmail, doc.senderEmail, ...(doc.ccEmails || [])]);
  if (!recipients.length) return;

  const signedBuffer = Buffer.from(signedBytes);
  const evidenceBuffer = await buildEvidencePdf(doc.id);
  const delivered = [], failed = [];

  const content = completionEmail({
    filename: doc.filename,
    signerEmail: doc.signerEmail,
    originalHash: doc.originalHash,
    signedHash,
    signedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  });

  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        ...content,
        attachments: [
          { filename: doc.filename, content: signedBuffer },
          { filename: 'evidence.pdf', content: evidenceBuffer }
        ]
      });
      delivered.push(to);
    } catch (err) {
      // Isolated per recipient — a bad signer address must not cost the sender their copy.
      console.error(`completion email to ${to} failed:`, err);
      failed.push({ to, error: err.message });
    }
  }

  if (delivered.length) await logEvent(doc.id, 'completion_emailed', req, { recipients: delivered });
  if (failed.length) await logEvent(doc.id, 'completion_email_failed', req, { failures: failed });
}

// 5. Evidence package
app.get('/documents/:id/evidence', requireSender, async (req, res) => {
  try {
    if (!await loadOwnedDoc(req, res)) return;
    const key = await ensureEvidence(req.params.id);
    res.json({ url: await presignGet(key, 'evidence.pdf') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Sender-side: dashboard list, detail, signed download, revoke ---
const wireDoc = (d) => ({
  id: d.id, filename: d.filename, status: d.status,
  signerEmail: d.signerEmail ?? null, ccEmails: d.ccEmails || [],
  createdAt: d.createdAt, sentAt: d.sentAt ?? null, signedAt: d.signedAt ?? null,
  linkExpiresAt: d.linkExpiresAt ?? null, revokedAt: d.revokedAt ?? null,
});

app.get('/documents', requireSender, async (req, res) => {
  try {
    const docs = await repo.listDocumentsByOwner(req.sender.email);
    res.json({ documents: docs.map(wireDoc) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/documents/:id', requireSender, async (req, res) => {
  try {
    const doc = await loadOwnedDoc(req, res);
    if (!doc) return;
    res.json(wireDoc(doc));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/documents/:id/signed', requireSender, async (req, res) => {
  try {
    const doc = await loadOwnedDoc(req, res, { consistent: true });
    if (!doc) return;
    if (doc.status !== 'signed' || !doc.s3KeySigned) return res.status(409).json({ error: 'not signed yet' });
    res.json({ url: await presignGet(doc.s3KeySigned, `signed-${doc.filename}`) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Kills every outstanding link by rotating the nonce (resolveSigningToken compares it) and
// issues none in its place. A later /send mints a fresh nonce, so re-sending still works.
app.post('/documents/:id/revoke', requireSender, async (req, res) => {
  try {
    if (!await loadOwnedDoc(req, res, { consistent: true })) return;
    const updated = await repo.revokeDocument(req.params.id);
    if (!updated) return res.status(409).json({ error: 'only a sent, unsigned document can be revoked' });
    await logEvent(req.params.id, 'link_revoked', req, { actor: req.sender.email });
    res.json(wireDoc(updated));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Render the evidence package to S3 and return its key. Always regenerated: the event log
 * grows after signing (downloads, re-opens), and a stale cached copy would understate the
 * audit trail. Kept out of the HTTP response body because a long log can exceed Lambda's
 * 6MB response cap.
 */
async function ensureEvidence(docId) {
  const buf = await buildEvidencePdf(docId);
  const key = `documents/${docId}/evidence.pdf`;
  await putObject(key, buf, 'application/pdf');
  return key;
}

async function buildEvidencePdf(docId) {
  const [doc, events, fields] = await Promise.all([
    repo.getDocument(docId, { consistent: true }),
    repo.listEvents(docId),
    repo.listFields(docId, { consistent: true }),
  ]);
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
    pdf.text(`Sender: ${doc.senderEmail || '(unknown)'}`);
    pdf.text(`Signer: ${doc.signerEmail || '(unknown)'}`);
    pdf.text(`Status: ${doc.status}`);
    pdf.text(`Original SHA-256: ${doc.originalHash}`);
    pdf.text(`Signed SHA-256:   ${doc.signedHash || '(unsigned)'}`);

    pdf.moveDown();
    pdf.fontSize(14).text('Completed Fields');
    pdf.fontSize(9);
    if (!fields.length) pdf.text('   (none)');
    for (const f of fields) {
      const val = f.value == null ? '(empty)'
        : (f.value.image ? '[signature image]' : JSON.stringify(f.value));
      pdf.text(`   ${f.type} (page ${f.page + 1}${f.required ? ', required' : ''}): ${val}`);
    }

    pdf.moveDown();
    pdf.fontSize(14).text('Event Log');
    pdf.fontSize(9);
    // `link_opened` fires on every page refresh, so the log has no natural ceiling — and a
    // naive "most recent N" let a flooded log evict consent_given / document_signed, the
    // exact records this package exists to preserve. Under pressure: summarize the opens
    // (count + first/last, keeping their evidentiary shape) and render every other event;
    // if even that overflows, keep both ends of the timeline, never a window that can lose
    // the signing events. listEvents is fully paginated, so `events` is always complete.
    let shown = events;
    if (events.length > EVENT_RENDER_CAP) {
      const opens = events.filter(e => e.type === 'link_opened');
      shown = events.filter(e => e.type !== 'link_opened');
      pdf.fillColor('#b45309')
         .text(`   (link_opened x${opens.length} summarized: first ${opens[0]?.createdAt || '-'}, last ${opens[opens.length - 1]?.createdAt || '-'})`)
         .fillColor('black');
      if (shown.length > EVENT_RENDER_CAP) {
        const head = shown.slice(0, 50);
        const tail = shown.slice(-(EVENT_RENDER_CAP - 50));
        pdf.fillColor('#b45309')
           .text(`   (${shown.length - head.length - tail.length} mid-log events elided; first ${head.length} and last ${tail.length} shown)`)
           .fillColor('black');
        shown = [...head, ...tail];
      }
    }
    for (const e of shown) {
      pdf.moveDown(0.5);
      pdf.text(`[${e.createdAt}] ${e.type}`);
      pdf.text(`   ip=${e.ip || '-'}  ua=${(e.userAgent || '').slice(0, 80)}`);
      if (e.metadata && Object.keys(e.metadata).length) {
        pdf.text(`   meta=${JSON.stringify(e.metadata)}`, { width: 500 });
      }
    }
    pdf.end();
  });
}

// buildEvidencePdf/deliverCompletion are exported for operational re-sends (re-delivering
// a completion for an already-signed document) — not used by the request path.
export { app, buildEvidencePdf, deliverCompletion };

// Only bind a port when run directly. Under Lambda the app is wrapped by handler.js.
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`esign backend listening on :${port}`));
}
