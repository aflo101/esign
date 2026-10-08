// Ownership isolation, listing, send identity, revoke, complete. Runs against esign-dev;
// S3 is stubbed in _helper (no network), email is console mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { boot } from './_helper.js';

let t, A, B, tokA, tokB, docA, docAsent;

before(async () => {
  t = await boot();
  A = await t.makeUser({ name: 'Sender A', tag: 'a' });
  B = await t.makeUser({ name: 'Sender B', tag: 'b' });
  tokA = await t.signJwt(A); tokB = await t.signJwt(B);
  docA = await t.makeDoc(A);
});
after(async () => { await t.cleanup(); });

const setStatus = (id, status, extra = {}) => t.raw.send(new UpdateCommand({
  TableName: t.TABLE, Key: { PK: `DOC#${id}`, SK: 'META' },
  UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': status },
}));
const getDoc = (id) => t.raw.send(new GetCommand({ TableName: t.TABLE, Key: { PK: `DOC#${id}`, SK: 'META' }, ConsistentRead: true })).then(r => r.Item);

test('ownership: sender B gets 404 on EVERY /documents/:id* route for A\'s doc; A is unaffected', async () => {
  const id = docA;
  const routes = [
    ['GET', `/documents/${id}`],
    ['GET', `/documents/${id}/pdf`],
    ['GET', `/documents/${id}/fields`],
    ['PUT', `/documents/${id}/fields`, { fields: [] }],
    ['POST', `/documents/${id}/send`, { signer_email: 'x@test.invalid' }],
    ['GET', `/documents/${id}/evidence`],
    ['GET', `/documents/${id}/signed`],
    ['POST', `/documents/${id}/revoke`, {}],
  ];
  for (const [m, p, body] of routes) {
    const r = await t.call(m, p, { auth: tokB, body });
    assert.equal(r.status, 404, `B ${m} ${p} -> ${r.status}`);
    assert.deepEqual(r.body, { error: 'not found' }, `${m} ${p} body must equal the missing-doc body`);
  }
  // Same response as a doc that doesn't exist at all (no existence oracle).
  const missing = await t.call('GET', `/documents/${crypto.randomUUID()}`, { auth: tokB });
  assert.deepEqual(missing.body, { error: 'not found' });
  // B's attempts changed nothing.
  const d = await getDoc(id);
  assert.equal(d.status, 'uploaded'); assert.equal(d.signerEmail, null); assert.equal(d.revokedAt, undefined);
  // A can still read it.
  assert.equal((await t.call('GET', `/documents/${id}`, { auth: tokA })).status, 200);
  assert.equal((await t.call('GET', `/documents/${id}/fields`, { auth: tokA })).status, 200);
});

test('ownership: unowned (legacy) docs are inaccessible to everyone', async () => {
  const id = await t.makeDoc(null);
  assert.equal((await t.call('GET', `/documents/${id}`, { auth: tokA })).status, 404);
  assert.equal((await t.call('POST', `/documents/${id}/revoke`, { auth: tokA, body: {} })).status, 404);
});

test('ownership: API-key sender B is equally blocked', async () => {
  const key = 'esk_' + crypto.randomBytes(32).toString('base64url');
  await t.repo.putApiKey({ key, email: B.email, label: 't' });
  t.track(`APIKEY#${crypto.createHash('sha256').update(key).digest('hex')}`);
  const r = await t.call('GET', `/documents/${docA}`, { headers: { 'x-api-key': key } });
  assert.equal(r.status, 404);
});

