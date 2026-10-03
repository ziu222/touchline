import { Injectable } from '@nestjs/common';
import {
  per90Features,
  type Page,
  type Per90Feature,
  type PlayerProfile,
  type PlayerQuery,
  type PlayerSummary,
  type PositionGroup,
  type ReportSummary,
  type SimilarQuery,
  type SimilarResponse,
} from '@touchline/shared';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../errors.js';
import { PrismaService } from '../prisma.service.js';
import type { AuthUser } from '../auth/decorators.js';

type Per90 = Partial<Record<Per90Feature, number>>;

// Stats are historical, so ages are taken at the middle of the season (1 Jan of its second year).
const ageAt = (season: Prisma.Sql | string) =>
  Prisma.sql`date_part('year', age(make_date(left(${season}, 4)::int + 1, 1, 1), p.dob))::int`;

const notFound = () => new AppError(404, 'NOT_FOUND', 'Player not found');

// Who may see which players (spec mục 2). Scouts: assigned players only. Coach: players on a
// shortlist shared with the coach. Everyone else in the club: all players.
function visibleTo(user: AuthUser): Prisma.Sql {
  if (user.role === 'scout') {
    return Prisma.sql`AND EXISTS (SELECT 1 FROM recruitment.scout_assignments sa
                                  WHERE sa.player_id = p.id AND sa.scout_id = ${user.id}::uuid)`;
  }
  if (user.role === 'head_coach') {
    return Prisma.sql`AND EXISTS (SELECT 1 FROM recruitment.shortlist_entries se
                                  JOIN recruitment.recruitment_needs n ON n.id = se.need_id
                                  WHERE se.player_id = p.id AND n.shared_with_coach)`;
  }
  return Prisma.empty;
}

const and = (parts: Prisma.Sql[]) => (parts.length ? Prisma.join(parts, ' ') : Prisma.empty);

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type SummaryRow = {
  id: string;
  full_name: string;
  dob: Date | null;
  age: number | null;
  nationality: string | null;
  current_team: string | null;
  primary_position: string | null;
  primary_position_group: PositionGroup | null;
  foot: string | null;
  height_cm: number | null;
  is_synthetic: boolean;
  minutes: number | null;
  per90: Per90 | null;
  availability: PlayerSummary['availability'];
};

const isoDate = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

const toSummary = (r: SummaryRow, season: string): PlayerSummary => ({
  id: r.id,
  full_name: r.full_name,
  dob: isoDate(r.dob),
  age: r.age,
  nationality: r.nationality,
  current_team: r.current_team,
  position: r.primary_position,
  position_group: r.primary_position_group,
  foot: r.foot,
  height_cm: r.height_cm,
  is_synthetic: r.is_synthetic,
  season,
  minutes: r.minutes ?? 0,
  per90: r.per90,
  availability: r.availability,
});

// up to 3 features where both players sit at least 1 std above their group, strongest shared first
export function sharedStrengths(a: Per90 | null, b: Per90 | null): Per90Feature[] {
  if (!a || !b) return [];
  return per90Features
    .map((f) => ({ f, both: Math.min(a[f] ?? 0, b[f] ?? 0) }))
    .filter((x) => x.both >= 1)
    .sort((x, y) => y.both - x.both)
    .slice(0, 3)
    .map((x) => x.f);
}

@Injectable()
export class PlayersService {
  constructor(private readonly prisma: PrismaService) {}

