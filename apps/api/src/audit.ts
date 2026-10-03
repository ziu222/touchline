import type { Prisma } from './generated/prisma/client.js';
import type { AuditAction } from './generated/prisma/enums.js';

// Who did what to which row. Never the content itself (spec mục 5).
export function writeAudit(
  tx: Prisma.TransactionClient,
  entry: { actorId: string; action: AuditAction; entity: string; entityId?: string; ip?: string },
) {
  return tx.auditLog.create({ data: entry });
}
