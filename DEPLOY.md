# esign — Deploy Runbook

Two ways to run it: **local** (dev, no auth, console email) and **production** (Docker + Caddy + SES).

---

## Local (dev)

```bash
# Postgres (once)
brew services start postgresql@16

# Backend
cd backend
cp .env.example .env          # fill DATABASE_URL, JWT_SECRET; leave SENDER_PASSWORD blank; EMAIL_MODE=console
npm install
npm run migrate
npm run dev                   # :4000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev                   # :5173  (Vite proxies /api → :4000)
```

Open http://localhost:5173 → upload → place fields → send. In console mode the signing
link is printed to the backend stdout (no real email). Follow the link to sign.

### Real email locally
Set `EMAIL_MODE=ses` in `backend/.env` (AWS creds via `~/.aws`). SES is in production
access on account <AWS_ACCOUNT_ID>; `esign@example.com` is a verified,
DKIM-signed sender. **Only send to addresses you control while testing.**

---

## Production (Docker Compose + Caddy)

Topology: **Caddy** (auto-TLS, serves the built SPA, proxies `/api/*` → backend) →
**backend** (Node, :4000) → **Postgres**. S3 + SES via AWS. Backend code is unchanged
between dev and prod — Caddy strips `/api` exactly like the Vite dev proxy.

### 1. Host + DNS
- A small Linux host with Docker (EC2 t3.small / Lightsail ~$10–20/mo is plenty).
- Point an A-record at it: `esign.example.com → <host IP>`.
  *(example.com is already a verified SES domain — same registrar/DNS.)*

### 2. Config
```bash
cd backend && cp .env.example .env
# set: JWT_SECRET (long random), EMAIL_MODE=ses, SENDER_PASSWORD (enable auth!),
#      APP_BASE_URL=https://esign.example.com
```
Set compose secrets in the shell or an `.env` beside docker-compose.yml:
`DB_PASSWORD`, and (if not using an instance role) `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
Prefer an **EC2 instance role** with S3 + SES permissions over static keys.

### 3. Build the frontend + bring it up
```bash
cd frontend && npm ci && npm run build      # → frontend/dist (Caddy serves this)
cd .. && docker compose up -d --build
docker compose exec backend npm run migrate # first run only
```
Caddy fetches a TLS cert automatically. App is live at the domain; `/api/*` → backend.

### 4. Verify
- `https://esign.…/` loads → login prompt (because SENDER_PASSWORD is set).
- Upload a PDF, place fields, send to an address you control, sign, confirm the signed
  PDF + evidence arrive.

### AWS IAM (least-privilege) the backend needs
- **S3**: `s3:PutObject`, `s3:GetObject` on `<S3_BUCKET>/*`.
- **SES**: `ses:SendEmail` (SESv2) from the verified identity.

---

## ⚑ Human-gated steps (intentionally NOT done autonomously)
1. **Provision + DNS** — standing up the always-on host and pointing
   `esign.example.com` at it is billable + touches your domain. Approve the
   shape (host size / topology) and run §Production above.
2. **The first real envelope** — sending a live document to a real counterparty is an
   outward action and is never automated. Upload the PDF, place a Signature + Date,
   and send only when you explicitly decide to.

## Known gaps / next
- Sender-auth token expiry (12h) isn't auto-refreshed in the UI — on 401 the sender
  re-logs-in. Fine for MVP.
- No multi-signer / signing order, no templates, no reminders (all deferred in project.md).
- `frontend/dist` chunk is large (pdf.js) — code-split later if load time matters.
