-- SCRUM-591 (the internal assistant, test night 2026-10-21, S10) — small talk on the ask row.
--
-- A social message ("thank you") needs no Good/Wrong under its answer. The
-- model says so in its answer (`smallTalk`), the engine keeps the word on the
-- row, and the launcher hides the feedback buttons on it. Expand-only: one
-- boolean column with a default, so every row written before it reads false
-- and the deployed release keeps writing rows without it.
--
-- TO REVERSE: ALTER TABLE "assistant"."ask" DROP COLUMN "small_talk";
ALTER TABLE "assistant"."ask" ADD COLUMN "small_talk" boolean DEFAULT false NOT NULL;
