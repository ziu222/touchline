import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ShortlistStage } from '@touchline/shared';
import { startTestApp } from '../test-utils.js';

type T = Awaited<ReturnType<typeof startTestApp>>;
type User = Awaited<ReturnType<T['loginAs']>>;

let t: T;
let sd: User, hor: User, analyst: User, coach: User, doctor: User, scout: User;
let roleId: string;

before(async () => {
  t = await startTestApp();
  [sd, hor, analyst, coach, doctor, scout] = await Promise.all(
    (['sporting_director', 'head_recruitment', 'analyst', 'head_coach', 'doctor', 'scout'] as const).map((r) => t.loginAs(r)),
  );
  roleId = (await t.playerRole()).id;
});
after(() => t.close());

const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;
const needBody = (extra: Record<string, unknown> = {}) => ({
  role_id: roleId,
  age_min: 20,
  age_max: 27,
  fee_budget: '1500000.50',
  deadline: nextYear,
  ...extra,
});

let playerSeq = 0;
const newPlayer = () => t.createPlayer({ name: `Prospect ${++playerSeq}`, group: 'fwd' });

async function newNeed(extra: Record<string, unknown> = {}) {
  const res = await t.request('POST', '/needs', { token: hor.token, body: needBody(extra) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}

async function newEntry(needId?: string) {
  const res = await t.request('POST', `/needs/${needId ?? (await newNeed())}/shortlist`, {
    token: hor.token,
    body: { player_id: await newPlayer() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; player: { id: string }; stage: ShortlistStage };
}

const move = (entryId: string, user: User, to: ShortlistStage, extra: Record<string, unknown> = {}) =>
  t.request('POST', `/shortlist/${entryId}/transitions`, { token: user.token, body: { to, ...extra } });

const clearance = (entryId: string, result: string, user = doctor) =>
  t.request('POST', `/shortlist/${entryId}/medical-clearance`, { token: user.token, body: { result, note: 'secret note' } });

// skip the earlier stages when a test is about a later edge (the DB trigger still guards approved)
const setStage = (entryId: string, stage: ShortlistStage) =>
  t.prisma.shortlistEntry.update({ where: { id: entryId }, data: { stage } });

// ───────── needs ─────────

test('needs: HoR creates; validation rejects past deadline, bad ages, unknown role', async () => {
  const res = await t.request('POST', '/needs', { token: hor.token, body: needBody() });
  assert.equal(res.status, 201);
  assert.equal(res.body.fee_budget, '1500000.5');
  assert.equal(res.body.status, 'open');
  assert.equal(res.body.role.name, 'Forward');

  const bad = async (body: Record<string, unknown>) =>
    assert.equal((await t.request('POST', '/needs', { token: hor.token, body: needBody(body) })).status, 400, JSON.stringify(body));
  await bad({ deadline: '2020-01-01' });
  await bad({ age_min: 30, age_max: 20 });
  await bad({ role_id: '00000000-0000-4000-8000-000000000000' });
  await bad({ fee_budget: -1 });
});

test('needs: only SD and HoR write; coach lists only shared needs', async () => {
  assert.equal((await t.request('POST', '/needs', { token: analyst.token, body: needBody() })).status, 403);
  assert.equal((await t.request('POST', '/needs', { token: scout.token, body: needBody() })).status, 403);

  const shared = await newNeed({ shared_with_coach: true });
  const hidden = await newNeed();
  const list = await t.request('GET', '/needs?limit=100', { token: coach.token });
  const ids = list.body.data.map((n: { id: string }) => n.id);
  assert.ok(ids.includes(shared));
  assert.ok(!ids.includes(hidden));
  assert.equal((await t.request('GET', `/needs/${hidden}`, { token: coach.token })).status, 404);
});

test('needs: closing locks the shortlist without deleting it; reopening unlocks', async () => {
  const needId = await newNeed();
  const entry = await newEntry(needId);
  const closed = await t.request('PATCH', `/needs/${needId}`, { token: hor.token, body: { status: 'closed' } });
  assert.equal(closed.body.status, 'closed');

  const add = await t.request('POST', `/needs/${needId}/shortlist`, { token: hor.token, body: { player_id: await newPlayer() } });
  assert.equal(add.status, 409);
  assert.equal(add.body.error.code, 'NEED_CLOSED');
  assert.equal((await move(entry.id, hor, 'screened')).body.error.code, 'NEED_CLOSED');
  assert.equal((await t.request('GET', `/needs/${needId}/shortlist`, { token: hor.token })).body.length, 1);

  await t.request('PATCH', `/needs/${needId}`, { token: hor.token, body: { status: 'open' } });
  assert.equal((await move(entry.id, hor, 'screened')).status, 200);
});

test('needs: PATCH re-validates ages against the stored values', async () => {
  const needId = await newNeed();
  const res = await t.request('PATCH', `/needs/${needId}`, { token: hor.token, body: { age_min: 30 } });
  assert.equal(res.status, 400);
});

// ───────── shortlist ─────────

test('shortlist: duplicate player is 409, unknown player 404, coach cannot add', async () => {
  const needId = await newNeed();
  const playerId = await newPlayer();
  const body = { player_id: playerId };
  assert.equal((await t.request('POST', `/needs/${needId}/shortlist`, { token: hor.token, body })).status, 201);
  const dup = await t.request('POST', `/needs/${needId}/shortlist`, { token: sd.token, body });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'ALREADY_SHORTLISTED');
  const missing = { player_id: '00000000-0000-4000-8000-000000000000' };
  assert.equal((await t.request('POST', `/needs/${needId}/shortlist`, { token: hor.token, body: missing })).status, 404);
  assert.equal((await t.request('POST', `/needs/${needId}/shortlist`, { token: coach.token, body })).status, 403);
});

test('shortlist: analyst only proposes; it cannot move until HoR accepts', async () => {
  const needId = await newNeed();
  const res = await t.request('POST', `/needs/${needId}/shortlist`, { token: analyst.token, body: { player_id: await newPlayer() } });
  assert.equal(res.status, 201);
  assert.equal(res.body.pending_acceptance, true);
  assert.equal(res.body.proposed_by, analyst.id);

  const blocked = await move(res.body.id, hor, 'screened');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PENDING_ACCEPTANCE');

  const accepted = await t.request('POST', `/shortlist/${res.body.id}/accept`, { token: hor.token });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.pending_acceptance, false);
  assert.equal((await t.request('POST', `/shortlist/${res.body.id}/accept`, { token: hor.token })).body.error.code, 'NOT_PENDING');
  assert.equal((await move(res.body.id, hor, 'screened')).status, 200);
});

test('full path: identified -> screened -> scouted -> committee -> medical -> approved', async () => {
  const entry = await newEntry();

  assert.equal((await move(entry.id, hor, 'screened')).status, 200);

  const noScout = await move(entry.id, hor, 'scouted');
  assert.equal(noScout.status, 409);
  assert.equal(noScout.body.error.code, 'TRANSITION_PRECONDITION_FAILED');
  await t.prisma.scoutAssignment.create({ data: { scoutId: scout.id, playerId: entry.player.id } });
  assert.equal((await move(entry.id, hor, 'scouted')).status, 200);

  assert.equal((await move(entry.id, hor, 'committee')).body.error.code, 'TRANSITION_PRECONDITION_FAILED');
  await t.submitReport(entry.player.id, scout.id);
  assert.equal((await move(entry.id, hor, 'committee')).status, 200);

  assert.equal((await move(entry.id, hor, 'medical')).status, 403, 'only SD sends to medical');
  assert.equal((await move(entry.id, sd, 'medical')).status, 200);

  const gate = await move(entry.id, sd, 'approved');
  assert.equal(gate.status, 409);
  assert.equal(gate.body.error.code, 'MEDICAL_GATE_REQUIRED');

  assert.equal((await clearance(entry.id, 'cleared')).status, 201);
  const approved = await move(entry.id, sd, 'approved');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.stage, 'approved');

  const history = await t.request('GET', `/shortlist/${entry.id}/history`, { token: sd.token });
  assert.deepEqual(
    history.body.map((h: { from_stage: string | null; to_stage: string }) => `${h.from_stage}->${h.to_stage}`),
    ['null->identified', 'identified->screened', 'screened->scouted', 'scouted->committee', 'committee->medical', 'medical->approved'],
    'failed attempts (gate, preconditions) leave no history',
  );
  assert.equal(history.body.at(-1).actor_id, sd.id);

  const terminal = await move(entry.id, sd, 'rejected', { reason: 'changed our mind' });
  assert.equal(terminal.status, 409);
  assert.deepEqual(terminal.body.error.details.allowed, []);
});

test('illegal edge is 409 with the allowed stages; wrong role is 403', async () => {
  const entry = await newEntry();
  const res = await move(entry.id, sd, 'approved');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INVALID_STAGE_TRANSITION');
  assert.deepEqual(res.body.error.details, { from: 'identified', allowed: ['screened', 'rejected'] });

  await setStage(entry.id, 'screened');
  assert.equal((await move(entry.id, sd, 'scouted')).status, 403, 'screened -> scouted is HoR only');
  for (const user of [analyst, coach, doctor, scout]) assert.equal((await move(entry.id, user, 'rejected')).status, 403);
});

test('reject needs a reason of 10+ characters, stored as decision_reason; committee rejects are SD only', async () => {
  const entry = await newEntry();
  assert.equal((await move(entry.id, hor, 'rejected', { reason: 'too slow' })).status, 400);
  const res = await move(entry.id, hor, 'rejected', { reason: 'Not fast enough for our press' });
  assert.equal(res.status, 200);
  assert.equal(res.body.decision_reason, 'Not fast enough for our press');

  const atCommittee = await newEntry();
  await setStage(atCommittee.id, 'committee');
  const reason = { reason: 'Committee voted against' };
  assert.equal((await move(atCommittee.id, hor, 'rejected', reason)).status, 403);
  assert.equal((await move(atCommittee.id, hor, 'scouted', { reason: 'short' })).status, 400, 'sending back needs a reason');
  assert.equal((await move(atCommittee.id, hor, 'scouted', { reason: 'Need a live report too' })).status, 200);
});

test('conditional clearance: approving requires acknowledge_conditions', async () => {
  const entry = await newEntry();
  await setStage(entry.id, 'medical');
  assert.equal((await clearance(entry.id, 'conditional')).status, 201);

  const res = await move(entry.id, sd, 'approved');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.error.details, { conditional: true });
  assert.equal((await move(entry.id, sd, 'approved', { acknowledge_conditions: true })).status, 200);
});

