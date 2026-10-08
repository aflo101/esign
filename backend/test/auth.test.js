// Sender auth: magic link, verify, session, API key, disabled users.
// Runs against esign-dev. Every item created is removed in after().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { boot } from './_helper.js';

let t, alice, ghostEmail;
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

before(async () => {
  t = await boot();
  alice = await t.makeUser({ name: 'Alice Test' });
  ghostEmail = t.email('ghost');
});
after(async () => { await t.cleanup(); });

test('magic-link: always 200 {ok:true}, known and unknown, identical bodies', async () => {
  let known, unknown, malformed, missing;
  const tok = await t.captureMagicToken(async () => {
    known = await t.call('POST', '/auth/magic-link', { body: { email: alice.email } });
  });
  unknown = await t.call('POST', '/auth/magic-link', { body: { email: ghostEmail } });
  malformed = await t.call('POST', '/auth/magic-link', { body: { email: 'not-an-email' } });
  missing = await t.call('POST', '/auth/magic-link', { body: {} });
  for (const r of [known, unknown, malformed, missing]) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  }
  assert.ok(tok, 'known user must get a link emailed (captured from console mode)');
  assert.ok(tok.length >= 43, '32 random bytes base64url');
  // Unknown address must not have produced a login item or user.
  assert.equal(await t.repo.getUser(ghostEmail), null);
});

test('magic-link: case/whitespace-insensitive email, token stored hashed only', async () => {
  let token;
  token = await t.captureMagicToken(() =>
    t.call('POST', '/auth/magic-link', { body: { email: `  ${alice.email.toUpperCase()} ` } }));
  assert.ok(token);
  const { Item } = await t.raw.send(new GetCommand({ TableName: t.TABLE, Key: { PK: `LOGIN#${sha(token)}`, SK: 'META' } }));
  assert.ok(Item, 'stored under the hash');
  assert.equal(Item.email, alice.email);
  assert.ok(!JSON.stringify(Item).includes(token), 'plaintext token must not be stored');
  const plain = await t.raw.send(new GetCommand({ TableName: t.TABLE, Key: { PK: `LOGIN#${token}`, SK: 'META' } }));
  assert.equal(plain.Item, undefined);
  t.track(`LOGIN#${sha(token)}`);
});

test('magic-link: disabled user gets 200 but no email/token', async () => {
  const dis = await t.makeUser({ disabled: true, tag: 'dis' });
  const tok = await t.captureMagicToken(async () => {
    const r = await t.call('POST', '/auth/magic-link', { body: { email: dis.email } });
    assert.deepEqual(r.body, { ok: true });
  });
  assert.equal(tok, null);
});

test('magic-link: per-email limit (5/15min) stays 200 but stops issuing', async () => {
  const u = await t.makeUser({ tag: 'rl' });
  let issued = 0;
  for (let i = 0; i < 7; i++) {
    const tok = await t.captureMagicToken(async () => {
      const r = await t.call('POST', '/auth/magic-link', { body: { email: u.email } });
      assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
    });
    if (tok) { issued++; t.track(`LOGIN#${sha(tok)}`); }
  }
  assert.equal(issued, 5);
});

test('magic-link: per-IP limit returns 429 after 10', async () => {
  const ip = '10.99.99.' + crypto.randomInt(250);
  let last;
  for (let i = 0; i < 11; i++) last = await t.call('POST', '/auth/magic-link', { body: { email: ghostEmail }, ip });
  assert.equal(last.status, 429);
  t.trackExtra(`RL#magic#${ip}#${Math.floor(Date.now() / 1000 / 900)}`);
});

