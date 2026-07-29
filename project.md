# esign — E-Signature App

DocuSign-esque single-contract e-sign: sender places fields → signer completes a guided flow →
all fields flattened onto the PDF → signed doc + evidence package emailed to both parties.
**v2 built & tested 2026-07-21** (see below); deploy-ready via Docker + Caddy (single signer per doc).

## Scope (v1)

5-step flow: upload PDF → email signing link → signer opens & draws → flatten signature onto PDF → email signed doc + evidence package to both parties.

Signer places own signature (no sender-side field placement UI). One signer per doc.

## v2 — DocuSign-esque single-contract MVP (2026-07-21) — BUILT & TESTED

Goal: a self-hosted signing link that replaces DocuSign for countersignatures. Adds **sender-side field placement** (the main gap vs. DocuSign) + productionizing. First production envelope = a client SOW amendment. **Deploy runbook: [DEPLOY.md](DEPLOY.md).**

- **✅ Phase 1 — Field placement (sender):** `fields` table; `GET/PUT /documents/:id/fields`; sender `GET /documents/:id/pdf`; sender flow split into **Upload → Prepare (drag-drop/resize fields) → Send**. Types: signature, initials, date, name, text, checkbox. *Smoke-tested (upload → place → read-back → validation reject).*
- **✅ Phase 2 — Guided signing (recipient):** `GET /sign/:token` returns placed fields; new signer UI overlays them, **Start→Next** navigation, fill via modal (draw signature/initials, type name/text, auto date, toggle checkbox), Finish blocked until required done.
- **✅ Phase 3 — Flatten all fields:** `POST /sign/:token` takes `{values}`, validates required, stamps every field at stored coords (image / text / checkbox), preserves aspect ratio, adds a completion footer; evidence package now lists completed fields. *Verified via pdftotext — name/date/checkbox/footer render; full audit trail present.*
- **✅ Phase 4 — Productionize:** **SES email** (dependency-free MIME w/ attachments, env-gated; **live-tested to owner-controlled addresses**, no errors); **post-sign download** links (signed PDF + evidence) on the Done page; **env-gated sender auth** (`SENDER_PASSWORD` → login + Bearer JWT; off in dev, on in prod; 401/login/200 tested). Deploy **packaged** (Dockerfile + docker-compose + Caddy auto-TLS + `.env.example`) — see DEPLOY.md.
- **◻ Phase 5 — First production envelope:** source document converted to PDF and staged locally. Upload → place Signature+Date → send is **human-gated** (outward action, fired manually).

**⚑ Two steps intentionally left manual** (see DEPLOY.md § Human-gated):
1. **Provision + DNS** — stand up the host, point the signing subdomain at it, `docker compose up` (billable + touches DNS → approve the shape first).
2. **Send the first real envelope** — outward action; fire when ready.

Coordinate convention (unchanged): normalized 0–1, **top-left origin**; backend flatten converts to pdf-lib bottom-left. Single signer for MVP (no recipient_id yet).

**SES:** the sending account has production access; the sender identity is verified + DKIM-signed. *(Account ID, bucket name, and sender address live in `backend/.env` — not in this repo.)* **New backend dep:** `@aws-sdk/client-sesv2`. **New files:** `frontend/src/pages/{Prepare,LoginGate}.jsx`, `frontend/src/api.js`, `backend/Dockerfile`, `Caddyfile`, `docker-compose.yml`, `backend/.env.example`, `DEPLOY.md`.

## AWS deployment plan (target home) — 2026-07-21

