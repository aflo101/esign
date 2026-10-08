// Issue an API key for a sender (for scripts, sent as X-Api-Key). DRY RUN unless --apply.
//   node scripts/issue-api-key.js --table T --email a@b.com --label send_round --out ~/key.txt [--apply]
// Plaintext goes ONLY to --out (mode 600); the table stores the sha256. Output shows a fingerprint, never the key.
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, ddbDoc } from './_args.js';

const o = parseArgs(['table', 'email', 'label', 'out']);
const email = String(o.email).trim().toLowerCase();
const out = path.resolve(String(o.out).replace(/^~(?=\/|$)/, os.homedir()));
const db = ddbDoc();
const user = (await db.send(new GetCommand({ TableName: o.table, Key: { PK: `USER#${email}`, SK: 'META' } }))).Item;
if (!user || user.disabled) { console.error(`No active user ${email} in ${o.table}. Seed first.`); process.exit(1); }
if (existsSync(out)) { console.error(`${out} already exists; refusing to overwrite.`); process.exit(1); }

const key = 'esk_' + randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
console.log(`${o.apply ? 'ISSUE' : 'would issue'} key for ${email} label=${o.label} fingerprint=${hash.slice(0, 12)} out=${out}`);
if (!o.apply) { console.log('dry run — pass --apply to write.'); process.exit(0); }

// File first (exclusive create, 600), then the hash: a failure between them leaves an unusable file, not a live unknown key.
writeFileSync(out, key + '\n', { mode: 0o600, flag: 'wx' });
chmodSync(out, 0o600);
await db.send(new PutCommand({
  TableName: o.table,
  Item: { PK: `APIKEY#${hash}`, SK: 'META', entity: 'apikey', email, label: o.label, createdAt: new Date().toISOString() },
}));
console.log(`written. fingerprint=${hash.slice(0, 12)}`);
