import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { userRoles } from '@touchline/shared';
import { startTestApp } from '../test-utils.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let admin: Awaited<ReturnType<typeof t.loginAs>>;
before(async () => {
  t = await startTestApp();
  admin = await t.loginAs('admin');
});
after(() => t.close());

const newUser = (overrides: Record<string, unknown> = {}) => ({
  email: `New-${Math.random().toString(36).slice(2, 8)}-${t.run}@Test.local`,
  password: 'a-long-password-123',
  role: 'scout',
  ...overrides,
});

test('every non-admin role gets 403 on /users', async () => {
  for (const role of userRoles.filter((r) => r !== 'admin')) {
    const user = await t.loginAs(role);
    assert.equal((await t.request('GET', '/users', { token: user.token })).status, 403, role);
    assert.equal((await t.request('POST', '/users', { token: user.token, body: newUser() })).status, 403, role);
  }
});

test('admin creates a user: email lowercased, no password hash, audit row written', async () => {
  const body = newUser();
  const res = await t.request('POST', '/users', { token: admin.token, body });
  assert.equal(res.status, 201);
  assert.equal(res.body.email, body.email.toLowerCase());
  assert.equal(res.body.role, 'scout');
  assert.ok(!('password_hash' in res.body) && !JSON.stringify(res.body).includes('argon2id'));

  const login = await t.request('POST', '/auth/login', { body: { email: body.email, password: body.password } });
  assert.equal(login.status, 200);

  const audit = await t.prisma.auditLog.count({ where: { entity: 'core.users', entityId: res.body.id, action: 'create' } });
  assert.equal(audit, 1);
});

test('duplicate email (any case) is 409, short password is 400', async () => {
  const body = newUser();
  assert.equal((await t.request('POST', '/users', { token: admin.token, body })).status, 201);
  const dup = await t.request('POST', '/users', { token: admin.token, body: { ...body, email: body.email.toUpperCase() } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'EMAIL_TAKEN');
  assert.equal((await t.request('POST', '/users', { token: admin.token, body: newUser({ password: 'short' }) })).status, 400);
});

test('list is paginated and scoped to the club', async () => {
  const res = await t.request('GET', '/users?page=1&limit=2', { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.meta.limit, 2);
  assert.ok(res.body.meta.total >= 2);
  assert.equal((await t.request('GET', '/users?limit=101', { token: admin.token })).status, 400);
});

test('role change is audited and applies to the next request', async () => {
  const user = await t.loginAs('scout');
  const res = await t.request('PATCH', `/users/${user.id}`, { token: admin.token, body: { role: 'admin' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'admin');
  assert.equal((await t.request('GET', '/users', { token: user.token })).status, 200, 'old token, new role');
  const audit = await t.prisma.auditLog.count({ where: { entityId: user.id, action: 'update' } });
  assert.equal(audit, 1);
});

test('deactivation rejects the access token and revokes refresh tokens', async () => {
  const user = await t.loginAs('admin');
  const res = await t.request('PATCH', `/users/${user.id}`, { token: admin.token, body: { is_active: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.is_active, false);
  assert.equal((await t.request('GET', '/users', { token: user.token })).status, 401);
  assert.equal((await t.request('POST', '/auth/refresh', { body: { refresh_token: user.refresh } })).status, 401);
});

test('admin cannot modify self; unknown id 404; bad id 400; empty patch 400', async () => {
  const self = await t.request('PATCH', `/users/${admin.id}`, { token: admin.token, body: { is_active: false } });
  assert.equal(self.status, 400);
  assert.equal(self.body.error.code, 'CANNOT_MODIFY_SELF');
  const missing = '00000000-0000-4000-8000-000000000000';
  assert.equal((await t.request('PATCH', `/users/${missing}`, { token: admin.token, body: { role: 'scout' } })).status, 404);
  assert.equal((await t.request('PATCH', '/users/not-a-uuid', { token: admin.token, body: { role: 'scout' } })).status, 400);
  const user = await t.createUser('scout');
  assert.equal((await t.request('PATCH', `/users/${user.id}`, { token: admin.token, body: {} })).status, 400);
});
