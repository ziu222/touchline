// Seed: Wyscout 2017/18 real players + synthetic top-up to 5,000 + demo club and users.
// Writes directly to Postgres as the table owner (MIGRATION_DATABASE_URL). Safe to re-run.
import { createHash, argon2, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import {
  countEvents,
  embedding,
  groupByRole,
  groupStats,
  mainTeam,
  MIN_MINUTES,
  minutesPlayed,
  MODEL_VERSION,
  per90,
  SEASON,
  zScores,
  type Counts,
  type GroupStats,
  type Per90,
  type PositionGroup,
  type WyEvent,
  type WyMatch,
} from './stats.js';
import { rng, syntheticInjuries, syntheticPlayers } from './synthetic.js';

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const RAW = join(ROOT, 'data', 'raw');
const TARGET_PLAYERS = 5000;
const LEAGUES = ['England', 'France', 'Germany', 'Italy', 'Spain'];
export const CLUB_ID = '00000000-0000-4000-8000-000000000001';

// figshare collection 4415000, CC BY 4.0. Checksums pin the exact files this seed was written for.
const FILES = [
  ['players.json', 'https://ndownloader.figshare.com/files/15073721', '877a111cb1005b73df5645e9338bd74fb4b496bace2fbc545a72abb3b73efa2e'],
  ['teams.json', 'https://ndownloader.figshare.com/files/15073697', '9f7a4a3b3d92c0be33f40613ad6e6eb4316c3b9771ec74c61a22c9b8ece23a4d'],
  ['matches.zip', 'https://ndownloader.figshare.com/files/14464622', 'c8f92bb7533e5c127e043cee764c991b5c25b4f5e70a65be931baae0b1765ce9'],
  ['events.zip', 'https://ndownloader.figshare.com/files/14464685', '877e015b716ffdeea18f04418e3f24fed307ed03c37ff305cabe1f47c4822a45'],
] as const;

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // env injected directly
}
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
};

