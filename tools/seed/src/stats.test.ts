import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countEvents, embedding, EMBEDDING_DIM, minutesPlayed, per90, zScores, groupStats, type WyEvent } from './stats.js';

test('minutes: starter subbed off at 60, sub on at 60, full 90', () => {
  const played = minutesPlayed([
    {
      teamsData: {
        '1': {
          teamId: 1,
          formation: {
            lineup: [{ playerId: 10 }, { playerId: 11 }],
            substitutions: [{ playerIn: 12, playerOut: 10, minute: 60 }],
          },
        },
        '2': { teamId: 2, formation: { lineup: [{ playerId: 20 }], substitutions: 'null' } },
      },
    },
  ]);
  assert.equal(played.get(10)?.minutes, 60);
  assert.equal(played.get(11)?.minutes, 90);
  assert.equal(played.get(12)?.minutes, 30);
  assert.equal(played.get(20)?.minutes, 90);
});

test('counts: accurate pass, key pass, goal, own goal excluded, won aerial duel', () => {
  const ev = (eventId: number, subEventId: number, ...tags: number[]): WyEvent => ({
    playerId: 7,
    eventId,
    subEventId,
    tags: tags.map((id) => ({ id })),
  });
  const c = countEvents([
    ev(8, 85, 1801),
    ev(8, 86, 302, 1802),
    ev(10, 100, 101, 1801),
    ev(10, 100, 101, 102),
    ev(1, 10, 703),
  ]).get(7)!;
  assert.equal(c.passes, 2);
  assert.equal(c.accurate_passes, 1);
  assert.equal(c.key_passes, 1);
  assert.equal(c.smart_passes, 1);
  assert.equal(c.shots, 2);
  assert.equal(c.goals, 1);
  assert.equal(c.aerial_duels_won, 1);

  const p = per90(c, 180);
  assert.equal(p.passes, 1);
  assert.equal(p.pass_accuracy, 0.5);
});

test('embedding: 32 dims, unit length, zero-variance features become 0', () => {
  const counts = (passes: number, shots: number) =>
    countEvents([
      ...Array.from({ length: passes }, () => ({ playerId: 1, eventId: 8, subEventId: 85 as const, tags: [] })),
      ...Array.from({ length: shots }, () => ({ playerId: 1, eventId: 10, subEventId: 100 as const, tags: [] })),
    ]).get(1)!;
  const rows = [per90(counts(10, 1), 90), per90(counts(30, 3), 90), per90(counts(20, 2), 90)];
  const stats = groupStats(rows);
  assert.equal(stats.saves.std, 0);
  assert.equal(zScores(rows[0]!, stats).saves, 0);
  const v = embedding(zScores(rows[0]!, stats));
  assert.equal(v.length, EMBEDDING_DIM);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-2);
});
