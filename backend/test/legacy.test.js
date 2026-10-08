import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { boot } from './_helper.js';

const legacy = `legacy-${Date.now()}@test.invalid`;
const t = await boot({ SENDER_PASSWORD: 'correct horse', LEGACY_SENDER_EMAIL: legacy });
after(async () => { await t.cleanup(); });

test('legacy password: right password -> session for LEGACY_SENDER_EMAIL; wrong -> 401; missing user -> 401', async () => {
  const miss = await t.call('POST', '/auth/login', { body: { password: 'correct horse' } });
  assert.equal(miss.status, 401, 'legacy user not seeded yet');
  await t.repo.putUser({ email: legacy, name: 'Legacy', accountId: 'testacct' });
  t.track(`USER#${legacy}`);
  const ok = await t.call('POST', '/auth/login', { body: { password: 'correct horse' } });
  assert.equal(ok.status, 200);
  assert.equal(jwt.verify(ok.body.token, 'test-secret').sub, legacy);
  assert.equal((await t.call('GET', '/auth/me', { auth: ok.body.token })).status, 200);
  assert.equal((await t.call('POST', '/auth/login', { body: { password: 'wrong' } })).status, 401);
  assert.equal((await t.call('POST', '/auth/login', { body: {} })).status, 401);
});
