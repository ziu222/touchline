// Pure computations over Wyscout data: minutes, event counts, per-90, embeddings.
// No I/O here, so stats.test.ts can check them on tiny fixtures.

export const SEASON = '2017/18';
export const MIN_MINUTES = 700;
export const EMBEDDING_DIM = 32;
export const MODEL_VERSION = 'z21-2017-18-v1';

export type PositionGroup = 'gk' | 'def' | 'mid' | 'fwd';
export const groupByRole: Record<string, PositionGroup> = {
  Goalkeeper: 'gk',
  Defender: 'def',
  Midfielder: 'mid',
  Forward: 'fwd',
};

type Substitution = { playerIn: number; playerOut: number; minute: number };
export type WyMatch = {
  teamsData: Record<
    string,
    { teamId: number; formation?: { lineup?: { playerId: number }[]; substitutions?: Substitution[] | 'null' } }
  >;
};
export type WyEvent = { playerId: number; eventId: number; subEventId: number | ''; tags: { id: number }[] };

export type Played = { minutes: number; minutesByTeam: Map<number, number> };

// ponytail: 90-minute model; ignores red cards and stoppage time (a few % off for some players)
export function minutesPlayed(matches: WyMatch[]): Map<number, Played> {
  const out = new Map<number, Played>();
  const add = (playerId: number, teamId: number, minutes: number) => {
    const p = out.get(playerId) ?? { minutes: 0, minutesByTeam: new Map() };
    p.minutes += minutes;
    p.minutesByTeam.set(teamId, (p.minutesByTeam.get(teamId) ?? 0) + minutes);
    out.set(playerId, p);
  };
  for (const match of matches) {
    for (const team of Object.values(match.teamsData)) {
      const subs = Array.isArray(team.formation?.substitutions) ? team.formation.substitutions : [];
      for (const { playerId } of team.formation?.lineup ?? []) {
        const off = subs.find((s) => s.playerOut === playerId);
        add(playerId, team.teamId, off ? off.minute : 90);
      }
      for (const s of subs) add(s.playerIn, team.teamId, Math.max(0, 90 - s.minute));
    }
  }
  return out;
}

const has = (e: WyEvent, tag: number) => e.tags.some((t) => t.id === tag);

// Counted per event. Event/sub-event/tag ids from Wyscout's eventid2name.csv and tags2name.csv.
export const COUNTERS = {
  passes: (e: WyEvent) => e.eventId === 8,
  accurate_passes: (e: WyEvent) => e.eventId === 8 && has(e, 1801),
  key_passes: (e: WyEvent) => e.eventId === 8 && has(e, 302),
  smart_passes: (e: WyEvent) => e.subEventId === 86,
  crosses: (e: WyEvent) => e.subEventId === 80,
  long_passes: (e: WyEvent) => e.subEventId === 83 || e.subEventId === 84,
  assists: (e: WyEvent) => has(e, 301),
  shots: (e: WyEvent) => e.eventId === 10 || e.subEventId === 33,
  shots_on_target: (e: WyEvent) => (e.eventId === 10 || e.subEventId === 33) && has(e, 1801),
  goals: (e: WyEvent) => has(e, 101) && !has(e, 102) && (e.eventId === 10 || e.subEventId === 33 || e.subEventId === 35),
  dribbles: (e: WyEvent) => e.subEventId === 11,
  dribbles_won: (e: WyEvent) => e.subEventId === 11 && has(e, 703),
  defensive_duels: (e: WyEvent) => e.subEventId === 12,
  defensive_duels_won: (e: WyEvent) => e.subEventId === 12 && has(e, 703),
  aerial_duels: (e: WyEvent) => e.subEventId === 10,
  aerial_duels_won: (e: WyEvent) => e.subEventId === 10 && has(e, 703),
  interceptions: (e: WyEvent) => has(e, 1401),
  clearances: (e: WyEvent) => e.subEventId === 71,
  fouls: (e: WyEvent) => e.eventId === 2,
  accelerations: (e: WyEvent) => e.subEventId === 70,
  saves: (e: WyEvent) => e.eventId === 9 && has(e, 1801),
} as const;

export type Counter = keyof typeof COUNTERS;
export const COUNTER_NAMES = Object.keys(COUNTERS) as Counter[];
export type Counts = Record<Counter, number>;

const zeroCounts = (): Counts => Object.fromEntries(COUNTER_NAMES.map((k) => [k, 0])) as Counts;

export function countEvents(events: Iterable<WyEvent>, into = new Map<number, Counts>()): Map<number, Counts> {
  for (const e of events) {
    if (!e.playerId) continue;
    const c = into.get(e.playerId) ?? zeroCounts();
    for (const name of COUNTER_NAMES) if (COUNTERS[name](e)) c[name]++;
    into.set(e.playerId, c);
  }
  return into;
}

// per-90 counts plus pass accuracy (a ratio, kept on the same feature list for the embedding)
export const FEATURES = [...COUNTER_NAMES, 'pass_accuracy'] as const;
export type Feature = (typeof FEATURES)[number];
export type Per90 = Record<Feature, number>;

export function per90(c: Counts, minutes: number): Per90 {
  const out = Object.fromEntries(COUNTER_NAMES.map((k) => [k, round((c[k] * 90) / minutes)])) as Per90;
  out.pass_accuracy = c.passes ? round(c.accurate_passes / c.passes) : 0;
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export type GroupStats = Record<Feature, { mean: number; std: number }>;

export function groupStats(rows: Per90[]): GroupStats {
  const stats = {} as GroupStats;
  for (const f of FEATURES) {
    const xs = rows.map((r) => r[f]);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    stats[f] = { mean, std };
  }
  return stats;
}

export function zScores(p: Per90, stats: GroupStats): Per90 {
  return Object.fromEntries(
    FEATURES.map((f) => [f, stats[f].std ? round((p[f] - stats[f].mean) / stats[f].std) : 0]),
  ) as Per90;
}

// z-scores within the position group, zero-padded to vector(32), L2-normalised for cosine search.
// PCA skipped: 21 features is already small and z-scores stay explainable (shared_strengths).
export function embedding(z: Per90): number[] {
  const v = FEATURES.map((f) => z[f]);
  while (v.length < EMBEDDING_DIM) v.push(0);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => round(x / norm));
}

export function mainTeam(p: Played): number | undefined {
  let best: number | undefined;
  let bestMinutes = -1;
  for (const [team, m] of p.minutesByTeam) if (m > bestMinutes) [best, bestMinutes] = [team, m];
  return best;
}
