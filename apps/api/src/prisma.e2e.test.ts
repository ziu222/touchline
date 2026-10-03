// withRole: the API's side of RLS. Connects as touchline_app, so policies apply.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTestApp } from './test-utils.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let playerId: string;
before(async () => {
  t = await startTestApp();
  playerId = (await t.prisma.player.create({ data: { clubId: t.clubId, fullName: 'RLS Probe' } })).id;
  await t.prisma.withRole('doctor', (tx) =>
    tx.injury.create({
      data: {
        clubId: t.clubId,
        playerId,
        injuredOn: new Date('2026-01-01'),
        activity: 'match',
        bodyRegion: 'hamstring',
        severityDays: 10,
        severityClass: 'd8_28',
      },
    }),
  );
});
after(async () => {
  await t.prisma.withRole('doctor', (tx) => tx.injury.deleteMany({ where: { playerId } }));
  await t.prisma.player.delete({ where: { id: playerId } });
  await t.close();
});

const countAs = (role: Parameters<typeof t.prisma.withRole>[0]) =>
  t.prisma.withRole(role, (tx) => tx.injury.count({ where: { playerId } }));

test('doctor sees the injury, every other role sees nothing', async () => {
  assert.equal(await countAs('doctor'), 1);
  for (const role of ['scout', 'analyst', 'head_coach', 'head_recruitment', 'sporting_director', 'admin'] as const) {
    assert.equal(await countAs(role), 0, role);
  }
});

test('outside withRole there is no role, so 0 rows', async () => {
  assert.equal(await t.prisma.injury.count({ where: { playerId } }), 0);
});

test('role does not leak to later queries on pooled connections', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(await countAs('doctor'), 1);
    assert.equal(await t.prisma.injury.count({ where: { playerId } }), 0);
  }
});

test('non-doctor cannot write injuries', async () => {
  await assert.rejects(
    t.prisma.withRole('scout', (tx) =>
      tx.injury.create({
        data: {
          clubId: t.clubId,
          playerId,
          injuredOn: new Date('2026-02-01'),
          activity: 'training',
          bodyRegion: 'calf',
          severityDays: 2,
          severityClass: 'd1_3',
        },
      }),
    ),
  );
});
