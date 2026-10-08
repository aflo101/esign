import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_helper.js';

const dev = `dev-${Date.now()}@test.invalid`;
const t = await boot({ NODE_ENV: 'test', DEV_SENDER_EMAIL: dev });
after(async () => { await t.cleanup(); });

test('non-production + DEV_SENDER_EMAIL: unauthenticated calls act as that user; bad bearer still 401', async () => {
  await t.repo.putUser({ email: dev, name: 'Dev User', accountId: 'testacct' });
  t.track(`USER#${dev}`);
  const me = await t.call('GET', '/auth/me');
  assert.equal(me.status, 200); assert.equal(me.body.email, dev);
  // A presented-but-invalid credential must not silently fall through to the bypass.
  assert.equal((await t.call('GET', '/auth/me', { auth: 'garbage' })).status, 401);
  assert.equal((await t.call('GET', '/auth/me', { headers: { 'x-api-key': 'esk_bad' } })).status, 401);
});