test('GET /documents lists only own docs, newest first, wire shape', async (ctx) => {
  const d1 = await t.makeDoc(A);
  await new Promise(r => setTimeout(r, 15));
  const d2 = await t.makeDoc(A);
  const dB = await t.makeDoc(B);
  let ra;
  try { ra = await t.call('GET', '/documents', { auth: tokA }); } catch (e) { throw e; }
  if (ra.status === 500 && /index|GSI1/i.test(JSON.stringify(ra.body))) {
    return ctx.skip('esign-dev has no GSI1 index (cannot create it from tests) — see report');
  }
  assert.equal(ra.status, 200);
  const ids = ra.body.documents.map(d => d.id);
  assert.ok(ids.includes(d1) && ids.includes(d2) && ids.includes(docA));
  assert.ok(!ids.includes(dB));
  assert.ok(ids.indexOf(d2) < ids.indexOf(d1), 'newest first');
  assert.deepEqual(Object.keys(ra.body.documents[0]).sort(),
    ['ccEmails', 'createdAt', 'filename', 'id', 'linkExpiresAt', 'revokedAt', 'sentAt', 'signedAt', 'signerEmail', 'status'].sort());
  const rb = await t.call('GET', '/documents', { auth: tokB });
  assert.deepEqual(rb.body.documents.map(d => d.id), [dB]);
  // A fresh user sees nothing, and a query param can't widen the scope.
  const C = await t.makeUser({ tag: 'c' });
  const rc = await t.call('GET', `/documents?owner=${encodeURIComponent(A.email)}&ownerEmail=${encodeURIComponent(A.email)}`, { auth: await t.signJwt(C) });
  assert.deepEqual(rc.body.documents, []);
});

