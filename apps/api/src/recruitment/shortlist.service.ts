import { Injectable } from '@nestjs/common';
import type {
  ClearanceDto,
  ClearanceRequest,
  ShortlistEntryDto,
  ShortlistStage,
  StageHistoryDto,
  TransitionRequest,
} from '@touchline/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { writeAudit } from '../audit.js';
import { AppError } from '../errors.js';
import { PrismaService } from '../prisma.service.js';
import type { AuthUser } from '../auth/decorators.js';
import { NeedsService } from './needs.service.js';
import { checkEdge, MIN_REASON_LENGTH, needsReason } from './stages.js';

const include = {
  player: { select: { id: true, fullName: true, primaryPosition: true, currentTeam: true } },
} as const;

type EntryRow = Prisma.ShortlistEntryGetPayload<{ include: typeof include }>;

const toDto = (e: EntryRow): ShortlistEntryDto => ({
  id: e.id,
  need_id: e.needId,
  player: {
    id: e.player.id,
    full_name: e.player.fullName,
    position: e.player.primaryPosition,
    current_team: e.player.currentTeam,
  },
  stage: e.stage,
  pending_acceptance: e.pendingAcceptance,
  proposed_by: e.proposedBy,
  owner_id: e.ownerId,
  decision_reason: e.decisionReason,
  updated_at: e.updatedAt.toISOString(),
});

type LockedEntry = {
  id: string;
  player_id: string;
  stage: ShortlistStage;
  pending_acceptance: boolean;
  need_status: 'open' | 'closed';
};

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === 'P2002';
const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
const ttlDays = () => Number(process.env.MEDICAL_CLEARANCE_TTL_DAYS ?? 30);

