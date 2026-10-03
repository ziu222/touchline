import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthTokens, UserRole } from '@touchline/shared';
import { AppError, unauthenticated } from '../errors.js';
import { requireEnv } from '../env.js';
import { PrismaService } from '../prisma.service.js';
import { hashPassword, verifyPassword } from './password.js';

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (s: string) => createHash('sha256').update(s).digest();

function accessKey(): Uint8Array {
  const secret = requireEnv('JWT_ACCESS_SECRET');
  if (secret.length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters');
  return new TextEncoder().encode(secret);
}

@Injectable()
export class AuthService {
  private readonly key = accessKey();
  // verified against unknown emails so a miss costs the same time as a wrong password
  private readonly dummyHash = hashPassword(randomUUID());

  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string): Promise<AuthTokens> {
    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user) {
      await verifyPassword(password, await this.dummyHash);
      throw unauthenticated('Invalid email or password');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed logins, try again later', {
        locked_until: user.lockedUntil.toISOString(),
      });
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.recordFailedLogin(user.id);
      throw unauthenticated('Invalid email or password');
    }
    if (!user.isActive) throw unauthenticated('Invalid email or password');

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    return this.issueTokens(user.id, user.userRole, randomUUID());
  }

  // Refresh tokens are opaque "<row id>.<secret>"; only sha256(secret) is stored.
  async refresh(token: string): Promise<AuthTokens> {
    const row = await this.findRefreshToken(token);
    if (!row) throw unauthenticated('Invalid refresh token');

    const now = new Date();
    if (row.revokedAt) {
      // a rotated token came back: assume theft and end every session of this user
      await this.revokeAllSessions(row.userId, now);
      throw unauthenticated('Refresh token reused');
    }
    if (row.expiresAt <= now) throw unauthenticated('Refresh token expired');

    // conditional update: of two concurrent refreshes with the same token only one wins
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (claimed.count !== 1) {
      await this.revokeAllSessions(row.userId, now);
      throw unauthenticated('Refresh token reused');
    }

    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user?.isActive) throw unauthenticated('Invalid refresh token');
    return this.issueTokens(user.id, user.userRole, row.familyId);
  }

  async logout(userId: string, token: string): Promise<void> {
    const row = await this.findRefreshToken(token);
    if (!row || row.userId !== userId) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async verifyAccessToken(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      if (!payload.sub) throw new Error('missing sub');
      return payload.sub;
    } catch {
      throw unauthenticated('Invalid or expired token');
    }
  }

  private async issueTokens(userId: string, role: UserRole, familyId: string): Promise<AuthTokens> {
    const access_token = await new SignJWT({ role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_S}s`)
      .sign(this.key);

    const secret = randomBytes(32).toString('base64url');
    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256(secret).toString('hex'),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { access_token, refresh_token: `${row.id}.${secret}`, expires_in: ACCESS_TTL_S };
  }

  private async findRefreshToken(token: string) {
    const [id, secret] = token.split('.');
    if (!id || !secret || !UUID.test(id)) return null;
    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!row) return null;
    return timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), sha256(secret)) ? row : null;
  }

  private async recordFailedLogin(userId: string) {
    const { failedLogins } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLogins: { increment: 1 } },
    });
    if (failedLogins >= MAX_FAILED_LOGINS) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
    }
  }

  private revokeAllSessions(userId: string, at: Date) {
    return this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } });
  }
}
