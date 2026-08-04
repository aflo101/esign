# esign — E-Signature Service

Self-hosted DocuSign alternative. Sender uploads a PDF and places fields; the signer opens a
link, consents, completes the fields, and everything is flattened onto the PDF. Both parties
receive the signed document plus an evidence package built from an append-only audit log.

**Live:** https://esign.rippleconsultingservices.com (deployed 2026-08-04)

---

## Architecture

Fully serverless, ~$1/mo. Nothing runs when idle.

```
Route 53 → CloudFront (ACM cert)
             ├── /*      → S3 (private, OAC) — React SPA
             │              CloudFront Function rewrites extensionless paths → /index.html
             └── /api/*  → Lambda Function URL (AuthType NONE + secret header)
                            CloudFront Function strips the /api prefix
                          ↓
                   Express on Lambda (serverless-http)
                          ↓
              DynamoDB (single table) · S3 (documents) · SES
```

**PDF bytes never transit the API.** Lambda caps request and response payloads at 6MB, so
uploads go browser → S3 via presigned PUT, and every read is a presigned GET. The service
only ever moves JSON.

### Why the odd edge choices

- **Function URL with `AuthType: NONE` + a shared secret header, not OAC.** CloudFront's OAC
  SigV4-signs origin requests *into the `Authorization` header*, which would clobber the
  sender's Bearer token, and it requires the client to compute `x-amz-content-sha256` on
  every POST/PUT — which CloudFront does not do. OAC breaks login, field save, send and sign.
- **CloudFront Function for the SPA fallback, not distribution `errorResponses`.** Custom
  error responses apply to *every* behavior, so a genuine 400/404 from `/api/*` came back as
  the SPA shell with status 200, masking real API errors. This shipped once and broke every
  JSON client.
- **DynamoDB counter for rate limiting, not WAF.** A WAF web ACL is $5/mo — more than the
  rest of the system combined.
- **SSM Parameter Store, not Secrets Manager.** $0 vs $0.40/secret/month.

---

## Data model

One DynamoDB table. One partition per document, so a single Query returns the document,
every placed field, and the full audit trail in one round trip.

