import { Injectable } from '@nestjs/common';
import type { CreateUserRequest, Page, Pagination, UpdateUserRequest, UserDto } from '@touchline/shared';
import { writeAudit } from '../audit.js';
import { AppError } from '../errors.js';
import { PrismaService } from '../prisma.service.js';
import { hashPassword } from '../auth/password.js';
import type { AuthUser } from '../auth/decorators.js';

const select = { id: true, email: true, userRole: true, isActive: true, lockedUntil: true, createdAt: true } as const;

type Row = { id: string; email: string; userRole: UserDto['role']; isActive: boolean; lockedUntil: Date | null; createdAt: Date };

const toDto = (u: Row): UserDto => ({
  id: u.id,
  email: u.email,
  role: u.userRole,
  is_active: u.isActive,
  locked_until: u.lockedUntil?.toISOString() ?? null,
  created_at: u.createdAt.toISOString(),
});

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === 'P2002';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser, { page, limit }: Pagination): Promise<Page<UserDto>> {
    const where = { clubId: actor.clubId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select, orderBy: { createdAt: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.user.count({ where }),
    ]);
    return { data: rows.map(toDto), meta: { page, limit, total } };
  }

  async create(actor: AuthUser, input: CreateUserRequest, ip?: string): Promise<UserDto> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { clubId: actor.clubId, email: input.email, passwordHash, userRole: input.role },
          select,
        });
        await writeAudit(tx, { actorId: actor.id, action: 'create', entity: 'core.users', entityId: user.id, ip });
        return toDto(user);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'EMAIL_TAKEN', 'Email already in use');
      throw err;
    }
  }

  async update(actor: AuthUser, id: string, input: UpdateUserRequest, ip?: string): Promise<UserDto> {
    // an admin locking themselves out leaves the club with no one to undo it
    if (id === actor.id) throw new AppError(400, 'CANNOT_MODIFY_SELF', 'Admins cannot change their own role or status');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({ where: { id, clubId: actor.clubId }, select: { id: true } });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'User not found');

      const user = await tx.user.update({
        where: { id },
        data: { userRole: input.role, isActive: input.is_active },
        select,
      });
      // deactivation ends sessions now; open access tokens already fail in AuthGuard
      if (input.is_active === false) {
        await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await writeAudit(tx, { actorId: actor.id, action: 'update', entity: 'core.users', entityId: id, ip });
      return toDto(user);
    });
  }
}
