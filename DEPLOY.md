# esign — Deploy Runbook

Two ways to run it: **local** (dev, no auth, console email) and **AWS** (CDK, serverless).

---

## Local (dev)

```bash
# Backend
cd backend
cp .env.example .env      # fill JWT_SECRET, DDB_TABLE, S3_BUCKET; leave SENDER_PASSWORD blank
npm install
npm run dev               # :4000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev               # :5173  (Vite proxies /api → :4000)
```

Local dev talks to a **real DynamoDB table** (`esign-dev`) and a real S3 bucket — there is no
local emulator. Credentials come from the default AWS chain (`~/.aws`).

With `EMAIL_MODE=console` the signing link prints to the backend stdout; no mail is sent.
Open http://localhost:5173 → upload → place fields → send → follow the logged link.

### Creating a dev table

```bash
aws dynamodb create-table --table-name esign-dev \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST --region us-east-1
aws dynamodb update-time-to-live --table-name esign-dev \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" --region us-east-1
```

### Real email locally

Set `EMAIL_MODE=ses`. **Only send to addresses you control while testing.**

---

## Production (AWS CDK)

Stack: `EsignStack` in `us-east-1`. Everything is code — Lambda, CloudFront, both S3 buckets,
the DynamoDB table, ACM cert, and the Route 53 record.

### One-time prerequisites

1. **SES**: domain identity verified, DKIM enabled, production access granted, custom
   MAIL FROM configured.
2. **Secrets in SSM Parameter Store** (SecureString):
   ```
   /esign/jwt-secret        long random
   /esign/sender-password   the sender UI login
   /esign/origin-secret     shared secret CloudFront sends as x-esign-origin
   ```
3. **`infra/.deploy-env`** (gitignored) containing the same origin secret, because the
   CloudFront custom header is set at synth time:
   ```
   ESIGN_ORIGIN_SECRET=<same value as /esign/origin-secret>
   ```

### Deploy

```bash
cd frontend && npm ci && npm run build     # CDK ships frontend/dist to the site bucket
cd ../infra
set -a && . ./.deploy-env && set +a
npx cdk deploy --require-approval never
```

First deploy takes ~8 minutes (CloudFront). Subsequent deploys are seconds to ~3 minutes.

### Verify after deploy

```bash
B=https://esign.rippleconsultingservices.com
curl -s $B/api/health                                  # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" $B/s/faketoken # 200 — SPA fallback
curl -s $B/api/sign/bogus                              # {"error":...} — NOT the SPA shell
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/documents/init \
  -H 'Content-Type: application/json' -d '{"filename":"x.pdf"}'   # 401 — auth enforced
```

Also confirm the Lambda Function URL rejects direct calls (403) — that proves the origin
secret is doing its job and the function isn't publicly addressable.

---

## Sender accounts cutover

Multi-sender (magic-link login, per-owner documents). Scripts live in `backend/scripts/`;
each needs `--table`, is a **dry run until `--apply`**, and never prints the API key.

1. **Deploy** (above). Adds GSI1 in place (no table replacement), `LEGACY_SENDER_EMAIL`, and
   forwards `X-Api-Key` through CloudFront. The GSI backfills for a few minutes; it is
   additive and the table stays RETAIN + deletion-protected.
2. **Find the prod table**: `aws cloudformation describe-stacks --stack-name EsignStack --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text --region us-east-1` -> `T`.
3. **Seed senders** (dry run first, then add `--apply`):
   ```bash
   cd backend
   node scripts/seed-user.js --table $T --email aflores@miltonindustries.com    --name "Alex Flores"     --account ripple --role admin
   node scripts/seed-user.js --table $T --email smcquillan@miltonindustries.com --name "Sean McQuillan" --account milton --role sender
   ```
4. **Backfill existing documents to Alex** (docs with no owner are inaccessible until this runs):
   `node scripts/backfill-owners.js --table $T --owner aflores@miltonindustries.com --account ripple --apply`
5. **Issue Alex's API key** (for `send_round.py`):
   `node scripts/issue-api-key.js --table $T --email aflores@miltonindustries.com --label send_round --out ~/Desktop/esign/SENDER-API-KEY.txt --apply`
   Refuses to overwrite an existing file; delete the old file to rotate (old key stays valid until its `APIKEY#` item is deleted).
6. **Smoke test**: request a magic link for Alex at the site, click it, confirm "My documents"
   lists the backfilled docs; repeat for Sean (he should see none). Confirm a live signer link
   (`/s/<token>`) still opens.
7. **Later**: once magic-link is proven, remove `SENDER_PASSWORD_PARAM`, the `/esign/sender-password`
   SSM parameter, and `LEGACY_SENDER_EMAIL` from the stack.

---

## Diagnosing email delivery

SES accepting a message does **not** mean anyone received it. To see the receiving mail
server's actual SMTP response:

```bash
Q=https://sqs.us-east-1.amazonaws.com/157861504221/esign-ses-diagnostics
aws sqs receive-message --queue-url "$Q" --max-number-of-messages 10 \
  --wait-time-seconds 20 --region us-east-1 --output json > /tmp/sqs.json
python3 -c "
import json
d=json.load(open('/tmp/sqs.json'), strict=False)
for m in d.get('Messages',[]):
    ev=json.loads(json.loads(m['Body'], strict=False).get('Message','{}'), strict=False)
    print(ev.get('eventType'), ev.get('mail',{}).get('destination'))
    if ev.get('eventType')=='Delivery':
        print('  ', repr(ev['delivery'].get('smtpResponse')))
"
```

Parse with `strict=False` — SMTP responses contain raw control characters that break the
default JSON decoder.

---

## Re-sending a completion email

For a document that was signed but whose completion email failed:

```bash
cd backend
export AWS_LAMBDA_FUNCTION_NAME=resend-oneoff   # suppresses app.listen()
export DDB_TABLE=<prod table> S3_BUCKET=<prod bucket>
export EMAIL_MODE=ses SES_CONFIGURATION_SET=esign-events AWS_REGION=us-east-1
node -e "
(async () => {
  const repo = await import('./src/repo.js');
  const { getObject } = await import('./src/storage.js');
  const { deliverCompletion } = await import('./src/server.js');
  const doc = await repo.getDocument('<DOC_ID>', {consistent:true});
  const signedBytes = await getObject(doc.s3KeySigned);
  await deliverCompletion({ doc, signedHash: doc.signedHash, signedBytes, req: null });
})()"
```

---

## Regression suite

`phase0-test.sh` exercises the security invariants against a running backend: re-send of a
signed document, stale/superseded tokens, presigned upload, consent enforcement, and token
absence from the evidence PDF. Run it against local dev before any deploy.

---

## ⚑ Human-gated

**Sending a live document to a real counterparty is never automated.** Upload, place fields,
and send only when you explicitly decide to.

---

## Known gaps

- No multi-signer / signing order, no templates, no reminders.
- Cold starts of 2–4s on the flatten path (pdf-lib + pdfkit).
- `frontend/dist` is a large single chunk (pdf.js) — code-split if load time matters.
- Deliverability on a cold sending domain — see `project.md`.
