-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "medical";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "recruitment";

-- CreateEnum
CREATE TYPE "core"."user_role" AS ENUM ('sporting_director', 'head_recruitment', 'scout', 'analyst', 'doctor', 'head_coach', 'admin');

-- CreateEnum
CREATE TYPE "recruitment"."need_status" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "recruitment"."shortlist_stage" AS ENUM ('identified', 'screened', 'scouted', 'committee', 'medical', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "recruitment"."report_mode" AS ENUM ('live', 'video');

-- CreateEnum
CREATE TYPE "recruitment"."grade" AS ENUM ('A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "recruitment"."action_rec" AS ENUM ('sign', 'monitor', 'reject');

-- CreateEnum
CREATE TYPE "recruitment"."vote" AS ENUM ('agree', 'disagree', 'abstain');

-- CreateEnum
CREATE TYPE "medical"."injury_activity" AS ENUM ('match', 'training');

-- CreateEnum
CREATE TYPE "medical"."severity_class" AS ENUM ('1-3', '4-7', '8-28', '28+');

-- CreateEnum
CREATE TYPE "medical"."availability" AS ENUM ('fit', 'modified', 'out');

-- CreateEnum
CREATE TYPE "medical"."clearance_result" AS ENUM ('cleared', 'conditional', 'rejected');

-- CreateEnum
CREATE TYPE "audit"."audit_action" AS ENUM ('read', 'create', 'update', 'delete');

-- CreateTable
CREATE TABLE "core"."clubs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "user_role" "core"."user_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."player_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "position_group" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."players" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "dob" DATE,
    "foot" TEXT,
    "height_cm" INTEGER,
    "nationality" TEXT,
    "current_team" TEXT,
    "primary_position" TEXT,
    "primary_position_group" TEXT,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."player_external_ids" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "player_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_external_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."player_season_stats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "player_id" UUID NOT NULL,
    "season" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "metrics" JSONB NOT NULL,
    "per90" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_season_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."player_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "player_id" UUID NOT NULL,
    "season" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "embedding" vector(32) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."recruitment_needs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "age_min" INTEGER NOT NULL,
    "age_max" INTEGER NOT NULL,
    "fee_budget" DECIMAL(14,2) NOT NULL,
    "deadline" DATE NOT NULL,
    "status" "recruitment"."need_status" NOT NULL DEFAULT 'open',
    "shared_with_coach" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recruitment_needs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."shortlist_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "need_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "stage" "recruitment"."shortlist_stage" NOT NULL DEFAULT 'identified',
    "owner_id" UUID,
    "proposed_by" UUID,
    "pending_acceptance" BOOLEAN NOT NULL DEFAULT false,
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shortlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."stage_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entry_id" UUID NOT NULL,
    "from_stage" "recruitment"."shortlist_stage",
    "to_stage" "recruitment"."shortlist_stage" NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."scout_assignments" (
    "scout_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "due_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scout_assignments_pkey" PRIMARY KEY ("scout_id","player_id")
);

-- CreateTable
CREATE TABLE "recruitment"."rubrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "scale_type" TEXT NOT NULL DEFAULT 'A-D',
    "anchors" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rubrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."scout_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "client_id" UUID,
    "match_ref" TEXT,
    "mode" "recruitment"."report_mode" NOT NULL,
    "minutes_watched" INTEGER NOT NULL,
    "rubric_id" UUID NOT NULL,
    "rubric_version" INTEGER NOT NULL,
    "current_grade" "recruitment"."grade" NOT NULL,
    "potential_grade" "recruitment"."grade" NOT NULL,
    "action_rec" "recruitment"."action_rec" NOT NULL,
    "body" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scout_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."report_attribute_scores" (
    "report_id" UUID NOT NULL,
    "attribute" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "report_attribute_scores_pkey" PRIMARY KEY ("report_id","attribute")
);

-- CreateTable
CREATE TABLE "recruitment"."comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "mentions" UUID[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment"."committee_votes" (
    "entry_id" UUID NOT NULL,
    "voter_id" UUID NOT NULL,
    "vote" "recruitment"."vote" NOT NULL,
    "note" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "committee_votes_pkey" PRIMARY KEY ("entry_id","voter_id")
);

-- CreateTable
CREATE TABLE "medical"."injuries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "injured_on" DATE NOT NULL,
    "activity" "medical"."injury_activity" NOT NULL,
    "body_region" TEXT NOT NULL,
    "side" TEXT,
    "osiics_code" TEXT,
    "severity_days" INTEGER NOT NULL,
    "severity_class" "medical"."severity_class" NOT NULL,
    "recurrence_of" UUID,
    "expected_return" DATE,
    "actual_return" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "injuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical"."medical_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "injury_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "soap" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical"."availability_status" (
    "player_id" UUID NOT NULL,
    "status" "medical"."availability" NOT NULL,
    "public_note" TEXT,
    "expected_return" DATE,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_status_pkey" PRIMARY KEY ("player_id")
);

-- CreateTable
CREATE TABLE "medical"."medical_clearances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entry_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "result" "medical"."clearance_result" NOT NULL,
    "note" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_clearances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "action" "audit"."audit_action" NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID,
    "ip" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "core"."refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "core"."refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_roles_name_key" ON "core"."player_roles"("name");

-- CreateIndex
CREATE INDEX "players_primary_position_group_idx" ON "core"."players"("primary_position_group");

-- CreateIndex
CREATE INDEX "player_external_ids_player_id_idx" ON "core"."player_external_ids"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_external_ids_source_source_id_key" ON "core"."player_external_ids"("source", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_season_stats_player_id_season_key" ON "core"."player_season_stats"("player_id", "season");

-- CreateIndex
CREATE UNIQUE INDEX "player_embeddings_player_id_season_model_version_key" ON "core"."player_embeddings"("player_id", "season", "model_version");

-- CreateIndex
CREATE INDEX "recruitment_needs_status_idx" ON "recruitment"."recruitment_needs"("status");

-- CreateIndex
CREATE INDEX "shortlist_entries_stage_idx" ON "recruitment"."shortlist_entries"("stage");

-- CreateIndex
CREATE UNIQUE INDEX "shortlist_entries_need_id_player_id_key" ON "recruitment"."shortlist_entries"("need_id", "player_id");

-- CreateIndex
CREATE INDEX "stage_history_entry_id_at_idx" ON "recruitment"."stage_history"("entry_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "rubrics_role_id_version_key" ON "recruitment"."rubrics"("role_id", "version");

-- CreateIndex
CREATE INDEX "scout_reports_player_id_idx" ON "recruitment"."scout_reports"("player_id");

-- CreateIndex
CREATE INDEX "scout_reports_author_id_idx" ON "recruitment"."scout_reports"("author_id");

-- CreateIndex
CREATE UNIQUE INDEX "scout_reports_author_id_client_id_key" ON "recruitment"."scout_reports"("author_id", "client_id");

-- CreateIndex
CREATE INDEX "comments_entity_type_entity_id_idx" ON "recruitment"."comments"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "injuries_player_id_idx" ON "medical"."injuries"("player_id");

-- CreateIndex
CREATE INDEX "medical_clearances_entry_id_at_idx" ON "medical"."medical_clearances"("entry_id", "at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "audit"."audit_log"("actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit"."audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "core"."users" ADD CONSTRAINT "users_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "core"."clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."players" ADD CONSTRAINT "players_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "core"."clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."player_external_ids" ADD CONSTRAINT "player_external_ids_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."player_season_stats" ADD CONSTRAINT "player_season_stats_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."player_embeddings" ADD CONSTRAINT "player_embeddings_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."recruitment_needs" ADD CONSTRAINT "recruitment_needs_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "core"."clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."recruitment_needs" ADD CONSTRAINT "recruitment_needs_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "core"."player_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."recruitment_needs" ADD CONSTRAINT "recruitment_needs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "core"."clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "recruitment"."recruitment_needs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_proposed_by_fkey" FOREIGN KEY ("proposed_by") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."stage_history" ADD CONSTRAINT "stage_history_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "recruitment"."shortlist_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."stage_history" ADD CONSTRAINT "stage_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."scout_assignments" ADD CONSTRAINT "scout_assignments_scout_id_fkey" FOREIGN KEY ("scout_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."scout_assignments" ADD CONSTRAINT "scout_assignments_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."rubrics" ADD CONSTRAINT "rubrics_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "core"."player_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."scout_reports" ADD CONSTRAINT "scout_reports_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "core"."clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."scout_reports" ADD CONSTRAINT "scout_reports_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."scout_reports" ADD CONSTRAINT "scout_reports_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."scout_reports" ADD CONSTRAINT "scout_reports_rubric_id_fkey" FOREIGN KEY ("rubric_id") REFERENCES "recruitment"."rubrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."report_attribute_scores" ADD CONSTRAINT "report_attribute_scores_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "recruitment"."scout_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."comments" ADD CONSTRAINT "comments_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "core"."clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."committee_votes" ADD CONSTRAINT "committee_votes_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "recruitment"."shortlist_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment"."committee_votes" ADD CONSTRAINT "committee_votes_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."injuries" ADD CONSTRAINT "injuries_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "core"."clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."injuries" ADD CONSTRAINT "injuries_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."injuries" ADD CONSTRAINT "injuries_recurrence_of_fkey" FOREIGN KEY ("recurrence_of") REFERENCES "medical"."injuries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."medical_notes" ADD CONSTRAINT "medical_notes_injury_id_fkey" FOREIGN KEY ("injury_id") REFERENCES "medical"."injuries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."medical_notes" ADD CONSTRAINT "medical_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."availability_status" ADD CONSTRAINT "availability_status_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."availability_status" ADD CONSTRAINT "availability_status_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."medical_clearances" ADD CONSTRAINT "medical_clearances_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "recruitment"."shortlist_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical"."medical_clearances" ADD CONSTRAINT "medical_clearances_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