test('verify: single use, returns session usable on /auth/me', async () => {
  const u = await t.makeUser({ name: 'Verify Me', tag: 'ver' });
  let token = await t.captureMagicToken(() => t.call('POST', '/auth/magic-link', { body: { email: u.email } }));
  assert.ok(token);
  const ok = await t.call('POST', '/auth/verify', { body: { token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, u.email);
  assert.equal(ok.body.user.name, 'Verify Me');
  const claims = jwt.verify(ok.body.token, 'test-secret');
  assert.equal(claims.role, 'sender'); assert.equal(claims.sub, u.email);

  const me = await t.call('GET', '/auth/me', { auth: ok.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, u.email);
  const st = await t.call('GET', '/auth/status', { auth: ok.body.token });
  assert.equal(st.body.authenticated, true);

  // Replay
  const again = await t.call('POST', '/auth/verify', { body: { token } });
  assert.equal(again.status, 401);
});

test('verify: concurrent double-consume has exactly one winner', async () => {
  const u = await t.makeUser({ tag: 'race' });
  const token = await t.captureMagicToken(() => t.call('POST', '/auth/magic-link', { body: { email: u.email } }));
  const rs = await Promise.all([1, 2, 3, 4].map(() => t.call('POST', '/auth/verify', { body: { token } })));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(rs.filter(r => r.status === 401).length, 3);
});

test('verify: expired token rejected (and consumed)', async () => {
  const u = await t.makeUser({ tag: 'exp' });
  const token = crypto.randomBytes(32).toString('base64url');
  await t.repo.putLoginToken({ token, email: u.email, expiresAt: Date.now() - 1000 });
  t.track(`LOGIN#${sha(token)}`);
  const r = await t.call('POST', '/auth/verify', { body: { token } });
  assert.equal(r.status, 401);
});

test('verify: bad / missing / oversized / non-string tokens -> 401, same body', async () => {
  const bodies = [];
  for (const body of [{ token: 'nope' }, {}, { token: '' }, { token: 'x'.repeat(500) }, { token: { $ne: 1 } }, { token: ['a'] }]) {
    const r = await t.call('POST', '/auth/verify', { body });
    assert.equal(r.status, 401, JSON.stringify(body).slice(0, 40));
    bodies.push(JSON.stringify(r.body));
  }
  assert.equal(new Set(bodies).size, 1, 'identical error body for every failure mode');
});

test('verify: token for a user disabled after issue is rejected', async () => {
  const u = await t.makeUser({ tag: 'dis2' });
  const token = await t.captureMagicToken(() => t.call('POST', '/auth/magic-link', { body: { email: u.email } }));
  await t.repo.putUser({ email: u.email, name: u.name, accountId: 'testacct', disabled: true });
  const r = await t.call('POST', '/auth/verify', { body: { token } });
  assert.equal(r.status, 401);
});

test('session: bad signature, wrong role, no-sub, alg none, expired -> 401', async () => {
  const good = await t.signJwt(alice);
  assert.equal((await t.call('GET', '/auth/me', { auth: good })).status, 200);
  const forged = jwt.sign({ role: 'sender', sub: alice.email }, 'other-secret');
  assert.equal((await t.call('GET', '/auth/me', { auth: forged })).status, 401);
  const wrongRole = jwt.sign({ role: 'signer', sub: alice.email }, 'test-secret');
  assert.equal((await t.call('GET', '/auth/me', { auth: wrongRole })).status, 401);
  const noSub = jwt.sign({ role: 'sender' }, 'test-secret'); // pre-accounts token shape
  assert.equal((await t.call('GET', '/auth/me', { auth: noSub })).status, 401);
  const expired = jwt.sign({ role: 'sender', sub: alice.email }, 'test-secret', { expiresIn: -10 });
  assert.equal((await t.call('GET', '/auth/me', { auth: expired })).status, 401);
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'sender', sub: alice.email })).toString('base64url')}.`;
  assert.equal((await t.call('GET', '/auth/me', { auth: none })).status, 401);
  const unknownUser = jwt.sign({ role: 'sender', sub: t.email('nouser') }, 'test-secret');
  assert.equal((await t.call('GET', '/auth/me', { auth: unknownUser })).status, 401);
  assert.equal((await t.call('GET', '/auth/me')).status, 401);
  const st = await t.call('GET', '/auth/status');
  assert.deepEqual(st.body, { authRequired: true, authenticated: false });
});

test('session: disabling a user kills an already-issued JWT immediately', async () => {
  const u = await t.makeUser({ tag: 'kill' });
  const jwtTok = await t.signJwt(u);
  assert.equal((await t.call('GET', '/auth/me', { auth: jwtTok })).status, 200);
  await t.repo.putUser({ email: u.email, name: u.name, accountId: 'testacct', disabled: true });
  assert.equal((await t.call('GET', '/auth/me', { auth: jwtTok })).status, 401);
});

test('API key: works, hash-only storage, unknown key 401, disabled user 401, bad key does not fall back to bearer', async () => {
  const u = await t.makeUser({ tag: 'key' });
  const key = 'esk_' + crypto.randomBytes(32).toString('base64url');
  await t.repo.putApiKey({ key, email: u.email, label: 'test' });
  t.track(`APIKEY#${sha(key)}`);

  const ok = await t.call('GET', '/auth/me', { headers: { 'x-api-key': key } });
  assert.equal(ok.status, 200); assert.equal(ok.body.email, u.email);

  const bad = await t.call('GET', '/auth/me', { headers: { 'x-api-key': key + 'x' } });
  assert.equal(bad.status, 401);
  // A bad key must not be rescued by a valid bearer (no credential mixing).
  const mixed = await t.call('GET', '/auth/me', { headers: { 'x-api-key': 'esk_wrong' }, auth: await t.signJwt(u) });
  assert.equal(mixed.status, 401);

  const plain = await t.raw.send(new GetCommand({ TableName: t.TABLE, Key: { PK: `APIKEY#${key}`, SK: 'META' } }));
  assert.equal(plain.Item, undefined);

  await t.repo.putUser({ email: u.email, name: u.name, accountId: 'testacct', disabled: true });
  const dis = await t.call('GET', '/auth/me', { headers: { 'x-api-key': key } });
  assert.equal(dis.status, 401);
});

test('API key pointing at a deleted user -> 401', async () => {
  const key = 'esk_' + crypto.randomBytes(32).toString('base64url');
  await t.repo.putApiKey({ key, email: t.email('orphan'), label: 'orphan' });
  t.track(`APIKEY#${sha(key)}`);
  assert.equal((await t.call('GET', '/auth/me', { headers: { 'x-api-key': key } })).status, 401);
});

test('legacy /auth/login disabled when SENDER_PASSWORD unset', async () => {
  const r = await t.call('POST', '/auth/login', { body: { password: 'anything' } });
  assert.equal(r.status, 401);
});

test('sender routes reject unauthenticated calls', async () => {
  for (const [m, p] of [['GET', '/documents'], ['POST', '/documents/init'], ['GET', `/documents/${crypto.randomUUID()}`]]) {
    assert.equal((await t.call(m, p, { body: m === 'POST' ? {} : undefined })).status, 401, `${m} ${p}`);
  }
});
