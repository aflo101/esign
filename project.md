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

One DynamoDB table. One partition per document — the layout *supports* fetching the
document, its fields, and the audit trail in a single Query, though the code reads each
prefix separately (three cheap Queries on the same partition), each one fully paginated
past DynamoDB's 1MB page cap.

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
- **Audit IPs come from `CloudFront-Viewer-Address`**, forwarded by an explicit allowlist
  origin-request policy (CloudFront-generated headers only reach the origin when listed —
  no managed all-viewer policy carries this one). Fallback is the *last* `x-forwarded-for`
  entry, which CloudFront appends and a client cannot control; the first entry is
  attacker-chosen and is never used. These values end up in a legal document.
- **ESIGN Act / UETA consent** is captured before signing and recorded as a `consent_given`
  event that appears in the evidence package.
- **The evidence package cannot lose the signing events.** `listEvents` drains the full
  Query cursor, and under log-flooding pressure the renderer summarizes `link_opened`
  (count + first/last) and keeps both ends of the timeline rather than a most-recent
  window that a flooded log could push `document_signed` out of.
- **Append-only is enforced** — event writes are conditional (`attribute_not_exists`), so
  an SK collision throws and retries with a fresh key instead of silently overwriting an
  audit record.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/documents/init` | mint a presigned S3 PUT URL |
| POST | `/documents/:id/complete` | register the upload, hash server-side |
| GET/PUT | `/documents/:id/fields` | list / replace placed fields |
| GET | `/documents/:id/pdf` | presigned GET URL (JSON, not bytes) |
| POST | `/documents/:id/send` | issue token, email signer (+ optional `cc_email`) |
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

### CC

`/send` accepts `cc_email` (a string or array; comma- or semicolon-separated lists are split,
because these get pasted out of mail clients). `SES_DEFAULT_CC` copies **every** envelope and
per-send addresses are added on top of it, not instead of it. Cc'd parties receive both the
signature request and the completion mail with the signed PDF + evidence attached — a copy of
the request without a copy of the result is the useless half.

- Addresses are validated **before** the token is minted. A malformed address makes SES reject
  the whole `SendEmail` call, which would otherwise fail a send whose link is already live.
- `cc == signer` is dropped and duplicates are deduped case-insensitively — SES rejects a
  `Destination` that repeats an address.
- The `Cc:` MIME header is kept in sync with `CcAddresses`. SES honours the envelope either
  way, but a recipient who cannot see themselves in the headers reads the mail as bcc'd spam.
- `ccEmails` is **overwritten** on each send, never appended — a re-send re-states the
  recipient set, so a cc dropped from the second send must not survive from the first.
- Cap: **10** cc addresses per document.

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

## Assurance tier (state it, don't oversell it)

- **Possession of the emailed link is the only signer credential.** No OTP, no sign-time
  identity re-verification — comparable to DocuSign's basic tier. A forwarded email can be
  signed by whoever holds it; the audit trail records the *clicker's* IP/UA. Say this when
  it matters; add an access code or emailed OTP if a document ever warrants more.
- **⚑ Every cc is therefore a second party who can sign.** CC does not create a read-only
  observer — it puts the sole signer credential in another mailbox, and the audit trail will
  name the signer as whoever the document says it is regardless of who clicked. `link_sent`
  records `cc_emails` so the evidence package shows who else held the link. Do not cc a
  distribution list or shared mailbox on a document that matters.
- **The signature is a flattened image + SHA-256 hash chain, not a PKI/PAdES signature.**
  Integrity rests on the hashes in DynamoDB and in both parties' inboxes, not on a
  cryptographic signature embedded in the PDF.
- `link_opened` events include mail-scanner prefetches (e.g. Defender Safe Links) — opens
  are not proof a human viewed the document.
- Field cap is **50 per document** (delete+put of the full set must fit one 100-op
  DynamoDB transaction; a higher cap made documents uneditable after the first save).

## Deferred

- Multi-signer & signing order
- Templates / reusable forms
- Reminders (link expiry resend works today — re-POST `/send`, which rotates the nonce)
- Webhooks for status changes
- Orphan-upload sweep (tag-on-complete + expire-untagged lifecycle rule)
- CloudWatch alarms (Lambda errors, SES bounce/complaint rate) — SES events flow to the
  `esign-email-events` SNS topic / `esign-ses-diagnostics` SQS queue, but those are
  manual out-of-band resources, not part of the CDK stack
- RFC 2231 encoding for non-ASCII attachment filenames (currently RFC 2047-in-parameter,
  which most but not all clients render)
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

## Milestones

- **2026-08-07 — first real executed envelope**: Sean McQuillan signed the Milton AI
  Acceptable Use Policy (16:36 CDT). Full clean trail: consent → signature → signed →
  completion emailed.

## Last Updated

2026-09-11 — **CC support added.** `/send` takes `cc_email`; `SES_DEFAULT_CC` copies every
envelope. Cc'd parties get the signature request and the executed PDF + evidence, are recorded
in `link_sent` and the evidence package, and are validated/deduped before the token is minted.
Regression suite extended to **31 checks** (10 new, covering self-cc, case-insensitive dedupe,
malformed and over-cap rejection, cc cleared on re-send, and cc receiving the executed doc).
Assurance tier updated: **a cc is a second party who can sign**, not a read-only observer.

*Prior: 2026-08-10 — second adversarial review's findings closed: event/field queries fully
paginated (evidence PDF could previously drop `document_signed` past 1MB of events),
flood-resistant evidence rendering, conditional event writes, field cap corrected to an
honest 50, `/send` reports email failure instead of 500ing a half-sent document,
`CloudFront-Viewer-Address` actually forwarded, MIME quote-escaping, docs de-fictioned,
regression suite moved into the repo (`phase0-test.sh`, 21 checks).*