| PK | SK | Item |
|---|---|---|
| `DOC#<id>` | `EVT#<millis>#<seq>#<rand>` | audit event (append-only) |
| `DOC#<id>` | `FLD#<order>#<uuid>` | placed field |
| `DOC#<id>` | `META` | document |
| `TOK#<token>` | `META` | signing token (TTL'd) |
| `RL#<bucket>#<window>` | `META` | rate-limit counter (TTL'd) |

SK prefixes sort `EVT < FLD < META`. Event SKs use fixed-width epoch millis plus a monotonic
counter — sequential writes inside one invocation can share a millisecond, and a bare
timestamp lets the audit trail render out of order.

**Hashing:** SHA-256 of the original PDF at upload (computed server-side from the bytes in
S3, never taken from the client) and of the flattened PDF after signing. Both appear in the
evidence package.

---

## Security model

- **Signing tokens are opaque and DB-backed** (128-bit, 22 chars) — revocable, unlike a JWT.
  Expiry is enforced **in code**; DynamoDB TTL is best-effort GC and is never the boundary.
- **Token ↔ document binding.** Every signer request checks the token's signer against the
  document's current signer *and* a per-send nonce. Re-sending rotates the nonce, killing
  every previously issued link. Without this, a stale token could sign as one person while
  the record named another.
- **Executed documents are final** — `/send` rejects a signed document rather than resetting
  it to `sent`.
- **Atomic sign claim** (`sent → signing`) before any work, so concurrent submits can't both
  flatten and race the same S3 key. Verified: 5 simultaneous submits → one 200, four 410s,
  exactly one `document_signed`.
- **Fails closed** — the server refuses to start without `JWT_SECRET`, or without
  `SENDER_PASSWORD` when `NODE_ENV=production`.
- **The signing link is never logged.** Event metadata is printed verbatim into the evidence
  PDF sent to both parties; a 12-char fingerprint is recorded instead.
- **Audit IPs come from `CloudFront-Viewer-Address`**, not the first `x-forwarded-for` entry
  — CloudFront *appends*, so the first entry is attacker-controlled and these values end up
  in a legal document.
- **ESIGN Act / UETA consent** is captured before signing and recorded as a `consent_given`
  event that appears in the evidence package.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/documents/init` | mint a presigned S3 PUT URL |
| POST | `/documents/:id/complete` | register the upload, hash server-side |
| GET/PUT | `/documents/:id/fields` | list / replace placed fields |
| GET | `/documents/:id/pdf` | presigned GET URL (JSON, not bytes) |
| POST | `/documents/:id/send` | issue token, email signer |
| GET | `/documents/:id/evidence` | presigned evidence URL |
| POST | `/auth/login`, GET `/auth/status` | sender auth |
| GET | `/sign/:token` | doc meta + fields + consent statement |
| GET | `/sign/:token/pdf` | presigned GET URL |
| POST | `/sign/:token` | `{consent, values}` → flatten, commit, email |
| GET | `/sign/:token/signed`, `/evidence` | presigned download URLs |

Sender routes are behind `requireSender`. Signer routes are rate-limited per IP.

**Event types:** `document_uploaded`, `fields_placed`, `link_sent`, `link_opened`,
`consent_given`, `signature_drawn`, `document_signed`, `completion_emailed`,
`completion_email_failed`.

---

## Email

SES from `esign@rippleconsultingservices.com`. Domain verified, DKIM signed, SPF aligned via
custom MAIL FROM (`mail.rippleconsultingservices.com`), DMARC `p=none`.

Messages are `multipart/alternative` (plain-text part is not politeness — a lone `text/html`
body is a spam signal). Completion emails add the signed PDF and evidence as attachments.

Bounce/complaint/delivery events flow to SNS topic `esign-email-events` and on to the
`esign-ses-diagnostics` SQS queue, which is how the receiving MTA's actual SMTP response
gets read.

### ⚑ Known issue — deliverability on a cold domain

The domain is days old. Signature-request emails score as phishing (short message, prominent
CTA link, new domain):

| Recipient | Behavior |
|---|---|
| Microsoft 365 | quarantined (visible, releasable) |
| Google | accepted at SMTP (`250 OK`) then silently discarded, or spam |

A controlled 2×2 (config set × attachment) showed **attachment-bearing mail gets through and
attachment-free mail does not** — mechanism unconfirmed, correlation strong. Completion
emails (which carry attachments) deliver reliably.

Open remedies: attach the source PDF to the request email, move DMARC to `p=quarantine`,
register with Google Postmaster Tools, warm the domain. Per-tenant allowlisting works
immediately (Milton: intake ticket #270).

---

## Repo layout

```
backend/src/
  server.js      Express app — all routes
  handler.js     Lambda entrypoint; resolves SSM secrets before importing server.js
  repo.js        DynamoDB data layer
  db.js          audit-event helper + client IP resolution
  storage.js     S3 put/get/presign
  email.js       SES + dependency-free MIME builder
  templates.js   transactional email templates
frontend/src/pages/
  Upload.jsx  Prepare.jsx  Sign.jsx  Done.jsx  LoginGate.jsx
infra/
  bin/app.js  lib/esign-stack.js     CDK stack
```

---

## Deferred

- Multi-signer & signing order
- Templates / reusable forms
- Reminders / link expiry resend
- Webhooks for status changes
- Neutral domain for esign as a product (a Ripple-branded signing link is wrong for
  client-internal documents)

---

## Decisions log

- **DynamoDB over Postgres** (2026-08-04) — the workload is a handful of envelopes a month;
  an always-on database was the entire cost floor.
- **Opaque tokens over JWT** — JWTs can't be revoked, so a leaked link stayed live 7 days.
- **Events table is the audit log** — the evidence PDF is a projection over it.
- **Deliver completion email *before* responding** — Lambda freezes the execution
  environment when the handler returns, so fire-and-forget work after `res.json()` silently
  never runs. This shipped once: a document was signed and committed and neither party was
  ever emailed, with no error anywhere.

## Last Updated

2026-08-04 — serverless rewrite deployed; Postgres/docker-compose removed.
