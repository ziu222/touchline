import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTestApp } from '../test-utils.js';
import { sharedStrengths } from './players.service.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let analyst: Awaited<ReturnType<typeof t.loginAs>>;
const ids: Record<string, string> = {};

// Forwards: "striker" is the target. "twin" shares its profile, "creator" is a different style,
// "young" is like the twin but born later, "bench" has too few minutes for an embedding.
before(async () => {
  t = await startTestApp();
  analyst = await t.loginAs('analyst');
  const striker = { goals: 2, shots: 2, dribbles: 0.5 };
  ids.striker = await t.createPlayer({
    name: 'Alpha Striker',
    group: 'fwd',
    minutes: 3000,
    dob: '1990-01-01',
    per90: { goals: 0.9, shots: 4 },
    z: striker,
    availability: 'fit',
  });
  ids.twin = await t.createPlayer({
    name: 'Beta Twin',
    group: 'fwd',
    minutes: 2500,
    dob: '1990-06-01',
    per90: { goals: 0.8, shots: 3.8 },
    z: { goals: 1.8, shots: 1.6, dribbles: 0.4 },
    availability: 'out',
  });
  ids.creator = await t.createPlayer({
    name: 'Gamma Creator',
    group: 'fwd',
    minutes: 2000,
    dob: '1992-01-01',
    per90: { goals: 0.2, key_passes: 3 },
    z: { goals: -0.5, key_passes: 2.5, smart_passes: 2 },
  });
  ids.young = await t.createPlayer({
    name: 'Delta Young',
    group: 'fwd',
    minutes: 1200,
    dob: '1999-01-01',
    per90: { goals: 0.7, shots: 3.5 },
    z: { goals: 1.7, shots: 1.5, dribbles: 0.3 },
  });
  ids.bench = await t.createPlayer({ name: 'Epsilon Bench', group: 'fwd', minutes: 300, dob: '1994-01-01' });
  ids.keeper = await t.createPlayer({
    name: 'Zeta Keeper',
    group: 'gk',
    minutes: 3000,
    per90: { saves: 3 },
    z: { goals: 2, shots: 2, saves: 2 },
  });
  ids.fake = await t.createPlayer({
    name: 'Eta Synthetic',
    group: 'fwd',
    minutes: 2000,
    synthetic: true,
    per90: { goals: 0.9 },
    z: { goals: 2, shots: 2 },
  });
});
after(() => t.close());

const get = (path: string, token = analyst.token) => t.request('GET', path, { token });

test('list: filters by group, minutes and per-90 minimum, sorted by that metric', async () => {
  const res = await get('/players?position_group=fwd&min_minutes=1000&min_goals=0.5&sort=goals');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.data.map((p: { full_name: string }) => p.full_name),
    ['Alpha Striker', 'Beta Twin', 'Delta Young'],
  );
  assert.equal(res.body.meta.total, 3);
  assert.equal(res.body.data[0].per90.goals, 0.9);
  assert.equal(res.body.data[0].season, '2017/18');
});

test('list: age is taken mid-season (1 Jan 2018) and filters on it', async () => {
  const res = await get('/players?position_group=fwd&max_age=20');
  assert.deepEqual(res.body.data.map((p: { full_name: string; age: number }) => [p.full_name, p.age]), [['Delta Young', 19]]);
});

test('list: synthetic players hidden unless asked for; name search; pagination', async () => {
  const names = (r: { body: { data: { full_name: string }[] } }) => r.body.data.map((p) => p.full_name);
  assert.ok(!names(await get('/players?limit=100')).includes('Eta Synthetic'));
  assert.ok(names(await get('/players?limit=100&include_synthetic=true')).includes('Eta Synthetic'));
  assert.deepEqual(names(await get('/players?q=gamma')), ['Gamma Creator']);

  const page = await get('/players?limit=2&page=2&sort=full_name&order=asc');
  assert.deepEqual(names(page), ['Delta Young', 'Epsilon Bench']);
  assert.equal(page.body.meta.total, 6);
});

test('list: no match is an empty page, not an error; bad query is 400', async () => {
  const empty = await get('/players?min_goals=50');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, []);
  assert.equal((await get('/players?limit=101')).status, 400);
  assert.equal((await get('/players?min_age=30&max_age=20')).status, 400);
  assert.equal((await get('/players?position_group=striker')).status, 400);
});

