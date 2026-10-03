# Touchline: System Design

Companion to the product/tech spec (Claude Doc "Touchline: Đặc tả kỹ thuật cho dev"). The spec says *what*; this says *why this shape*, where it breaks, and what to revisit.

## 1. Requirements

**Functional (core):** needs → shortlist → scout reports → mandatory medical gate → decision; similar-player search; scout mobile app with offline drafts.

**Non-functional (the ones that drive design):**

| Concern | Target | Driver |
|---|---|---|
| Medical data confidentiality | Only `doctor` reads diagnoses; 100% of reads audited | Core product promise |
| Gate integrity | No `approved` without valid clearance, even under concurrency or direct DB writes | Core product promise |
| Latency | `/players` p95 < 300 ms, `/similar` p95 < 500 ms @ 5k players | Spec G3 |
| Offline | Drafts survive app kill; resend never duplicates | Scouts work in stadiums |
| Cost / ops | One person builds and runs it | Solo constraint |

**Constraints:** solo dev, single club, demo-grade data (open datasets + synthetic medical).

## 2. Load estimate

Tiny. ~30 users, peak a few req/s, 5k players, ~15k player-season embeddings × 32 float4 ≈ 2 MB of vectors. One API instance and one Postgres handle this with large headroom. **Scale is not a design driver; correctness and security are.** Do not add queues, caches, or replicas to look "scalable".

## 3. High-level design

```
 Web (React/Vite)      Mobile (Expo)
        \                 /
         \   HTTPS/JSON  /
          v              v
        NestJS API (modular monolith)
        guards -> controllers -> services -> repositories
          |                      |
          v                      v
   PostgreSQL 16 + pgvector     Redis
   core | recruitment |         rate limit counters,
   medical (RLS) | audit        is_active cache (30s)

 tools/seed (Python, offline) --writes directly--> PostgreSQL
 packages/shared (Zod schemas) <-- imported by API, web, mobile
```

Single deployable API. Postgres is the only system of record; Redis holds disposable state only (losing it must never lose data or weaken a security check beyond a 30 s cache).

## 4. Key flows

**Stage transition to `approved` (the invariant):**

1. Guard: role allowed for this edge (`sporting_director`).
2. Service opens a transaction, sets `app.user_role` via `set_config(..., true)`.
3. `SELECT ... FOR UPDATE` on the shortlist entry (serialises concurrent moves).
4. Read latest clearance through a `SECURITY DEFINER` function/view (RLS would hide the table from this role).
5. Check TTL and later-injury invalidation; else `409 MEDICAL_GATE_REQUIRED`, nothing written.
6. Update stage + append `stage_history` in the same transaction.
7. DB trigger re-checks the clearance as a backstop for any non-API write path.

**Medical read:** guard (`doctor`) → RLS on `medical.*` → audit interceptor writes a row; if the audit write fails the request fails (fail closed, 500, no data).

**Offline report:** draft in SQLite → `queued` → POST with `Idempotency-Key = client_id` → server stores key with the report, so a retry returns the original result.

## 5. Decisions and trade-offs

| Decision | Chosen | Alternatives | Trade-off accepted |
|---|---|---|---|
| Architecture | Modular monolith | Microservices | Single failure domain, but one person can run it; module boundaries keep a later split possible |
| Datastore | Postgres only (+pgvector) | Separate vector DB, Mongo | Vector search is ~15k rows: a second system is pure cost. Revisit past ~1M vectors |
| Authorization | Guard + RLS + audit (defence in depth) | Guard only | More SQL and a tricky `SECURITY DEFINER` surface, in exchange for surviving an app-layer bug |
| Auth | JWT 15 min + rotating refresh, `is_active` check via Redis 30 s | Server sessions | Statelessness vs a 30 s revocation lag; a hard 0 s needs a DB hit per request |
| Medical field protection | RLS + AES-256-GCM on `soap` | RLS only | Key management burden; key lives in env, rotate by re-encrypting |
| ORM | Prisma + raw SQL migrations | TypeORM, Kysely | Prisma cannot express RLS/HNSW/schema-scoped enums, so two sources of truth for schema; mitigated by treating raw SQL as authoritative |
| Similar search | HNSW if benchmark demands, else exact scan | Always HNSW | At 15k rows exact scan is likely fast enough and returns exact results; HNSW adds recall tuning |
| Shared contract | Zod in `packages/shared` | OpenAPI-first codegen | Couples all clients to TS; fine for one team |
| Module format | ESM everywhere | CJS | Required by NestJS 12; needs `.js` import suffixes |

## 6. Failure modes

| Failure | Behaviour | Mitigation |
|---|---|---|
| Audit write fails | Medical request returns 500, no data | Fail closed by design; alert on 5xx rate for `/medical/*` |
| Redis down | Rate limit and `is_active` cache unavailable | Fail open for rate limit, fall back to DB for `is_active`; never block auth on Redis |
| App DB role gets `BYPASSRLS`/owner | RLS silently off | CI test connects as `touchline_app`, asserts 0 rows and no `BYPASSRLS` |
| Concurrent stage moves | One wins, other 409 | `FOR UPDATE` row lock + test |
| Mobile retries after lost response | No duplicate report | Idempotency key stored unique |
| Seed re-run | No duplicates | Upsert on `(source, source_id)` |
| HNSW returns fewer than N rows under tight filters | Short result | Raise `ef_search`, else exact scan |

## 7. Security notes

- Deny by default: endpoint without declared roles returns 403.
- `SECURITY DEFINER` functions: fixed `search_path`, owned by a non-app role, minimal return columns.
- Logs never contain passwords, tokens, or medical content; audit stores who/what/when only.
- TLS and `helmet` on staging; secrets in env, `.env.example` only in git.

## 8. Observability

Minimum: `/health`, structured logs (pino) with `request_id`, a counter for 403/409/5xx per route. Add DB slow-query logging before adding tracing.

## 9. Revisit when

| Signal | Revisit |
|---|---|
| More than one club | Multi-tenancy: `club_id` is already on every table; add RLS by club and a tenant claim in JWT |
| Vectors > ~1M or `/similar` p95 > target | HNSW tuning, then a dedicated vector index/service |
| Need instant revocation | Per-request DB check or token denylist |
| Real clinical data | Key management (KMS), retention policy, legal review; today everything is synthetic |
| Team > 1 | Split modules into packages with enforced boundaries, add contract tests |
| Offline needs conflict handling | Two-way sync (Phase 2); current one-way queue assumes only the author edits a draft |
