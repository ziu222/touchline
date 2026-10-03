// Shared setup for *.e2e.test.ts. Runs against the docker compose Postgres and Redis.
// Each test file runs in its own process (node --test), so env set here is per file.
import type { INestApplication } from '@nestjs/common';
import { per90Features, type UserRole } from '@touchline/shared';
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

  // A player with one season of stats and, from 700 minutes, an embedding built from z-scores
  // (same shape as tools/seed writes: z-scores in feature order, zero-padded to 32, L2-normalised).
  async function createPlayer(p: {
    name: string;
    group: 'gk' | 'def' | 'mid' | 'fwd';
    minutes?: number;
    dob?: string;
    synthetic?: boolean;
    per90?: Record<string, number>;
    z?: Record<string, number>;
    availability?: 'fit' | 'modified' | 'out';
  }) {
    const { id } = await prisma.player.create({
      data: {
        clubId,
        fullName: p.name,
        primaryPositionGroup: p.group,
        primaryPosition: p.group.toUpperCase(),
        dob: new Date(p.dob ?? '1995-06-01'),
        isSynthetic: p.synthetic ?? false,
      },
    });
    const minutes = p.minutes ?? 2000;
    await prisma.playerSeasonStat.create({
      data: { playerId: id, season: '2017/18', minutes, metrics: {}, per90: p.per90 ?? {} },
    });
    if (minutes >= 700 && p.z) {
      const v = per90Features.map((f) => p.z![f] ?? 0);
      while (v.length < 32) v.push(0);
      const norm = Math.hypot(...v) || 1;
      const vector = `[${v.map((x) => x / norm).join(',')}]`;
      await prisma.$executeRaw`
        INSERT INTO core.player_embeddings (player_id, season, model_version, embedding, z_scores)
        VALUES (${id}::uuid, '2017/18', 'test-v1', ${vector}::vector, ${JSON.stringify(p.z)}::jsonb)`;
    }
    if (p.availability) {
      const doctor = await createUser('doctor');
      await prisma.withRole('doctor', (tx) =>
        tx.availabilityStatus.create({ data: { playerId: id, status: p.availability!, updatedBy: doctor.id } }),
      );
    }
    return id;
  }

  async function close() {
    // audit_log is append-only by design, so its test rows stay
    await prisma.shortlistEntry.deleteMany({ where: { clubId } });
    await prisma.recruitmentNeed.deleteMany({ where: { clubId } });
    await prisma.scoutAssignment.deleteMany({ where: { player: { clubId } } });
    await prisma.player.deleteMany({ where: { clubId } });
    await prisma.user.deleteMany({ where: { clubId } });
    await prisma.club.delete({ where: { id: clubId } });
    await app.close();
  }

  return { app, prisma, clubId, run, request, createUser, loginAs, createPlayer, close };
}
