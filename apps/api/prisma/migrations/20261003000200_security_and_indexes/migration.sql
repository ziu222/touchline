-- Things Prisma cannot express: raw indexes, CHECKs, RLS, gate trigger, append-only guards, grants.
-- Runtime role: touchline_app (created by docker/initdb locally, by ops elsewhere). Must stay
-- non-owner, NOSUPERUSER, NOBYPASSRLS, otherwise RLS is silently skipped.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'touchline_app') THEN
    CREATE ROLE touchline_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ───────── indexes ─────────
CREATE UNIQUE INDEX users_email_lower_key ON core.users (lower(email));
CREATE INDEX players_full_name_trgm ON core.players USING gin (lower(full_name) gin_trgm_ops);
CREATE INDEX player_season_stats_per90_gin ON core.player_season_stats USING gin (per90);
-- approximate; the similar-player query falls back to exact scan if recall is short (spec mục 6)
CREATE INDEX player_embeddings_hnsw ON core.player_embeddings
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ───────── CHECKs ─────────
ALTER TABLE recruitment.recruitment_needs
  ADD CONSTRAINT needs_age_range CHECK (age_min <= age_max),
  ADD CONSTRAINT needs_fee_budget CHECK (fee_budget >= 0);
ALTER TABLE recruitment.scout_reports
  ADD CONSTRAINT reports_minutes_watched CHECK (minutes_watched > 0);
ALTER TABLE recruitment.report_attribute_scores
  ADD CONSTRAINT scores_range CHECK (score BETWEEN 0 AND 10);
ALTER TABLE medical.injuries
  ADD CONSTRAINT injuries_severity_days CHECK (severity_days >= 0);
ALTER TABLE core.player_season_stats
  ADD CONSTRAINT stats_minutes CHECK (minutes >= 0);
ALTER TABLE core.users
  ADD CONSTRAINT users_failed_logins CHECK (failed_logins >= 0);

-- ───────── append-only tables (blocks the owner too) ─────────
CREATE FUNCTION audit.forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_modification();
CREATE TRIGGER stage_history_append_only BEFORE UPDATE OR DELETE ON recruitment.stage_history
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_modification();

-- ───────── medical gate ─────────
-- SECURITY DEFINER so the check works for sporting_director although RLS hides medical tables.
-- Valid = latest clearance is cleared/conditional, inside TTL, and no injury recorded after it.
CREATE FUNCTION recruitment.has_valid_clearance(p_entry uuid, p_ttl_days int DEFAULT 30)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT c.result, c.at, e.player_id
      FROM medical.medical_clearances c
      JOIN recruitment.shortlist_entries e ON e.id = c.entry_id
      WHERE c.entry_id = p_entry
      ORDER BY c.at DESC
      LIMIT 1
    ) l
    WHERE l.result IN ('cleared', 'conditional')
      AND l.at > now() - make_interval(days => p_ttl_days)
      AND NOT EXISTS (
        SELECT 1 FROM medical.injuries i
        WHERE i.player_id = l.player_id AND i.created_at > l.at
      )
  )
$$;
REVOKE ALL ON FUNCTION recruitment.has_valid_clearance(uuid, int) FROM PUBLIC;

-- Backstop: even a direct write cannot reach approved without a valid clearance.
CREATE FUNCTION recruitment.enforce_medical_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ttl int := COALESCE(NULLIF(current_setting('app.clearance_ttl_days', true), '')::int, 30);
BEGIN
  IF NEW.stage = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.stage IS DISTINCT FROM 'approved')
     AND NOT recruitment.has_valid_clearance(NEW.id, ttl) THEN
    RAISE EXCEPTION 'MEDICAL_GATE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER shortlist_entries_medical_gate
  BEFORE INSERT OR UPDATE OF stage ON recruitment.shortlist_entries
  FOR EACH ROW EXECUTE FUNCTION recruitment.enforce_medical_gate();

-- ───────── RLS on medical ─────────
-- Policies read app.user_role, set per transaction by the API (set_config(..., true)).
ALTER TABLE medical.injuries            ENABLE ROW LEVEL SECURITY;
ALTER TABLE medical.medical_notes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE medical.availability_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE medical.medical_clearances  ENABLE ROW LEVEL SECURITY;

CREATE POLICY doctor_all ON medical.injuries FOR ALL TO touchline_app
  USING (current_setting('app.user_role', true) = 'doctor')
  WITH CHECK (current_setting('app.user_role', true) = 'doctor');

CREATE POLICY doctor_all ON medical.medical_notes FOR ALL TO touchline_app
  USING (current_setting('app.user_role', true) = 'doctor')
  WITH CHECK (current_setting('app.user_role', true) = 'doctor');

CREATE POLICY doctor_all ON medical.medical_clearances FOR ALL TO touchline_app
  USING (current_setting('app.user_role', true) = 'doctor')
  WITH CHECK (current_setting('app.user_role', true) = 'doctor');

CREATE POLICY readers_select ON medical.availability_status FOR SELECT TO touchline_app
  USING (current_setting('app.user_role', true)
         IN ('sporting_director', 'head_recruitment', 'analyst', 'doctor', 'head_coach'));
CREATE POLICY doctor_write ON medical.availability_status FOR INSERT TO touchline_app
  WITH CHECK (current_setting('app.user_role', true) = 'doctor');
CREATE POLICY doctor_update ON medical.availability_status FOR UPDATE TO touchline_app
  USING (current_setting('app.user_role', true) = 'doctor')
  WITH CHECK (current_setting('app.user_role', true) = 'doctor');

-- What SD and HoR may see of a clearance: result and doctor, never the note.
-- Owned by the migration role, so it reads through RLS; its own WHERE re-applies the role rule.
CREATE VIEW recruitment.clearance_summary WITH (security_barrier = true) AS
  SELECT id, entry_id, doctor_id, result, at
  FROM medical.medical_clearances
  WHERE current_setting('app.user_role', true)
        IN ('sporting_director', 'head_recruitment', 'doctor');

-- ───────── grants (explicit per table: no default privileges, so a new table starts closed) ─────────
GRANT USAGE ON SCHEMA core, recruitment, medical, audit TO touchline_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.clubs, core.users, core.refresh_tokens, core.player_roles, core.players,
  core.player_external_ids, core.player_season_stats, core.player_embeddings,
  recruitment.recruitment_needs, recruitment.shortlist_entries, recruitment.scout_assignments,
  recruitment.rubrics, recruitment.scout_reports, recruitment.report_attribute_scores,
  recruitment.comments, recruitment.committee_votes,
  medical.injuries, medical.medical_notes, medical.availability_status, medical.medical_clearances
TO touchline_app;

GRANT SELECT, INSERT ON recruitment.stage_history, audit.audit_log TO touchline_app;
GRANT SELECT ON recruitment.clearance_summary TO touchline_app;
GRANT EXECUTE ON FUNCTION recruitment.has_valid_clearance(uuid, int) TO touchline_app;