const log = (msg: string) => console.log(`[seed] ${msg}`);
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function download() {
  for (const [name, url, checksum] of FILES) {
    const path = join(RAW, name);
    if (!existsSync(path)) {
      log(`downloading ${name}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
    if (sha256(readFileSync(path)) !== checksum) throw new Error(`${name}: checksum mismatch, delete it and re-run`);
    if (name.endsWith('.zip')) unzip(path);
  }
}

function unzip(path: string) {
  const first = path.endsWith('events.zip') ? 'events_England.json' : 'matches_England.json';
  if (existsSync(join(RAW, first))) return;
  log(`extracting ${path}`);
  // Windows ships bsdtar (reads zip); elsewhere use unzip
  if (process.platform === 'win32') execFileSync('C:\\Windows\\System32\\tar.exe', ['-xf', path, '-C', RAW]);
  else execFileSync('unzip', ['-oq', path, '-d', RAW]);
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(RAW, name), 'utf8')) as T;

// players.json and teams.json escape non-ASCII twice, so after JSON.parse names still read "Ag\\u00fcero"
const unescape = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

type WyPlayer = {
  wyId: number;
  firstName: string;
  lastName: string;
  shortName: string;
  birthDate: string | null;
  height: number;
  foot: string;
  role: { name: string; code3: string };
  passportArea?: { name: string };
};

// Must match apps/api/src/auth/password.ts so seeded users can log in.
async function hashPassword(password: string) {
  const params = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
  const nonce = randomBytes(16);
  const tag = await promisify(argon2)('argon2id', { message: password, nonce, ...params });
  return ['argon2id', params.memory, params.passes, params.parallelism, nonce.toString('base64'), tag.toString('base64')].join('$');
}

// One round-trip per batch: rows travel as a JSON array, Postgres unpacks them.
async function insertJson(db: pg.Client, sql: string, rows: unknown[], batch = 1000) {
  for (let i = 0; i < rows.length; i += batch) await db.query(sql, [JSON.stringify(rows.slice(i, i + batch))]);
}

const vectorLiteral = (v: number[]) => `[${v.join(',')}]`;

async function main() {
  const seedPassword = env('SEED_PASSWORD');
  if (seedPassword.length < 12) throw new Error('SEED_PASSWORD must be at least 12 characters');

  await download();

  log('computing minutes and per-90');
  const matches = LEAGUES.flatMap((l) => readJson<WyMatch[]>(`matches_${l}.json`));
  const played = minutesPlayed(matches);
  const counts = new Map<number, Counts>();
  for (const league of LEAGUES) countEvents(readJson<WyEvent[]>(`events_${league}.json`), counts);

  const players = readJson<WyPlayer[]>('players.json');
  const teams = new Map(readJson<{ wyId: number; name: string }[]>('teams.json').map((t) => [t.wyId, unescape(t.name)]));

  const real = players.map((p) => {
    const group = groupByRole[p.role.name] ?? 'mid';
    const play = played.get(p.wyId);
    const minutes = play?.minutes ?? 0;
    const c = counts.get(p.wyId);
    const team = play ? mainTeam(play) : undefined;
    return {
      p,
      group,
      minutes,
      counts: c,
      per90: c && minutes >= MIN_MINUTES ? per90(c, minutes) : null,
      team: team ? teams.get(team) ?? null : null,
    };
  });

  const realByGroup = new Map<PositionGroup, Per90[]>();
  for (const r of real) if (r.per90) realByGroup.set(r.group, [...(realByGroup.get(r.group) ?? []), r.per90]);
  // stats from real players only, so synthetic rows never shift what "average" means
  const stats = new Map<PositionGroup, GroupStats>([...realByGroup].map(([g, rows]) => [g, groupStats(rows)]));

  const random = rng(Number(process.argv.find((a) => a.startsWith('--seed='))?.slice(7) ?? 42));
  const synthetic = syntheticPlayers(Math.max(0, TARGET_PLAYERS - players.length), realByGroup, random);

  const db = new pg.Client({ connectionString: env('MIGRATION_DATABASE_URL') });
  await db.connect();
  try {
    await db.query('BEGIN');

    await db.query(`INSERT INTO core.clubs (id, name) VALUES ($1, 'Touchline FC') ON CONFLICT (id) DO NOTHING`, [CLUB_ID]);

    const passwordHash = await hashPassword(seedPassword);
    const roles = ['sporting_director', 'head_recruitment', 'scout', 'analyst', 'doctor', 'head_coach', 'admin'];
    await insertJson(
      db,
      `INSERT INTO core.users (club_id, email, password_hash, user_role)
       SELECT '${CLUB_ID}', x.email, x.hash, x.role::core.user_role FROM json_to_recordset($1::json) AS x(email text, hash text, role text)
       ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, user_role = EXCLUDED.user_role,
         is_active = true, failed_logins = 0, locked_until = NULL, updated_at = now()`,
      roles.map((role) => ({ email: `${role}@touchline.local`, hash: passwordHash, role })),
    );

    await db.query(
      `INSERT INTO core.player_roles (name, position_group)
       VALUES ('Goalkeeper','gk'), ('Defender','def'), ('Midfielder','mid'), ('Forward','fwd')
       ON CONFLICT (name) DO NOTHING`,
    );

    // stable ids across re-runs: reuse the player id already mapped to (source, source_id)
    const existing = new Map(
      (await db.query<{ key: string; player_id: string }>(
        `SELECT source || ':' || source_id AS key, player_id FROM core.player_external_ids WHERE source IN ('wyscout','synthetic')`,
      )).rows.map((r) => [r.key, r.player_id]),
    );
    const idFor = (key: string) => existing.get(key) ?? randomUUID();

    type Row = {
      id: string; source: string; source_id: string; full_name: string; dob: string | null; foot: string | null;
      height_cm: number | null; nationality: string | null; current_team: string | null; position: string;
      group: PositionGroup; synthetic: boolean; minutes: number; metrics: unknown; per90: Per90 | null;
    };

    const rows: Row[] = [
      ...real.map((r) => ({
        id: idFor(`wyscout:${r.p.wyId}`),
        source: 'wyscout',
        source_id: String(r.p.wyId),
        full_name: unescape(`${r.p.firstName.trim()} ${r.p.lastName.trim()}`.trim() || r.p.shortName),
        dob: r.p.birthDate || null,
        foot: r.p.foot || null,
        height_cm: r.p.height || null,
        nationality: r.p.passportArea ? unescape(r.p.passportArea.name) : null,
        current_team: r.team,
        position: r.p.role.code3,
        group: r.group,
        synthetic: false,
        minutes: r.minutes,
        metrics: r.counts ? { ...r.counts, minutes: r.minutes } : null,
        per90: r.per90,
      })),
      ...synthetic.map((s) => ({
        id: idFor(`synthetic:${s.sourceId}`),
        source: 'synthetic',
        source_id: s.sourceId,
        full_name: s.fullName,
        dob: s.dob,
        foot: s.foot,
        height_cm: s.heightCm,
        nationality: null,
        current_team: 'Demo XI',
        position: { gk: 'GKP', def: 'DEF', mid: 'MID', fwd: 'FWD' }[s.group],
        group: s.group,
        synthetic: true,
        minutes: s.minutes,
        metrics: { minutes: s.minutes },
        per90: s.per90,
      })),
    ];

    log(`writing ${rows.length} players (${synthetic.length} synthetic)`);
    await insertJson(
      db,
      `INSERT INTO core.players (id, club_id, full_name, dob, foot, height_cm, nationality, current_team,
                                 primary_position, primary_position_group, is_synthetic)
       SELECT x.id, '${CLUB_ID}', x.full_name, x.dob, x.foot, x.height_cm, x.nationality, x.current_team, x.position, x."group", x.synthetic
       FROM json_to_recordset($1::json) AS x(id uuid, full_name text, dob date, foot text, height_cm int, nationality text,
                                             current_team text, position text, "group" text, synthetic boolean)
       ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, dob = EXCLUDED.dob, foot = EXCLUDED.foot,
         height_cm = EXCLUDED.height_cm, nationality = EXCLUDED.nationality, current_team = EXCLUDED.current_team,
         primary_position = EXCLUDED.primary_position, primary_position_group = EXCLUDED.primary_position_group,
         is_synthetic = EXCLUDED.is_synthetic, updated_at = now()`,
      rows,
    );
    await insertJson(
      db,
      `INSERT INTO core.player_external_ids (player_id, source, source_id)
       SELECT x.id, x.source, x.source_id FROM json_to_recordset($1::json) AS x(id uuid, source text, source_id text)
       ON CONFLICT (source, source_id) DO NOTHING`,
      rows,
    );

    const played_ = rows.filter((r) => r.minutes > 0);
    await insertJson(
      db,
      `INSERT INTO core.player_season_stats (player_id, season, minutes, metrics, per90)
       SELECT x.id, '${SEASON}', x.minutes, coalesce(x.metrics, '{}'::jsonb), x.per90
       FROM json_to_recordset($1::json) AS x(id uuid, minutes int, metrics jsonb, per90 jsonb)
       ON CONFLICT (player_id, season) DO UPDATE SET minutes = EXCLUDED.minutes, metrics = EXCLUDED.metrics,
         per90 = EXCLUDED.per90, updated_at = now()`,
      played_,
    );

    const embedded = rows
      .filter((r) => r.per90)
      .map((r) => {
        const z = zScores(r.per90!, stats.get(r.group)!);
        return { id: r.id, embedding: vectorLiteral(embedding(z)), z_scores: z };
      });
    log(`writing ${embedded.length} embeddings (${MODEL_VERSION})`);
    // older model versions of the same season are replaced, so the API never mixes vector spaces
    await db.query(`DELETE FROM core.player_embeddings WHERE season = $1 AND model_version <> $2`, [SEASON, MODEL_VERSION]);
    await insertJson(
      db,
      `INSERT INTO core.player_embeddings (player_id, season, model_version, embedding, z_scores)
       SELECT x.id, '${SEASON}', '${MODEL_VERSION}', x.embedding::vector, x.z_scores
       FROM json_to_recordset($1::json) AS x(id uuid, embedding text, z_scores jsonb)
       ON CONFLICT (player_id, season, model_version) DO UPDATE SET embedding = EXCLUDED.embedding, z_scores = EXCLUDED.z_scores`,
      embedded,
    );

    // Medical: real players only ever get "fit"; injuries and other statuses go to synthetic players.
    const doctorId = (await db.query<{ id: string }>(`SELECT id FROM core.users WHERE email = 'doctor@touchline.local'`)).rows[0]!.id;
    const syntheticIds = rows.filter((r) => r.synthetic).map((r) => r.id);
    await db.query(`DELETE FROM medical.injuries WHERE player_id = ANY($1::uuid[])`, [syntheticIds]);
    await insertJson(
      db,
      `INSERT INTO medical.injuries (club_id, player_id, injured_on, activity, body_region, side, osiics_code,
                                     severity_days, severity_class, expected_return, actual_return)
       SELECT '${CLUB_ID}', x.player_id, x.injured_on, x.activity::medical.injury_activity, x.body_region, x.side, x.osiics_code,
              x.severity_days, x.severity_class::medical.severity_class, x.expected_return, x.actual_return
       FROM json_to_recordset($1::json) AS x(player_id uuid, injured_on date, activity text, body_region text, side text,
              osiics_code text, severity_days int, severity_class text, expected_return date, actual_return date)`,
      syntheticIds.flatMap((player_id) =>
        syntheticInjuries(random).map((i) => ({
          player_id,
          injured_on: i.injuredOn,
          activity: i.activity,
          body_region: i.bodyRegion,
          side: i.side,
          osiics_code: i.osiicsCode,
          severity_days: i.severityDays,
          severity_class: i.severityClass,
          expected_return: i.expectedReturn,
          actual_return: i.actualReturn,
        })),
      ),
    );
    await insertJson(
      db,
      `INSERT INTO medical.availability_status (player_id, status, public_note, updated_by)
       SELECT x.id, x.status::medical.availability, x.note, '${doctorId}' FROM json_to_recordset($1::json) AS x(id uuid, status text, note text)
       ON CONFLICT (player_id) DO UPDATE SET status = EXCLUDED.status, public_note = EXCLUDED.public_note, updated_at = now()`,
      rows.map((r) => {
        const status = r.synthetic ? random.weighted([['fit', 85], ['modified', 10], ['out', 5]] as const) : 'fit';
        return { id: r.id, status, note: status === 'fit' ? null : 'Dữ liệu giả lập' };
      }),
    );

    await db.query('COMMIT');

    const summary = await db.query(`
      SELECT (SELECT count(*) FROM core.players) AS players,
             (SELECT count(*) FROM core.players WHERE is_synthetic) AS synthetic,
             (SELECT count(*) FROM core.player_embeddings) AS embeddings,
             (SELECT count(*) FROM medical.injuries) AS injuries,
             (SELECT count(*) FROM core.users WHERE email LIKE '%@touchline.local') AS demo_users`);
    log(`done ${JSON.stringify(summary.rows[0])}`);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    await db.end();
  }
}

await main();
