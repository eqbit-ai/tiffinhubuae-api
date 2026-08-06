-- Onboarding state, additive only.
--
-- Hand-written with IF NOT EXISTS, like the migrations before it: this repo's
-- migration history has a duplicate that makes `prisma migrate dev` fail on the
-- shadow database, and the start script uses `prisma db push` anyway. The file
-- exists so that a deploy path running `prisma migrate deploy` produces the same
-- columns rather than silently leaving them off — without it, every existing
-- merchant would be handed a setup wizard for a kitchen they configured months
-- ago, because the gate reads a column that would not be there.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "onboarding_state"        JSONB;

-- Same rule as prisma/scripts/backfill-onboarding.ts, so a deploy that applies
-- migrations without running the script still exempts everyone who already had
-- an account. Only null rows are touched, so it is safe to re-run and cannot
-- overwrite a real completion timestamp.
UPDATE "User"
SET "onboarding_completed_at" = "created_at"
WHERE "onboarding_completed_at" IS NULL;
