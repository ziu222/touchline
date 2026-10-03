import { Injectable } from '@nestjs/common';
import type { CreateNeedRequest, NeedDto, NeedQuery, Page, UpdateNeedRequest } from '@touchline/shared';
import { AppError } from '../errors.js';
import { PrismaService } from '../prisma.service.js';
import type { AuthUser } from '../auth/decorators.js';

const include = { role: true } as const;

type NeedRow = {
  id: string;
  ageMin: number;
  ageMax: number;
  feeBudget: { toString(): string };
  deadline: Date;
  status: 'open' | 'closed';
  sharedWithCoach: boolean;
  createdBy: string;
  createdAt: Date;
  role: { id: string; name: string; positionGroup: string };
};

const toDto = (n: NeedRow): NeedDto => ({
  id: n.id,
  role: { id: n.role.id, name: n.role.name, position_group: n.role.positionGroup },
  age_min: n.ageMin,
  age_max: n.ageMax,
  fee_budget: n.feeBudget.toString(),
  deadline: n.deadline.toISOString().slice(0, 10),
  status: n.status,
  shared_with_coach: n.sharedWithCoach,
  created_by: n.createdBy,
  created_at: n.createdAt.toISOString(),
});

const today = () => new Date().toISOString().slice(0, 10);

function assertFutureDeadline(deadline: string | undefined) {
  if (deadline !== undefined && deadline < today()) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Deadline cannot be in the past');
  }
}

// The coach only ever sees needs that HoR or SD chose to share.
const visibleTo = (user: AuthUser) => ({
  clubId: user.clubId,
  ...(user.role === 'head_coach' ? { sharedWithCoach: true } : {}),
});

@Injectable()
export class NeedsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, q: NeedQuery): Promise<Page<NeedDto>> {
    const where = { ...visibleTo(user), ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.recruitmentNeed.findMany({
        where,
        include,
        orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.recruitmentNeed.count({ where }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, limit: q.limit, total } };
  }

  async get(user: AuthUser, id: string): Promise<NeedDto> {
    return toDto(await this.find(user, id));
  }

  // 404 also for needs the caller may not see, so their existence does not leak
  async find(user: AuthUser, id: string) {
    const need = await this.prisma.recruitmentNeed.findFirst({ where: { id, ...visibleTo(user) }, include });
    if (!need) throw new AppError(404, 'NOT_FOUND', 'Need not found');
    return need;
  }

  async create(user: AuthUser, input: CreateNeedRequest): Promise<NeedDto> {
    assertFutureDeadline(input.deadline);
    await this.assertRoleExists(input.role_id);
    const need = await this.prisma.recruitmentNeed.create({
      data: {
        clubId: user.clubId,
        roleId: input.role_id,
        ageMin: input.age_min,
        ageMax: input.age_max,
        feeBudget: input.fee_budget,
        deadline: new Date(input.deadline),
        sharedWithCoach: input.shared_with_coach,
        createdBy: user.id,
      },
      include,
    });
    return toDto(need);
  }

  // Closing a need locks its shortlist (no adds, no stage moves) but deletes nothing.
  async update(user: AuthUser, id: string, input: UpdateNeedRequest): Promise<NeedDto> {
    const current = await this.find(user, id);
    assertFutureDeadline(input.deadline);
    if (input.role_id) await this.assertRoleExists(input.role_id);
    const ageMin = input.age_min ?? current.ageMin;
    const ageMax = input.age_max ?? current.ageMax;
    if (ageMin > ageMax) throw new AppError(400, 'VALIDATION_FAILED', 'age_min must be <= age_max');

    const need = await this.prisma.recruitmentNeed.update({
      where: { id },
      data: {
        roleId: input.role_id,
        ageMin: input.age_min,
        ageMax: input.age_max,
        feeBudget: input.fee_budget,
        deadline: input.deadline ? new Date(input.deadline) : undefined,
        sharedWithCoach: input.shared_with_coach,
        status: input.status,
      },
      include,
    });
    return toDto(need);
  }

  private async assertRoleExists(roleId: string) {
    if (!(await this.prisma.playerRole.findUnique({ where: { id: roleId }, select: { id: true } }))) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Unknown role_id');
    }
  }
}