  // Every query runs inside withRole, so availability (medical schema) follows RLS for the caller.
  list(user: AuthUser, q: PlayerQuery): Promise<Page<PlayerSummary>> {
    return this.prisma.withRole(user.role, async (tx) => {
      const season = q.season ?? (await this.latestSeason(tx));
      const filters: Prisma.Sql[] = [];
      if (q.q) filters.push(Prisma.sql`AND lower(p.full_name) LIKE ${`%${escapeLike(q.q.toLowerCase())}%`}`);
      if (q.position_group) filters.push(Prisma.sql`AND p.primary_position_group = ${q.position_group}`);
      if (!q.include_synthetic) filters.push(Prisma.sql`AND NOT p.is_synthetic`);
      if (q.min_age !== undefined) filters.push(Prisma.sql`AND ${ageAt(season)} >= ${q.min_age}`);
      if (q.max_age !== undefined) filters.push(Prisma.sql`AND ${ageAt(season)} <= ${q.max_age}`);
      if (q.min_minutes !== undefined) filters.push(Prisma.sql`AND s.minutes >= ${q.min_minutes}`);
      for (const f of per90Features) {
        const min = q[`min_${f}`];
        if (min !== undefined) filters.push(Prisma.sql`AND (s.per90 ->> ${f})::float8 >= ${min}`);
      }

      const from = Prisma.sql`
        FROM core.players p
        LEFT JOIN core.player_season_stats s ON s.player_id = p.id AND s.season = ${season}
        LEFT JOIN medical.availability_status a ON a.player_id = p.id
        WHERE p.club_id = ${user.clubId}::uuid ${visibleTo(user)} ${and(filters)}`;

      const sortExpr =
        q.sort === 'minutes' ? Prisma.sql`s.minutes`
        : q.sort === 'full_name' ? Prisma.sql`p.full_name`
        : q.sort === 'age' ? ageAt(season)
        : Prisma.sql`(s.per90 ->> ${q.sort})::float8`;
      const direction = Prisma.raw(q.order === 'asc' ? 'ASC' : 'DESC');

      const [{ total }] = await tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${from}`;
      const rows = await tx.$queryRaw<SummaryRow[]>`
        SELECT p.id, p.full_name, p.dob, ${ageAt(season)} AS age, p.nationality, p.current_team,
               p.primary_position, p.primary_position_group, p.foot, p.height_cm, p.is_synthetic,
               s.minutes, s.per90, a.status::text AS availability
        ${from}
        ORDER BY ${sortExpr} ${direction} NULLS LAST, p.id
        LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;

      return { data: rows.map((r) => toSummary(r, season)), meta: { page: q.page, limit: q.limit, total } };
    });
  }

  profile(user: AuthUser, id: string): Promise<PlayerProfile> {
    return this.prisma.withRole(user.role, async (tx) => {
      const season = await this.latestSeason(tx);
      const [player] = await tx.$queryRaw<SummaryRow[]>`
        SELECT p.id, p.full_name, p.dob, ${ageAt(season)} AS age, p.nationality, p.current_team,
               p.primary_position, p.primary_position_group, p.foot, p.height_cm, p.is_synthetic,
               NULL::int AS minutes, NULL::jsonb AS per90, NULL::text AS availability
        FROM core.players p
        WHERE p.id = ${id}::uuid AND p.club_id = ${user.clubId}::uuid ${visibleTo(user)}`;
      // same 404 whether the player does not exist or the caller may not know it does
      if (!player) throw notFound();

      const seasons = await tx.playerSeasonStat.findMany({
        where: { playerId: id },
        orderBy: { season: 'desc' },
        select: { season: true, minutes: true, per90: true },
      });
      // RLS returns nothing to roles that may not see availability
      const availability = await tx.availabilityStatus.findUnique({ where: { playerId: id } });

      // doctors have no business reading scouting; scouts only see their own reports
      const reports =
        user.role === 'doctor'
          ? []
          : await tx.scoutReport.findMany({
              where: { playerId: id, clubId: user.clubId, ...(user.role === 'scout' ? { authorId: user.id } : {}) },
              orderBy: { createdAt: 'desc' },
            });

      const { season: _s, minutes: _m, per90: _p, availability: _a, ...base } = toSummary(player, season);
      return {
        ...base,
        seasons: seasons.map((s) => ({ season: s.season, minutes: s.minutes, per90: s.per90 as Per90 | null })),
        availability: availability && {
          status: availability.status,
          expected_return: isoDate(availability.expectedReturn),
          public_note: availability.publicNote,
        },
        reports: reports.map(
          (r): ReportSummary => ({
            id: r.id,
            author_id: r.authorId,
            mode: r.mode,
            current_grade: r.currentGrade,
            potential_grade: r.potentialGrade,
            action_rec: r.actionRec,
            submitted_at: r.submittedAt?.toISOString() ?? null,
          }),
        ),
      };
    });
  }

