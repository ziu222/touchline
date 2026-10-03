// Shared setup for *.e2e.test.ts. Runs against the docker compose Postgres and Redis.
// Each test file runs in its own process (node --test), so env set here is per file.
import type { INestApplication } from '@nestjs/common';
import type { UserRole } from '@touchline/shared';
import { createApp } from './app.js';
import { PrismaService } from './prisma.service.js';
import { hashPassword } from './auth/password.js';

export const PASSWORD = 'correct horse battery';

type Res = { status: number; body: any };

export async function startTestApp(env: Record<string, string> = {}) {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // own Redis key prefix per file so parallel files never share rate-limit counters
  Object.assign(process.env, {
    RATE_LIMIT_PREFIX: `test:${run}:`,
    RATE_LIMIT_LOGIN_PER_MIN: '1000',
    RATE_LIMIT_USER_PER_MIN: '1000',
    ...env,
  });

  const app: INestApplication = await createApp(false);
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;
  const prisma = app.get(PrismaService);
  const clubId = (await prisma.club.create({ data: { name: `Test FC ${run}` } })).id;
  const passwordHash = await hashPassword(PASSWORD);
  let seq = 0;

  async function request(method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<Res> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  async function createUser(role: UserRole) {
    const email = `${role}-${++seq}-${run}@test.local`;
    const { id } = await prisma.user.create({ data: { clubId, email, passwordHash, userRole: role } });
    return { id, email };
  }

  async function loginAs(role: UserRole) {
    const user = await createUser(role);
    const res = await request('POST', '/auth/login', { body: { email: user.email, password: PASSWORD } });
    return { ...user, token: res.body.access_token as string, refresh: res.body.refresh_token as string };
  }

  async function close() {
    // audit_log is append-only by design, so its test rows stay
    await prisma.user.deleteMany({ where: { clubId } });
    await prisma.club.delete({ where: { id: clubId } });
    await app.close();
  }

  return { app, prisma, clubId, run, request, createUser, loginAs, close };
}
