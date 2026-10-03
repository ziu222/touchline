-- per-feature z-scores within the position group, written by tools/seed; explains a similarity match
ALTER TABLE "core"."player_embeddings" ADD COLUMN "z_scores" JSONB;