  // Exact cosine scan, not the HNSW index: at ~3k vectors it measured 5 ms vs 7 ms and never
  // drops rows under tight filters. ponytail: switch to the index (with ef_search tuning)
  // when vectors reach ~100k or p95 nears the 500 ms target.
  similar(user: AuthUser, id: string, q: SimilarQuery): Promise<SimilarResponse> {
    return this.prisma.withRole(user.role, async (tx) => {
      const [target] = await tx.$queryRaw<
        { season: string | null; model_version: string | null; z_scores: Per90 | null }[]
      >`
        SELECT e.season, e.model_version, e.z_scores
        FROM core.players p
        LEFT JOIN core.player_embeddings e ON e.player_id = p.id ${q.season ? Prisma.sql`AND e.season = ${q.season}` : Prisma.empty}
        WHERE p.id = ${id}::uuid AND p.club_id = ${user.clubId}::uuid
        ORDER BY e.season DESC NULLS LAST, e.created_at DESC NULLS LAST
        LIMIT 1`;
      if (!target) throw notFound();
      if (!target.season || !target.model_version) {
        throw new AppError(422, 'INSUFFICIENT_DATA', 'Chưa đủ dữ liệu: cần từ 700 phút thi đấu trong mùa');
      }
      const { season, model_version } = target;

      const filters: Prisma.Sql[] = [];
      if (!q.include_synthetic) filters.push(Prisma.sql`AND NOT p.is_synthetic`);
      if (q.min_age !== undefined) filters.push(Prisma.sql`AND ${ageAt(season)} >= ${q.min_age}`);
      if (q.max_age !== undefined) filters.push(Prisma.sql`AND ${ageAt(season)} <= ${q.max_age}`);

      const rows = await tx.$queryRaw<
        {
          id: string;
          full_name: string;
          age: number | null;
          current_team: string | null;
          primary_position: string | null;
          z_scores: Per90 | null;
          availability: SimilarResponse['data'][number]['availability'];
          distance: number;
        }[]
      >`
        WITH t AS (
          SELECT e.embedding, p.primary_position_group AS grp
          FROM core.player_embeddings e JOIN core.players p ON p.id = e.player_id
          WHERE e.player_id = ${id}::uuid AND e.season = ${season} AND e.model_version = ${model_version}
        ),
        -- MATERIALIZED: distances are computed for every candidate, so the planner cannot
        -- swap in the approximate HNSW index and silently return fewer rows
        candidates AS MATERIALIZED (
          SELECT p.id, p.full_name, ${ageAt(season)} AS age, p.current_team, p.primary_position,
                 e.z_scores, a.status::text AS availability, e.embedding <=> t.embedding AS distance
          FROM t
          JOIN core.player_embeddings e ON e.season = ${season} AND e.model_version = ${model_version}
          JOIN core.players p ON p.id = e.player_id
          JOIN core.player_season_stats s ON s.player_id = p.id AND s.season = e.season
          LEFT JOIN medical.availability_status a ON a.player_id = p.id
          WHERE p.club_id = ${user.clubId}::uuid
            AND p.primary_position_group = t.grp
            AND p.id <> ${id}::uuid
            AND s.minutes >= ${q.min_minutes}
            ${and(filters)}
        )
        SELECT * FROM candidates ORDER BY distance, id LIMIT ${q.limit}`;

      return {
        data: rows.map((r) => ({
          player: { id: r.id, full_name: r.full_name, age: r.age, team: r.current_team, position: r.primary_position },
          similarity: Math.round((1 - r.distance) * 1000) / 1000,
          shared_strengths: sharedStrengths(target.z_scores, r.z_scores),
          availability: r.availability,
        })),
        meta: { model_version, season, mode: 'exact' },
      };
    });
  }

  private async latestSeason(tx: Prisma.TransactionClient): Promise<string> {
    const [row] = await tx.$queryRaw<{ season: string | null }[]>`SELECT max(season) AS season FROM core.player_season_stats`;
    return row?.season ?? '2017/18';
  }
}
