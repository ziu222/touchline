// Runs against the real Postgres from docker compose (DATABASE_URL). Creates and deletes its own club.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createApp } from '../app.js';
import { AppError } from '../errors.js';
import { PrismaService } from '../prisma.service.js';
import { AuthGuard } from './auth.guard.js';
import { hashPassword, verifyPassword } from './password.js';

const PASSWORD = 'correct horse battery';
const run = Date.now();
const emails = { main: `main-${run}@test.local`, lock: `lock-${run}@test.local`, off: `off-${run}@test.local` };

let app: INestApplication;
let prisma: PrismaService;
let base: string;
let clubId: string;

before(async () => {
  app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`;
  prisma = app.get(PrismaService);
  clubId = (await prisma.club.create({ data: { name: `Test FC ${run}` } })).id;
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.user.createMany({
    data: Object.values(emails).map((email) => ({ clubId, email, passwordHash, userRole: 'scout' as const })),
  });
});

after(async () => {
  await prisma.user.deleteMany({ where: { clubId } });
  await prisma.club.delete({ where: { id: clubId } });
  await app.close();
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const login = (email: string, password = PASSWORD) => post('/auth/login', { email, password });

test('password hash round-trips and rejects wrong password', async () => {
  const hash = await hashPassword('pw');
  assert.ok(hash.startsWith('argon2id$'));
  assert.equal(await verifyPassword('pw', hash), true);
  assert.equal(await verifyPassword('nope', hash), false);
});

test('login returns tokens and never the password hash; email is case-insensitive', async () => {
  const res = await login(emails.main.toUpperCase());
  assert.equal(res.status, 200);
  assert.equal(res.body.expires_in, 900);
  assert.ok(res.body.access_token && res.body.refresh_token);
  assert.ok(!JSON.stringify(res.body).includes('argon2id'));
});

test('bad input is 400, wrong password and unknown email are the same 401', async () => {
  const bad = await post('/auth/login', { email: 'not-an-email' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');

  const wrong = await login(emails.main, 'wrong');
  const unknown = await login(`nobody-${run}@test.local`);
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('refresh rotates; reusing a rotated token ends every session of the user', async () => {
  const first = (await login(emails.main)).body;
  const second = (await post('/auth/refresh', { refresh_token: first.refresh_token })).body;
  assert.ok(second.refresh_token && second.refresh_token !== first.refresh_token);

  const reuse = await post('/auth/refresh', { refresh_token: first.refresh_token });
  assert.equal(reuse.status, 401);
  const afterReuse = await post('/auth/refresh', { refresh_token: second.refresh_token });
  assert.equal(afterReuse.status, 401, 'the fresh token is revoked too');
});

test('tampered refresh token is 401', async () => {
  const { refresh_token } = (await login(emails.main)).body;
  const res = await post('/auth/refresh', { refresh_token: `${refresh_token}x` });
  assert.equal(res.status, 401);
});

test('logout revokes the token family and needs a valid access token', async () => {
  const tokens = (await login(emails.main)).body;
  assert.equal((await post('/auth/logout', { refresh_token: tokens.refresh_token })).status, 401);
  assert.equal((await post('/auth/logout', { refresh_token: tokens.refresh_token }, 'garbage')).status, 401);
  assert.equal((await post('/auth/logout', { refresh_token: tokens.refresh_token }, tokens.access_token)).status, 204);
  assert.equal((await post('/auth/refresh', { refresh_token: tokens.refresh_token })).status, 401);
});

test('5 wrong passwords lock the account for 15 minutes, even for the right password', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login(emails.lock, 'wrong')).status, 401);
  const locked = await login(emails.lock);
  assert.equal(locked.status, 423);
  assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
});

test('deactivated user: existing access token is rejected at once, login fails', async () => {
  const tokens = (await login(emails.off)).body;
  await prisma.user.updateMany({ where: { email: emails.off }, data: { isActive: false } });
  assert.equal((await post('/auth/logout', { refresh_token: tokens.refresh_token }, tokens.access_token)).status, 401);
  assert.equal((await login(emails.off)).status, 401);
  assert.equal((await post('/auth/refresh', { refresh_token: tokens.refresh_token })).status, 401);
});

test('route without @Public or @Roles is denied with 403', async () => {
  const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
  const guard = new AuthGuard(reflector, {} as never, prisma);
  const ctx = { getHandler: () => null, getClass: () => null } as never;
  await assert.rejects(guard.canActivate(ctx), (err: unknown) => err instanceof AppError && err.getStatus() === 403);
});
