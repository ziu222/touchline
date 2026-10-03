// Synthetic players (only to reach 5,000 for the benchmark) and synthetic medical data.
// Injuries are only ever attached to synthetic players, never to real ones.
import { FEATURES, type Per90, type PositionGroup } from './stats.js';

// mulberry32: tiny deterministic PRNG so `--seed 42` rebuilds the same data set
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
  const gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
  const weighted = <T>(items: readonly (readonly [T, number])[]) => {
    let r = next() * items.reduce((s, [, w]) => s + w, 0);
    for (const [item, w] of items) if ((r -= w) <= 0) return item;
    return items[items.length - 1]![0];
  };
  return { next, int, pick, gauss, weighted };
}
export type Rng = ReturnType<typeof rng>;

export type SyntheticPlayer = {
  sourceId: string;
  fullName: string;
  dob: string;
  foot: string;
  heightCm: number;
  group: PositionGroup;
  minutes: number;
  per90: Per90;
};

// Each synthetic player is a real player of the same group with every feature jittered by ~25%.
export function syntheticPlayers(count: number, realByGroup: Map<PositionGroup, Per90[]>, r: Rng): SyntheticPlayer[] {
  const groups = [...realByGroup.entries()].map(([g, rows]) => [g, rows.length] as const);
  return Array.from({ length: count }, (_, i) => {
    const group = r.weighted(groups);
    const base = r.pick(realByGroup.get(group)!);
    const per90 = Object.fromEntries(
      FEATURES.map((f) => {
        const v = Math.max(0, base[f] * (1 + 0.25 * r.gauss()));
        return [f, Math.round((f === 'pass_accuracy' ? Math.min(1, v) : v) * 1000) / 1000];
      }),
    ) as Per90;
    const n = String(i + 1).padStart(4, '0');
    return {
      sourceId: `syn-${n}`,
      fullName: `Demo Player ${n}`,
      dob: `${r.int(1985, 2001)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`,
      foot: r.weighted([['right', 70], ['left', 25], ['both', 5]] as const),
      heightCm: r.int(group === 'gk' ? 182 : 165, group === 'gk' ? 200 : 195),
      group,
      minutes: r.int(700, 3400),
      per90,
    };
  });
}

// Body-region shares loosely follow the UEFA Elite Club Injury Study (hamstring ~24%).
// Codes are a small OSIICS-style reference made up for the demo, not the full OSIICS list.
const REGIONS = [
  ['hamstring', 'TMH', 24],
  ['ankle', 'AJL', 13],
  ['knee', 'KJM', 12],
  ['groin', 'GMA', 10],
  ['calf', 'QMC', 8],
  ['quadriceps', 'TMQ', 8],
  ['foot', 'FJL', 5],
  ['hip', 'HJX', 5],
  ['lower back', 'LMX', 5],
  ['shoulder', 'SJL', 4],
  ['head', 'HNC', 3],
  ['other', 'ZZX', 3],
] as const;

// days per severity class: 1-3, 4-7, 8-28, 28+
type SeverityClass = '1-3' | '4-7' | '8-28' | '28+';
const SEVERITY: readonly (readonly [readonly [number, number, SeverityClass], number])[] = [
  [[1, 3, '1-3'], 20],
  [[4, 7, '4-7'], 30],
  [[8, 28, '8-28'], 35],
  [[29, 120, '28+'], 15],
] as const;

export type SyntheticInjury = {
  injuredOn: string;
  activity: 'match' | 'training';
  bodyRegion: string;
  side: string | null;
  osiicsCode: string;
  severityDays: number;
  severityClass: SeverityClass;
  expectedReturn: string;
  actualReturn: string;
};

const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

// Season 2017/18: Aug 2017 to May 2018. Probability of at least one injury per player is a knob.
export function syntheticInjuries(r: Rng, injuryRate = 0.35): SyntheticInjury[] {
  if (r.next() >= injuryRate) return [];
  return Array.from({ length: r.weighted([[1, 75], [2, 20], [3, 5]] as const) }, () => {
    const [region, code] = r.weighted(REGIONS.map(([name, c, w]) => [[name, c] as const, w] as const));
    const [min, max, severityClass] = r.weighted(SEVERITY);
    const severityDays = r.int(min, max);
    const injuredOn = addDays('2017-08-01', r.int(0, 290));
    const expectedReturn = addDays(injuredOn, severityDays);
    return {
      injuredOn,
      activity: r.next() < 0.5 ? 'match' : 'training',
      bodyRegion: region,
      side: ['head', 'lower back', 'other'].includes(region) ? null : r.pick(['left', 'right'] as const),
      osiicsCode: code,
      severityDays,
      severityClass,
      expectedReturn,
      actualReturn: addDays(expectedReturn, r.int(-2, 5)),
    };
  });
}
