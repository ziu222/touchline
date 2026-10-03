import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@touchline/shared';
import { AppError, unauthenticated } from '../errors.js';
import { PrismaService } from '../prisma.service.js';
import { AuthService } from './auth.service.js';
import { PUBLIC_KEY, ROLES_KEY, type AuthedRequest } from './decorators.js';

// Global guard. Deny by default: a route with neither @Public nor @Roles answers 403.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (!roles?.length) throw new AppError(403, 'FORBIDDEN', 'Route has no declared roles');

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthenticated();
    const userId = await this.auth.verifyAccessToken(header.slice('Bearer '.length));

    // ponytail: one DB read per request so deactivation and role changes apply at once (US-02);
    // move to a Redis cache with ~30 s TTL if this read ever shows up in latency.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, userRole: true, isActive: true },
    });
    if (!user?.isActive) throw unauthenticated('Invalid or expired token');

    req.user = { id: user.id, role: user.userRole };
    if (!roles.includes(user.userRole)) throw new AppError(403, 'FORBIDDEN', 'Not allowed for this role');
    return true;
  }
}