@Injectable()
export class ShortlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly needs: NeedsService,
  ) {}

  async listForNeed(user: AuthUser, needId: string, stage?: ShortlistStage): Promise<ShortlistEntryDto[]> {
    await this.needs.find(user, needId);
    const rows = await this.prisma.shortlistEntry.findMany({
      where: { needId, clubId: user.clubId, ...(stage ? { stage } : {}) },
      include,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toDto);
  }

  // HoR and SD add directly; an analyst's add is only a proposal until HoR or SD accepts it (US-06).
  async add(user: AuthUser, needId: string, playerId: string): Promise<ShortlistEntryDto> {
    const need = await this.needs.find(user, needId);
    if (need.status === 'closed') throw conflict('NEED_CLOSED', 'Need is closed; its shortlist is locked');
    const player = await this.prisma.player.findFirst({ where: { id: playerId, clubId: user.clubId }, select: { id: true } });
    if (!player) throw new AppError(404, 'NOT_FOUND', 'Player not found');

    const proposal = user.role === 'analyst';
    try {
      return await this.prisma.$transaction(async (tx) => {
        const entry = await tx.shortlistEntry.create({
          data: {
            clubId: user.clubId,
            needId,
            playerId,
            pendingAcceptance: proposal,
            proposedBy: proposal ? user.id : null,
            ownerId: proposal ? null : user.id,
          },
          include,
        });
        await tx.stageHistory.create({
          data: { entryId: entry.id, toStage: 'identified', actorId: user.id, reason: proposal ? 'proposed' : null },
        });
        return toDto(entry);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('ALREADY_SHORTLISTED', 'Player is already on this shortlist');
      throw err;
    }
  }

  async accept(user: AuthUser, entryId: string): Promise<ShortlistEntryDto> {
    return this.prisma.$transaction(async (tx) => {
      const entry = await this.lock(tx, user, entryId);
      if (entry.need_status === 'closed') throw conflict('NEED_CLOSED', 'Need is closed; its shortlist is locked');
      if (!entry.pending_acceptance) throw conflict('NOT_PENDING', 'Entry is not a pending proposal');
      return toDto(
        await tx.shortlistEntry.update({
          where: { id: entryId },
          data: { pendingAcceptance: false, ownerId: user.id },
          include,
        }),
      );
    });
  }

  // Runs under withRole: the medical gate reads clearances through the RLS-filtered view.
  transition(user: AuthUser, entryId: string, req: TransitionRequest): Promise<ShortlistEntryDto> {
    return this.prisma.withRole(user.role, async (tx) => {
      const entry = await this.lock(tx, user, entryId);
      if (entry.need_status === 'closed') throw conflict('NEED_CLOSED', 'Need is closed; its shortlist is locked');
      if (entry.pending_acceptance) throw conflict('PENDING_ACCEPTANCE', 'Proposal must be accepted before it moves');

      const edge = checkEdge(entry.stage, req.to, user.role);
      if (!edge.ok && edge.error === 'invalid') {
        throw conflict('INVALID_STAGE_TRANSITION', `Cannot move from ${entry.stage} to ${req.to}`, {
          from: entry.stage,
          allowed: edge.allowed,
        });
      }
      if (!edge.ok) throw new AppError(403, 'FORBIDDEN', `Your role cannot move ${entry.stage} -> ${req.to}`);

      const reason = req.reason?.trim() || null;
      if (needsReason(entry.stage, req.to) && (reason?.length ?? 0) < MIN_REASON_LENGTH) {
        throw new AppError(400, 'VALIDATION_FAILED', `A reason of at least ${MIN_REASON_LENGTH} characters is required`);
      }
      await this.assertPreconditions(tx, user, entry, req);

      try {
        const updated = await tx.shortlistEntry.update({
          where: { id: entryId },
          data: { stage: req.to, ...(req.to === 'rejected' ? { decisionReason: reason } : {}) },
          include,
        });
        await tx.stageHistory.create({
          data: { entryId, fromStage: entry.stage, toStage: req.to, actorId: user.id, reason },
        });
        return toDto(updated);
      } catch (err) {
        // the DB trigger is the backstop for the gate; surface it as the same API error
        if (String(err).includes('MEDICAL_GATE_REQUIRED')) throw this.gateError();
        throw err;
      }
    });
  }

  async history(user: AuthUser, entryId: string): Promise<StageHistoryDto[]> {
    const entry = await this.prisma.shortlistEntry.findFirst({ where: { id: entryId, clubId: user.clubId }, select: { id: true } });
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'Shortlist entry not found');
    const rows = await this.prisma.stageHistory.findMany({ where: { entryId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return rows.map((h) => ({
      id: h.id,
      from_stage: h.fromStage,
      to_stage: h.toStage,
      actor_id: h.actorId,
      reason: h.reason,
      at: h.at.toISOString(),
    }));
  }

  // Doctor records the medical gate result (spec mục 5). A rejected result moves the entry to
  // rejected in the same transaction: both happen or neither does.
  recordClearance(user: AuthUser, entryId: string, req: ClearanceRequest, ip?: string): Promise<ClearanceDto> {
    return this.prisma.withRole(user.role, async (tx) => {
      const entry = await this.lock(tx, user, entryId);
      if (entry.stage !== 'medical') {
        throw conflict('NOT_IN_MEDICAL_STAGE', `Entry is in ${entry.stage}, clearances are recorded in medical`);
      }
      const clearance = await tx.medicalClearance.create({
        data: { entryId, doctorId: user.id, result: req.result, note: req.note ?? null },
      });
      await writeAudit(tx, { actorId: user.id, action: 'create', entity: 'medical.medical_clearances', entityId: clearance.id, ip });

      let stage: ShortlistStage = entry.stage;
      if (req.result === 'rejected') {
        stage = 'rejected';
        await tx.shortlistEntry.update({ where: { id: entryId }, data: { stage, decisionReason: 'medical_rejected' } });
        await tx.stageHistory.create({
          data: { entryId, fromStage: 'medical', toStage: 'rejected', actorId: user.id, reason: 'medical_rejected' },
        });
      }
      return {
        id: clearance.id,
        entry_id: entryId,
        result: clearance.result,
        doctor_id: clearance.doctorId,
        at: clearance.at.toISOString(),
        entry_stage: stage,
      };
    });
  }

  // Row lock: two concurrent moves of the same entry run one after the other, so the second
  // sees the new stage and fails the edge check instead of double-moving.
  private async lock(tx: Prisma.TransactionClient, user: AuthUser, entryId: string): Promise<LockedEntry> {
    const [entry] = await tx.$queryRaw<LockedEntry[]>`
      SELECT e.id, e.player_id, e.stage::text AS stage, e.pending_acceptance, n.status::text AS need_status
      FROM recruitment.shortlist_entries e
      JOIN recruitment.recruitment_needs n ON n.id = e.need_id
      WHERE e.id = ${entryId}::uuid AND e.club_id = ${user.clubId}::uuid
      FOR UPDATE OF e`;
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'Shortlist entry not found');
    return entry;
  }

  private async assertPreconditions(tx: Prisma.TransactionClient, user: AuthUser, entry: LockedEntry, req: TransitionRequest) {
    const unmet = (message: string) => conflict('TRANSITION_PRECONDITION_FAILED', message);

    if (entry.stage === 'screened' && req.to === 'scouted') {
      const assigned = await tx.scoutAssignment.count({ where: { playerId: entry.player_id } });
      if (!assigned) throw unmet('Assign a scout to this player first');
    }
    if (entry.stage === 'scouted' && req.to === 'committee') {
      const reports = await tx.scoutReport.count({
        where: { playerId: entry.player_id, clubId: user.clubId, submittedAt: { not: null } },
      });
      if (!reports) throw unmet('At least one submitted scout report is required');
    }
    if (entry.stage === 'medical' && req.to === 'approved') {
      const [{ valid }] = await tx.$queryRaw<{ valid: boolean }[]>`
        SELECT recruitment.has_valid_clearance(${entry.id}::uuid, ${ttlDays()}::int) AS valid`;
      if (!valid) throw this.gateError();
      // result only: the view never exposes the doctor's note to SD or HoR
      const [latest] = await tx.$queryRaw<{ result: string }[]>`
        SELECT result::text AS result FROM recruitment.clearance_summary
        WHERE entry_id = ${entry.id}::uuid ORDER BY at DESC LIMIT 1`;
      if (latest?.result === 'conditional' && !req.acknowledge_conditions) {
        throw conflict('MEDICAL_GATE_REQUIRED', 'Clearance is conditional: set acknowledge_conditions to approve', {
          conditional: true,
        });
      }
    }
  }

  private gateError() {
    return conflict('MEDICAL_GATE_REQUIRED', 'A valid medical clearance (cleared or conditional) is required');
  }
}
