import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SignJWT } from 'jose';
import { startTestApp } from './test-utils.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
before(async () => {
  t = await startTestApp({ RATE_LIMIT_LOGIN_PER_MIN: '10', RATE_LIMIT_USER_PER_MIN: '3' });
});
after(() => t.close());

test('login: 10 per minute per IP, the 11th is 429 RATE_LIMITED', async () => {
  const body = { email: `nobody-${t.run}@test.local`, password: 'x' };
  for (let i = 0; i < 10; i++) assert.equal((await t.request('POST', '/auth/login', { body })).status, 401);
  const blocked = await t.request('POST', '/auth/login', { body });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
});

test('authenticated routes are counted per user, not per IP', async () => {
  // tokens are signed directly: login is already exhausted for this IP by the test above
  const [a, b] = await Promise.all([t.createUser('admin'), t.createUser('admin')]);
  const key = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
  const tokenFor = (id: string) =>
    new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setExpirationTime('5m').sign(key);
  const [ta, tb] = await Promise.all([tokenFor(a.id), tokenFor(b.id)]);

  for (let i = 0; i < 3; i++) assert.equal((await t.request('GET', '/users', { token: ta })).status, 200);
  assert.equal((await t.request('GET', '/users', { token: ta })).status, 429);
  assert.equal((await t.request('GET', '/users', { token: tb })).status, 200, 'other user, same IP, own budget');
});
