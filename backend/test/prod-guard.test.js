// Env-dependent auth modes, each in its own process (node --test runs one process per file),
// so module-level env reads in server.js are exercised for real.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_helper.js';

// Dev-bypass and legacy-password modes live in dev-bypass.test.js / legacy.test.js (module-level env reads need a fresh process each).
const t = await boot({ NODE_ENV: 'production', DEV_SENDER_EMAIL: 'dev@test.invalid' });
after(async () => { await t.cleanup(); });

test('NODE_ENV=production: DEV_SENDER_EMAIL bypass is inert even if the var leaks in', async () => {
  const u = await t.makeUser({ tag: 'dev' });
  await t.repo.putUser({ email: 'dev@test.invalid', name: 'Dev', accountId: 'x' });
  t.track('USER#dev@test.invalid');
  for (const p of ['/auth/me', '/documents']) assert.equal((await t.call('GET', p)).status, 401, p);
  assert.deepEqual((await t.call('GET', '/auth/status')).body, { authRequired: true, authenticated: false });
  assert.ok(u);
});
