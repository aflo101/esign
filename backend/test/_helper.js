// Shared test harness. Boots the real Express app in-process against the DEV table
// (esign-dev) and tracks every item it creates so cleanup() can remove it.
//
// Safety: refuses to run against anything but esign-dev. S3 is never touched over the
// network — storage's S3 client `send` is stubbed (presigning is local signing only).
import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, QueryCommand, DeleteCommand, ScanCommand,
} from '@aws-sdk/lib-dynamodb';

export async function boot(overrides = {}) {
  Object.assign(process.env, {
    AWS_LAMBDA_FUNCTION_NAME: 'tests-no-listen', NODE_ENV: 'test', EMAIL_MODE: 'console', JWT_SECRET: 'test-secret',
    DDB_TABLE: 'esign-dev', APP_BASE_URL: 'http://localhost',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    // .env may define these; dotenv never overrides, so pin them here.
    SENDER_PASSWORD: '', LEGACY_SENDER_EMAIL: '', DEV_SENDER_EMAIL: '', ORIGIN_SECRET: '',
    S3_BUCKET: process.env.S3_BUCKET || 'test-bucket-never-contacted',
    ...overrides,
  });
  if (process.env.DDB_TABLE !== 'esign-dev') throw new Error('tests may only run against esign-dev');

  const repo = await import('../src/repo.js');
  const storage = await import('../src/storage.js');
  const { app } = await import('../src/server.js');
  // No network to S3, ever: fake only what the routes under test call.
  storage.s3.send = async (cmd) => {
    const name = cmd.constructor.name;
    if (name === 'HeadObjectCommand') return { ContentLength: 8, ContentType: 'application/pdf' };
    if (name === 'GetObjectCommand') return { Body: [Buffer.from('%PDF-1.4\n')] };
    throw new Error(`unexpected S3 call in tests: ${name}`);
  };

  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
  const TABLE = repo.TABLE;
  const pks = new Set();
  const rlIps = new Set(); // per-IP rate-limit buckets we touched (name#ip)

  // Every request gets a fresh fake client IP so the per-IP rate limiters never trip
  // unless a test deliberately reuses one.
  const randIp = () => `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(256)}`;
  async function call(method, path, { body, headers = {}, auth, ip } = {}) {
    const useIp = ip || randIp();
    const bucket = path.startsWith('/auth/magic-link') ? 'magic' : path.startsWith('/auth/verify') ? 'verify'
      : path.startsWith('/auth/login') ? 'login' : path.startsWith('/sign/') ? 'sign' : null;
    if (bucket) rlIps.add(`${bucket}#${useIp}`);
    const h = { 'x-forwarded-for': useIp, ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (auth) h.authorization = `Bearer ${auth}`;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
  }

  const uniq = () => crypto.randomBytes(6).toString('hex');
  const email = (tag = 't') => `${tag}-${uniq()}@test.invalid`;

  async function makeUser({ name = 'Test User', disabled = false, tag } = {}) {
    const e = email(tag);
    await repo.putUser({ email: e, name, accountId: 'testacct', role: 'sender', disabled });
    pks.add(`USER#${e}`);
    return { email: e, name };
  }
  async function signJwt(user) {
    const { default: jwt } = await import('jsonwebtoken');
    return jwt.sign({ role: 'sender', sub: user.email, name: user.name, acct: 'testacct' }, 'test-secret', { expiresIn: '1h' });
  }
  async function makeDoc(owner, extra = {}) {
    const id = crypto.randomUUID();
    await repo.createDocument({
      id, filename: `t-${id.slice(0, 6)}.pdf`, originalHash: 'x', s3KeyOriginal: `documents/${id}/original.pdf`,
      senderEmail: owner?.email ?? null, ownerEmail: owner?.email ?? null, accountId: 'testacct',
    });
    pks.add(`DOC#${id}`);
    return id;
  }

  async function deletePartition(pk) {
    let ExclusiveStartKey;
    do {
      const out = await raw.send(new QueryCommand({
        TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': pk },
        ProjectionExpression: 'PK, SK', ExclusiveStartKey,
      }));
      for (const it of out.Items || []) await raw.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }

  async function cleanup(extraPks = []) {
    for (const pk of [...pks, ...extraPks]) await deletePartition(pk);
    // Rate-limit counters for our emails (current + previous window) and fake IP buckets
    // are TTL'd; the per-email ones are cheap to remove explicitly.
    const w = Math.floor(Date.now() / 1000 / 900);
    for (const pk of [...pks]) {
      if (!pk.startsWith('USER#')) continue;
      const e = pk.slice(5);
      for (const win of [w - 1, w, w + 1]) await deletePartition(`RL#magicemail#${e}#${win}`);
    }
    for (const extra of extras) await deletePartition(extra);
    for (const b of rlIps) for (const win of [w - 1, w, w + 1]) await deletePartition(`RL#${b}#${win}`);
    server.closeAllConnections?.(); await new Promise(r => server.close(r));
  }
  const extras = [];
  const track = (pk) => { pks.add(pk); };
  const trackExtra = (pk) => { extras.push(pk); };

  // Capture the magic link the server "emails" (console mode logs it).
  async function captureMagicToken(fn) {
    const orig = console.log; let out = '';
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    try { await fn(); } finally { console.log = orig; }
    const m = out.match(/http:\/\/localhost\/login\/([A-Za-z0-9_-]+)/);
    if (m) pks.add(`LOGIN#${crypto.createHash('sha256').update(m[1]).digest('hex')}`);
    return m ? m[1] : null;
  }

  return { repo, call, email, makeUser, makeDoc, signJwt, cleanup, track, trackExtra, captureMagicToken, raw, TABLE };
}
