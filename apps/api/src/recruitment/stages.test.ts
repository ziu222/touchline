import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortlistStages, userRoles } from '@touchline/shared';
import { checkEdge, EDGES, needsReason } from './stages.js';

test('the spec edge table, edge by edge', () => {
  const ok = (from: string, to: string, role: string) =>
    assert.equal(checkEdge(from as never, to as never, role as never).ok, true, `${from}->${to} by ${role}`);
  ok('identified', 'screened', 'head_recruitment');
  ok('identified', 'screened', 'sporting_director');
  ok('screened', 'scouted', 'head_recruitment');
  ok('scouted', 'committee', 'head_recruitment');
  ok('committee', 'medical', 'sporting_director');
  ok('committee', 'scouted', 'head_recruitment');
  ok('medical', 'approved', 'sporting_director');
  ok('committee', 'rejected', 'sporting_director');
});

test('wrong role on a legal edge is forbidden, not invalid', () => {
  assert.deepEqual(checkEdge('screened', 'scouted', 'sporting_director'), { ok: false, error: 'forbidden' });
  assert.deepEqual(checkEdge('committee', 'rejected', 'head_recruitment'), { ok: false, error: 'forbidden' });
  assert.deepEqual(checkEdge('medical', 'approved', 'head_recruitment'), { ok: false, error: 'forbidden' });
});

test('illegal edges list what is allowed from the current stage', () => {
  assert.deepEqual(checkEdge('identified', 'approved', 'sporting_director'), {
    ok: false,
    error: 'invalid',
    allowed: ['screened', 'rejected'],
  });
  assert.deepEqual(checkEdge('approved', 'rejected', 'sporting_director'), { ok: false, error: 'invalid', allowed: [] });
});

test('every non-terminal stage can be rejected; only roles SD/HoR ever move stages', () => {
  for (const s of shortlistStages.filter((s) => s !== 'approved' && s !== 'rejected')) {
    assert.ok(EDGES[s].rejected, s);
  }
  const movers = new Set(Object.values(EDGES).flatMap((to) => Object.values(to).flat()));
  assert.deepEqual([...movers].sort(), ['head_recruitment', 'sporting_director']);
  assert.ok(userRoles.includes('doctor'), 'doctor reaches rejected only through a clearance, not an edge');
});

test('reason required for rejection and for sending back to scouted', () => {
  assert.equal(needsReason('screened', 'rejected'), true);
  assert.equal(needsReason('committee', 'scouted'), true);
  assert.equal(needsReason('identified', 'screened'), false);
});
