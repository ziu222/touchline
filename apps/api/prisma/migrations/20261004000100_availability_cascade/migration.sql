-- Deleting a player removes its availability row. FK actions bypass RLS, so no role needs a
-- DELETE policy on medical data just to remove a player.
ALTER TABLE "medical"."availability_status" DROP CONSTRAINT "availability_status_player_id_fkey";
ALTER TABLE "medical"."availability_status" ADD CONSTRAINT "availability_status_player_id_fkey"
  FOREIGN KEY ("player_id") REFERENCES "core"."players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
