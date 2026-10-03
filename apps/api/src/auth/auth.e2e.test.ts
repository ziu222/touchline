import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Reflector } from '@nestjs/core';
import { AppError } from '../errors.js';
import { PASSWORD, startTestApp } from '../test-utils.js';
import { AuthGuard } from './auth.guard.js';
import { hashPassword, verifyPassword } from './password.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
before(async () => {
  t = await startTestApp();
});
after(() => t.close());

const login = (email: string, password = PASSWORD) =>
  t.request('POST', '/auth/login', { body: { email, password } });
const refresh = (refresh_token: string) => t.request('POST', '/auth/refresh', { body: { refresh_token } });
const logout = (refresh_token: string, token?: string) =>
  t.request('POST', '/auth/logout', { body: { refresh_token }, token });

test('password hash round-trips and rejects wrong password', async () => {
  const hash = await hashPassword('pw');
  assert.ok(hash.startsWith('argon2id$'));
  assert.equal(await verifyPassword('pw', hash), true);
  assert.equal(await verifyPassword('nope', hash), false);
});

test('login returns tokens and never the password hash; email is case-insensitive', async () => {
  const { email } = await t.createUser('scout');
  const res = await login(email.toUpperCase());
  assert.equal(res.status, 200);
  assert.equal(res.body.expires_in, 900);
  assert.ok(res.body.access_token && res.body.refresh_token);
  assert.ok(!JSON.stringify(res.body).includes('argon2id'));
});

test('bad input is 400, wrong password and unknown email are the same 401', async () => {
  const { email } = await t.createUser('scout');
  const bad = await t.request('POST', '/auth/login', { body: { email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');

  const wrong = await login(email, 'wrong');
  const unknown = await login(`nobody-${t.run}@test.local`);
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('refresh rotates; reusing a rotated token ends every session of the user', async () => {
  const user = await t.loginAs('scout');
  const second = (await refresh(user.refresh)).body;
  assert.ok(second.refresh_token && second.refresh_token !== user.refresh);

  assert.equal((await refresh(user.refresh)).status, 401);
  assert.equal((await refresh(second.refresh_token)).status, 401, 'the fresh token is revoked too');
});

test('tampered refresh token is 401', async () => {
  const user = await t.loginAs('scout');
  assert.equal((await refresh(`${user.refresh}x`)).status, 401);
});

test('logout revokes the token family and needs a valid access token', async () => {
  const user = await t.loginAs('scout');
  assert.equal((await logout(user.refresh)).status, 401);
  assert.equal((await logout(user.refresh, 'garbage')).status, 401);
  assert.equal((await logout(user.refresh, user.token)).status, 204);
  assert.equal((await refresh(user.refresh)).status, 401);
});

test('5 wrong passwords lock the account for 15 minutes, even for the right password', async () => {
  const { email } = await t.createUser('scout');
  for (let i = 0; i < 5; i++) assert.equal((await login(email, 'wrong')).status, 401);
  const locked = await login(email);
  assert.equal(locked.status, 423);
  assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
});

test('deactivated user: existing access token is rejected at once, login fails', async () => {
  const user = await t.loginAs('scout');
  await t.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
  assert.equal((await logout(user.refresh, user.token)).status, 401);
  assert.equal((await login(user.email)).status, 401);
  assert.equal((await refresh(user.refresh)).status, 401);
});

test('route without @Public or @Roles is denied with 403', async () => {
  const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
  const guard = new AuthGuard(reflector, {} as never, t.prisma);
  const ctx = { getHandler: () => null, getClass: () => null } as never;
  await assert.rejects(guard.canActivate(ctx), (err: unknown) => err instanceof AppError && err.getStatus() === 403);
});
