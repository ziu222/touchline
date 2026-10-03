// The shortlist state machine (spec mục 5), as data. Pure: no DB, unit-tested in stages.test.ts.
// Preconditions that need the DB (scout assigned, report submitted, medical clearance) live in
// ShortlistService; this file only answers "is this edge legal, and for whom".
import type { ShortlistStage, UserRole } from '@touchline/shared';

const SD = 'sporting_director';
const HOR = 'head_recruitment';

// from -> to -> roles allowed to take that edge. approved and rejected are terminal.
// medical -> rejected also happens automatically when a doctor records a rejected clearance.
export const EDGES: Record<ShortlistStage, Partial<Record<ShortlistStage, readonly UserRole[]>>> = {
  identified: { screened: [HOR, SD], rejected: [HOR, SD] },
  screened: { scouted: [HOR], rejected: [HOR, SD] },
  scouted: { committee: [HOR], rejected: [HOR, SD] },
  committee: { medical: [SD], scouted: [HOR, SD], rejected: [SD] },
  medical: { approved: [SD], rejected: [HOR, SD] },
  approved: {},
  rejected: {},
};

export const MIN_REASON_LENGTH = 10;

export const allowedFrom = (from: ShortlistStage) => Object.keys(EDGES[from]) as ShortlistStage[];

// a reason is mandatory when a candidate is dropped or sent back for more reports
export const needsReason = (from: ShortlistStage, to: ShortlistStage) =>
  to === 'rejected' || (from === 'committee' && to === 'scouted');

export type EdgeCheck = { ok: true } | { ok: false; error: 'invalid'; allowed: ShortlistStage[] } | { ok: false; error: 'forbidden' };

export function checkEdge(from: ShortlistStage, to: ShortlistStage, role: UserRole): EdgeCheck {
  const roles = EDGES[from][to];
  if (!roles) return { ok: false, error: 'invalid', allowed: allowedFrom(from) };
  if (!roles.includes(role)) return { ok: false, error: 'forbidden' };
  return { ok: true };
}