test('complete: ignores body sender_email/ownerEmail; identity comes from the session', async () => {
  const id = crypto.randomUUID();
  t.track(`DOC#${id}`);
  const r = await t.call('POST', `/documents/${id}/complete`, {
    auth: tokA, body: { filename: 'x.pdf', sender_email: B.email, ownerEmail: B.email, senderEmail: B.email, accountId: 'evil' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await getDoc(id);
  assert.equal(d.ownerEmail, A.email); assert.equal(d.senderEmail, A.email);
  assert.equal(d.accountId, 'testacct'); assert.equal(d.GSI1PK, `OWNER#${A.email}`);
  assert.equal((await t.call('GET', `/documents/${id}`, { auth: tokB })).status, 404);
});

test('complete: id collision with someone else\'s doc cannot overwrite or steal it', async () => {
  const before = await getDoc(docA);
  const r = await t.call('POST', `/documents/${docA}/complete`, { auth: tokB, body: { filename: 'steal.pdf', sender_email: B.email } });
  assert.notEqual(r.status, 200);
  const after = await getDoc(docA);
  assert.equal(after.ownerEmail, A.email);
  assert.equal(after.filename, before.filename);
  assert.equal(after.GSI1PK, `OWNER#${A.email}`);
  assert.equal(r.status, 409, 'conflict, not a raw 500');
  // Malformed ids rejected.
  assert.equal((await t.call('POST', `/documents/not-a-uuid/complete`, { auth: tokA, body: { filename: 'a.pdf' } })).status, 400);
});

test('init: server-minted id, key bound to that id (no client control)', async () => {
  const r = await t.call('POST', '/documents/init', { auth: tokA, body: { filename: 'a.pdf', id: 'evil', key: 'documents/evil/original.pdf' } });
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.body.key, `documents/${r.body.id}/original.pdf`);
  assert.equal((await t.call('POST', '/documents/init', { auth: tokA, body: { filename: 'a.txt' } })).status, 400);
});

test('send: sender identity from session, not env/body; revoke kills links; re-send works; signer routes behave', async () => {
  const id = await t.makeDoc(A);
  const signer = t.email('signer');
  let sendRes, mail = '';
  const orig = console.log; console.log = (...a) => { mail += a.join(' ') + '\n'; };
  try {
    sendRes = await t.call('POST', `/documents/${id}/send`, {
      auth: tokA, body: { signer_email: signer, senderEmail: B.email, sender_name: 'Mallory', sender_email: B.email, cc_sender: true },
    });
  } finally { console.log = orig; }
  assert.equal(sendRes.status, 200, JSON.stringify(sendRes.body));
  assert.ok(mail.includes('Sender A'), 'email names the authenticated sender');
  assert.ok(!mail.includes('Mallory'));
  assert.ok(sendRes.body.cc_emails.includes(A.email), 'cc defaults to the session sender');
  assert.ok(!(sendRes.body.cc_emails || []).includes(B.email));
  const link1 = sendRes.body.link; const tok1 = link1.split('/s/')[1];
  t.track(`TOK#${tok1}`);

  const d = await getDoc(id);
  assert.equal(d.status, 'sent'); assert.ok(d.sentAt); assert.ok(d.linkExpiresAt > Date.now());

  // Signer routes work with no sender auth.
  const open = await t.call('GET', `/sign/${tok1}`);
  assert.equal(open.status, 200); assert.equal(open.body.signer, signer);
  assert.equal(open.body.doc_id, id);

  // Audit actor on sender events.
  const events = await t.repo.listEvents(id);
  const sent = events.find(e => e.type === 'link_sent');
  assert.equal(sent.metadata.actor, A.email);
  assert.ok(!JSON.stringify(sent).includes(tok1), 'raw token never logged');

  // Revoke
  const rv = await t.call('POST', `/documents/${id}/revoke`, { auth: tokA, body: {} });
  assert.equal(rv.status, 200); assert.equal(rv.body.status, 'revoked'); assert.ok(rv.body.revokedAt);
  for (const suffix of ['', '/pdf', '/signed', '/evidence']) {
    const r = await t.call('GET', `/sign/${tok1}${suffix}`);
    assert.equal(r.status, 401, `revoked token on /sign/:t${suffix}`);
    assert.match(r.body.error, /superseded/);
  }
  const submit = await t.call('POST', `/sign/${tok1}`, { body: { consent: true, values: {} } });
  assert.equal(submit.status, 401);
  assert.equal((await getDoc(id)).status, 'revoked');
  assert.ok((await t.repo.listEvents(id)).some(e => e.type === 'link_revoked' && e.metadata.actor === A.email));
  // Revoke is idempotent-ish and B cannot undo/redo it.
  assert.equal((await t.call('POST', `/documents/${id}/revoke`, { auth: tokB, body: {} })).status, 404);

  // Re-send after revoke works, clears revokedAt, new link works, old stays dead.
  const re = await t.call('POST', `/documents/${id}/send`, { auth: tokA, body: { signer_email: signer } });
  assert.equal(re.status, 200);
  const tok2 = re.body.link.split('/s/')[1]; t.track(`TOK#${tok2}`);
  assert.equal((await t.call('GET', `/sign/${tok2}`)).status, 200);
  assert.equal((await t.call('GET', `/sign/${tok1}`)).status, 401);
  const d2 = await getDoc(id);
  assert.equal(d2.status, 'sent'); assert.equal(d2.revokedAt, undefined);

  // Signer-token edge: garbage token behaves as before.
  assert.equal((await t.call('GET', '/sign/definitely-not-a-token')).status, 401);
});

test('revoke: blocked (409) once signed or signing; link and status untouched', async () => {
  for (const st of ['signed', 'signing']) {
    const id = await t.makeDoc(A);
    await setStatus(id, st);
    const r = await t.call('POST', `/documents/${id}/revoke`, { auth: tokA, body: {} });
    assert.equal(r.status, 409, st);
    const d = await getDoc(id);
    assert.equal(d.status, st); assert.equal(d.revokedAt, undefined); assert.equal(d.tokenNonce, null);
  }
});

test('send: cannot re-send a signed doc (409)', async () => {
  const id = await t.makeDoc(A);
  await setStatus(id, 'signed');
  const r = await t.call('POST', `/documents/${id}/send`, { auth: tokA, body: { signer_email: t.email('s') } });
  assert.equal(r.status, 409);
});

test('signed download: 409 until signed; owner gets a presigned url once signed', async () => {
  const id = await t.makeDoc(A);
  assert.equal((await t.call('GET', `/documents/${id}/signed`, { auth: tokA })).status, 409);
  await t.raw.send(new UpdateCommand({
    TableName: t.TABLE, Key: { PK: `DOC#${id}`, SK: 'META' },
    UpdateExpression: 'SET #s = :s, s3KeySigned = :k, signedAt = :t',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'signed', ':k': `documents/${id}/signed.pdf`, ':t': new Date().toISOString() },
  }));
  const ok = await t.call('GET', `/documents/${id}/signed`, { auth: tokA });
  assert.equal(ok.status, 200); assert.match(ok.body.url, /^https:\/\//);
  assert.equal((await t.call('GET', `/documents/${id}/signed`, { auth: tokB })).status, 404);
});
