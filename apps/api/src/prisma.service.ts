import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { UserRole } from '@touchline/shared';
import { PrismaClient, type Prisma } from './generated/prisma/client.js';
import { requireEnv } from './env.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: requireEnv('DATABASE_URL') }) });
  }

  // Runs fn in a transaction where Postgres RLS sees the caller's role (spec mục 7).
  // set_config(..., true) is transaction-local, so the role never leaks to the next
  // request that reuses this pooled connection. Medical tables return 0 rows outside it.
  withRole<T>(role: UserRole, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const ttlDays = process.env.MEDICAL_CLEARANCE_TTL_DAYS ?? '30';
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true), set_config('app.clearance_ttl_days', ${ttlDays}, true)`;
      return fn(tx);
    });
  }

  onModuleDestroy() {
    return this.$disconnect();
  }
}
