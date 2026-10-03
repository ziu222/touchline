import { z } from 'zod';

export const userRoles = [
  'sporting_director',
  'head_recruitment',
  'scout',
  'analyst',
  'doctor',
  'head_coach',
  'admin',
] as const;
export const UserRole = z.enum(userRoles);
export type UserRole = z.infer<typeof UserRole>;

// emails are stored lowercase; the unique index is on lower(email)
const Email = z.string().trim().toLowerCase().pipe(z.email());

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const RefreshRequest = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export type AuthTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export const Pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type Pagination = z.infer<typeof Pagination>;

export type Page<T> = { data: T[]; meta: { page: number; limit: number; total: number } };

export const CreateUserRequest = z.object({
  email: Email,
  password: z.string().min(12).max(256),
  role: UserRole,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UpdateUserRequest = z
  .object({ role: UserRole.optional(), is_active: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.is_active !== undefined, 'Nothing to update');
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export type UserDto = {
  id: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  locked_until: string | null;
  created_at: string;
};

// ───────── players ─────────

export const positionGroups = ['gk', 'def', 'mid', 'fwd'] as const;
export type PositionGroup = (typeof positionGroups)[number];

// Order matters: it is the order of the embedding dimensions written by tools/seed.
export const per90Features = [
  'passes',
  'accurate_passes',
  'key_passes',
  'smart_passes',
  'crosses',
  'long_passes',
  'assists',
  'shots',
  'shots_on_target',
  'goals',
  'dribbles',
  'dribbles_won',
  'defensive_duels',
  'defensive_duels_won',
  'aerial_duels',
  'aerial_duels_won',
  'interceptions',
  'clearances',
  'fouls',
  'accelerations',
  'saves',
  'pass_accuracy',
] as const;
export type Per90Feature = (typeof per90Features)[number];

const Season = z.string().regex(/^\d{4}\/\d{2}$/, 'Season looks like 2017/18');
const Age = z.coerce.number().int().min(14).max(50);
const ageRangeOk = (v: { min_age?: number; max_age?: number }) =>
  v.min_age === undefined || v.max_age === undefined || v.min_age <= v.max_age;

// min_<feature>=x keeps only players at or above x per 90 (pass_accuracy is a 0..1 ratio)
const per90Minimums = Object.fromEntries(
  per90Features.map((f) => [`min_${f}`, z.coerce.number().min(0).optional()]),
) as Record<`min_${Per90Feature}`, z.ZodOptional<z.ZodCoercedNumber>>;

export const PlayerQuery = Pagination.extend({
  q: z.string().trim().min(2).max(100).optional(),
  position_group: z.enum(positionGroups).optional(),
  season: Season.optional(),
  min_age: Age.optional(),
  max_age: Age.optional(),
  min_minutes: z.coerce.number().int().min(0).optional(),
  include_synthetic: z.stringbool().default(false),
  sort: z.enum(['minutes', 'full_name', 'age', ...per90Features]).default('minutes'),
  order: z.enum(['asc', 'desc']).default('desc'),
  ...per90Minimums,
}).refine(ageRangeOk, 'min_age must be <= max_age');
export type PlayerQuery = z.infer<typeof PlayerQuery>;

export const SimilarQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(10),
    season: Season.optional(),
    min_age: Age.optional(),
    max_age: Age.optional(),
    min_minutes: z.coerce.number().int().min(0).default(700),
    include_synthetic: z.stringbool().default(false),
  })
  .refine(ageRangeOk, 'min_age must be <= max_age');
export type SimilarQuery = z.infer<typeof SimilarQuery>;

export type Availability = 'fit' | 'modified' | 'out';

export type PlayerSummary = {
  id: string;
  full_name: string;
  dob: string | null;
  // age at the middle of the stats season (data is historical)
  age: number | null;
  nationality: string | null;
  current_team: string | null;
  position: string | null;
  position_group: PositionGroup | null;
  foot: string | null;
  height_cm: number | null;
  is_synthetic: boolean;
  season: string;
  minutes: number;
  per90: Partial<Record<Per90Feature, number>> | null;
  // null when the caller's role may not see availability
  availability: Availability | null;
};

export type ReportSummary = {
  id: string;
  author_id: string;
  mode: 'live' | 'video';
  current_grade: string;
  potential_grade: string;
  action_rec: 'sign' | 'monitor' | 'reject';
  submitted_at: string | null;
};

export type PlayerProfile = Omit<PlayerSummary, 'season' | 'minutes' | 'per90' | 'availability'> & {
  seasons: { season: string; minutes: number; per90: Partial<Record<Per90Feature, number>> | null }[];
  availability: { status: Availability; expected_return: string | null; public_note: string | null } | null;
  reports: ReportSummary[];
};

export type SimilarPlayer = {
  player: { id: string; full_name: string; age: number | null; team: string | null; position: string | null };
  similarity: number;
  // up to 3 features where both players are at least 1 std above their position group
  shared_strengths: Per90Feature[];
  availability: Availability | null;
};

export type SimilarResponse = {
  data: SimilarPlayer[];
  meta: { model_version: string; season: string; mode: 'exact' };
};

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};