test('rejected clearance moves the entry to rejected in the same transaction', async () => {
  const entry = await newEntry();
  await setStage(entry.id, 'medical');
  const res = await clearance(entry.id, 'rejected');
  assert.equal(res.status, 201);
  assert.equal(res.body.entry_stage, 'rejected');
  assert.ok(!('note' in res.body));

  const history = await t.request('GET', `/shortlist/${entry.id}/history`, { token: hor.token });
  assert.deepEqual(history.body.at(-1), { ...history.body.at(-1), to_stage: 'rejected', reason: 'medical_rejected', actor_id: doctor.id });
  const audit = await t.prisma.auditLog.count({ where: { entity: 'medical.medical_clearances', actorId: doctor.id } });
  assert.ok(audit >= 1);
});

test('clearance: only doctors, only in medical stage', async () => {
  const entry = await newEntry();
  assert.equal((await clearance(entry.id, 'cleared')).body.error.code, 'NOT_IN_MEDICAL_STAGE');
  await setStage(entry.id, 'medical');
  for (const user of [sd, hor, analyst, scout, coach]) assert.equal((await clearance(entry.id, 'cleared', user)).status, 403);
});

test('two concurrent moves of the same entry: exactly one wins', async () => {
  const entry = await newEntry();
  const results = await Promise.all([move(entry.id, hor, 'screened'), move(entry.id, sd, 'screened')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const history = await t.request('GET', `/shortlist/${entry.id}/history`, { token: hor.token });
  assert.equal(history.body.length, 2, 'one create + one move');
});

test('history is SD and HoR only; list shortlist by stage', async () => {
  const needId = await newNeed({ shared_with_coach: true });
  const entry = await newEntry(needId);
  assert.equal((await t.request('GET', `/shortlist/${entry.id}/history`, { token: analyst.token })).status, 403);

  await move(entry.id, hor, 'screened');
  const screened = await t.request('GET', `/needs/${needId}/shortlist?stage=screened`, { token: coach.token });
  assert.equal(screened.status, 200);
  assert.deepEqual(screened.body.map((e: { id: string }) => e.id), [entry.id]);
  assert.deepEqual((await t.request('GET', `/needs/${needId}/shortlist?stage=identified`, { token: hor.token })).body, []);
});