Two options; **recommendation = Managed** (it's a legal-document service → managed DB backups, no server to patch, CDN TLS). Lean is a cheap throwaway if we want it live same-day.

| | Lean (~$10–20/mo) | **Managed (recommended, ~$35–45/mo)** |
|---|---|---|
| Backend | 1 small box + docker-compose | **App Runner** (image from ECR) |
| DB | Postgres container | **RDS Postgres** t4g.micro (private, encrypted, PITR) |
| Frontend | Caddy serves dist | **S3 (private) + CloudFront** (OAC) |
| TLS | Caddy auto-cert | **ACM + CloudFront** |
| Ops | self-patch | fully managed |

**Managed topology:** Route 53 (`esign.example.com`) → CloudFront → S3 (SPA, default) + `/api/*` → App Runner (CloudFront Function strips `/api`, matches the dev Vite proxy) → App Runner backend (instance role → S3 docs + SES) → RDS Postgres via VPC connector (private subnets, SG-locked to 5432). Secrets Manager holds `JWT_SECRET` / DB creds / `SENDER_PASSWORD`. **No static AWS keys** — instance role for the app, GitHub OIDC for CI/CD.

**Component map:** Frontend → S3+CloudFront · Backend → App Runner (ECR, reuses `Dockerfile`) · DB → RDS t4g.micro · Docs → S3 `<S3_BUCKET>` (→ rename `esign-prod-*`, SSE-S3, BPA on) · Email → SES · Secrets → Secrets Manager · DNS/TLS → Route 53 + ACM (us-east-1) · CI/CD → GitHub Actions (OIDC): build→ECR→App Runner deploy + frontend build→S3 sync→CF invalidate · Logs/alarms → CloudWatch (5xx, RDS CPU/storage).

**Build order:** (1) foundations — VPC/subnets/SGs, ECR, 3 secrets, IAM roles; (2) RDS + run migration; (3) push image → App Runner (VPC connector, env from secrets, `/health` check); (4) S3+CloudFront (OAC, ACM, two behaviors + CF Function); (5) Route 53 alias + set `APP_BASE_URL`; (6) GitHub Actions CI/CD; (7) CloudWatch alarms + RDS backups + S3 lifecycle; (8) end-to-end test → first real envelope.

**IAM least-privilege (App Runner instance role):** `s3:GetObject/PutObject` on the docs bucket, `ses:SendEmail` from the verified identity, `secretsmanager:GetSecretValue` on the 3 secrets. Nothing else.

## Status / where we're at (2026-07-21)

- **Code:** v2 MVP **built + tested locally** (field placement, guided signing, multi-field flatten, SES email live-tested to owner-controlled addresses, env-gated auth). Frontend builds; backend syntax clean.
- **Deploy:** **packaged** (Dockerfile + compose + Caddy + `.env.example` + `DEPLOY.md`) and **AWS plan documented** (above). **Nothing provisioned in AWS yet** — no App Runner/RDS/CloudFront/ECR created.
- **⚑ PENDING DECISIONS before provisioning:** (1) **Lean vs Managed** — rec Managed; (2) **Region** — us-east-1 (matches the existing SES/S3 setup)?; (3) **Subdomain** to host it on; (4) **Where that domain's DNS lives** — Route 53 or another registrar (drives the DNS step).
- **Human-gated (unchanged):** provision + DNS (billable, touches the domain); sending the first real envelope (source document staged locally, outside this repo).

## Stack

- **Backend**: Node 25 + Express (ESM), Postgres 16 (local), S3, pdf-lib (flatten), PDFKit (evidence)
- **Frontend**: Vite + React + react-router, pdf.js for rendering, HTML canvas for signature capture
- **Auth**: JWT signing tokens (7d expiry). No sender auth yet — localhost only.
- **Email**: stubbed via `EMAIL_MODE=console` (logs to backend stdout). SES wiring deferred.

## Paths

- Backend: `~/Desktop/esign/backend/` — runs on `:4000`
- Frontend: `~/Desktop/esign/frontend/` — runs on `:5173`
- DB: local Postgres, database `esign`
- S3 bucket: `<S3_BUCKET>` (us-east-1, private, all public access blocked)
- Backend env: `~/Desktop/esign/backend/.env`

## Run

```bash
# Postgres (one-time install via Homebrew, runs as launchd service)
brew services start postgresql@16

# Backend
cd ~/Desktop/esign/backend && npm run dev     # logs to /tmp/esign-backend.log when bg

# Frontend
cd ~/Desktop/esign/frontend && npm run dev

# Migrate (re-run if schema changes)
cd ~/Desktop/esign/backend && npm run migrate
```

## Data model

Two tables only — `documents` (current state) + `events` (append-only audit log). Events table IS the audit trail; evidence package is a formatted projection over it.

Hashing: SHA-256 of original PDF bytes on upload, SHA-256 of flattened PDF after signing. Both stored on the document row and printed in the evidence package.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/documents` | multipart upload PDF → hash, S3 store, return id |
| POST | `/documents/:id/send` | issue JWT link, email signer |
| GET/PUT | `/documents/:id/fields` | list / replace placed fields (sender; v2) |
| GET  | `/documents/:id/pdf` | stream original PDF for the sender's Prepare page (v2) |
| POST | `/auth/login`, GET `/auth/status` | env-gated sender auth (v2) |
| GET  | `/sign/:token` | verify token, log `link_opened`, return doc meta **+ fields** |
| GET  | `/sign/:token/pdf` | stream original PDF for signer view |
| POST | `/sign/:token` | accept `{values}` for all fields, flatten, email both parties (v2) |
| GET  | `/sign/:token/signed`, `/sign/:token/evidence` | signer downloads post-sign (v2) |
| GET  | `/documents/:id/evidence` | render evidence PDF |

Sender routes (`/documents*`) are guarded by `requireSender` — enforced only when `SENDER_PASSWORD` is set.

## Event types

`document_uploaded`, `fields_placed`, `link_sent`, `link_opened`, `signature_drawn`, `document_signed`, `completion_emailed`. Each row captures ip, user_agent, and type-specific metadata jsonb.

## Deferred (v2+)

- ✅ **Sender auth** — done (env-gated, `SENDER_PASSWORD`).
- ✅ **Real email** — done (SES via `@aws-sdk/client-sesv2`, production access).
- ✅ **Sender-side field placement** — done (Prepare page, drag/resize).
- **Multi-signer & signing order**
- **Templates / reusable forms**
- **Reminders / link expiry resend**
- **Webhooks for status changes**
- **Migrate multer 1.x → 2.x** (deprecation warning at install)

## Decisions log

- **Postgres over SQLite** — chose Postgres now (2026-06-10) to match eventual production stack; cost is one Homebrew install.
- **S3 over R2** — AWS already configured in this account; R2 savings irrelevant at prototype volume.
- **Signer places own signature** — skips sender-side field UI; cuts build time dramatically. Re-evaluate before any external use.
- **Events table = audit log** — no separate audit table later. Evidence PDF is a projection over events.
- **JWT links over DB-backed sessions** — stateless, simpler. Expiry baked into token.

## Known gaps

- No rate limiting, no CSRF (mitigated by localhost-only).
- Token, once issued, valid for 7d — no revocation other than `status='signed'` check.
- Signature placement is fixed-size (25% × 8% of page) — no resize handle.
- Frontend doesn't currently surface the evidence PDF download link to the signer/sender post-sign.