test('scout sees only assigned players; others are 404, similar is 403', async () => {
  const scout = await t.loginAs('scout');
  await t.prisma.scoutAssignment.create({ data: { scoutId: scout.id, playerId: ids.twin! } });

  const list = await get('/players', scout.token);
  assert.deepEqual(list.body.data.map((p: { id: string }) => p.id), [ids.twin]);
  assert.equal(list.body.data[0].availability, null, 'scouts may not see availability');
  assert.equal((await get(`/players/${ids.twin}`, scout.token)).status, 200);
  assert.equal((await get(`/players/${ids.striker}`, scout.token)).status, 404);
  assert.equal((await get(`/players/${ids.twin}/similar`, scout.token)).status, 403);
});

test('coach sees only players on a shortlist shared with the coach', async () => {
  const coach = await t.loginAs('head_coach');
  assert.equal((await get('/players', coach.token)).body.meta.total, 0);

  const hor = await t.createUser('head_recruitment');
  const role = await t.prisma.playerRole.upsert({
    where: { name: 'Forward' },
    update: {},
    create: { name: 'Forward', positionGroup: 'fwd' },
  });
  const need = await t.prisma.recruitmentNeed.create({
    data: {
      clubId: t.clubId,
      roleId: role.id,
      ageMin: 18,
      ageMax: 30,
      feeBudget: 1,
      deadline: new Date('2030-01-01'),
      createdBy: hor.id,
      sharedWithCoach: true,
    },
  });
  await t.prisma.shortlistEntry.create({ data: { clubId: t.clubId, needId: need.id, playerId: ids.creator! } });

  const list = await get('/players', coach.token);
  assert.deepEqual(list.body.data.map((p: { id: string }) => p.id), [ids.creator]);
  assert.equal(list.body.data[0].availability, null);
});

test('admin cannot read players', async () => {
  const admin = await t.loginAs('admin');
  assert.equal((await get('/players', admin.token)).status, 403);
});

test('profile: stats, availability for allowed roles, unknown id is 404', async () => {
  const res = await get(`/players/${ids.striker}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.full_name, 'Alpha Striker');
  assert.equal(res.body.seasons[0].minutes, 3000);
  assert.equal(res.body.availability.status, 'fit');
  assert.deepEqual(res.body.reports, []);
  assert.equal((await get('/players/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('similar: same group, target excluded, ordered by similarity, explained', async () => {
  const res = await get(`/players/${ids.striker}/similar`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.meta, { model_version: 'test-v1', season: '2017/18', mode: 'exact' });

  const names = res.body.data.map((s: { player: { full_name: string } }) => s.player.full_name);
  assert.deepEqual(names, ['Beta Twin', 'Delta Young', 'Gamma Creator'], 'no keeper, no synthetic, no bench, no self');
  const [twin] = res.body.data;
  assert.ok(twin.similarity > 0.99);
  assert.ok(res.body.data[2].similarity < 0);
  assert.deepEqual(twin.shared_strengths, ['goals', 'shots']);
  assert.equal(twin.availability, 'out');
});

test('similar: limit, age filter and synthetic opt-in', async () => {
  const names = (r: { body: { data: { player: { full_name: string } }[] } }) => r.body.data.map((s) => s.player.full_name);
  assert.deepEqual(names(await get(`/players/${ids.striker}/similar?limit=1`)), ['Beta Twin']);
  assert.deepEqual(names(await get(`/players/${ids.striker}/similar?max_age=20`)), ['Delta Young']);
  assert.ok(names(await get(`/players/${ids.striker}/similar?include_synthetic=true`)).includes('Eta Synthetic'));
});

test('similar: under 700 minutes is 422, unknown is 404', async () => {
  const res = await get(`/players/${ids.bench}/similar`);
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'INSUFFICIENT_DATA');
  assert.equal((await get('/players/00000000-0000-4000-8000-000000000000/similar')).status, 404);
});

test('sharedStrengths: both >= 1 std, strongest shared first, at most 3', () => {
  assert.deepEqual(
    sharedStrengths({ goals: 3, shots: 1.2, key_passes: 2, saves: 5, dribbles: 0.9 }, { goals: 1.5, shots: 2, key_passes: 1.1, saves: 1, dribbles: 3 }),
    ['goals', 'shots', 'key_passes'],
  );
  assert.deepEqual(sharedStrengths(null, { goals: 2 }), []);
});
