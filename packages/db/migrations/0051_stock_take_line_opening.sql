-- S2-14b stock walkthrough fix round (F1) — each counted shelf keeps the
-- commit's own answer to "was this its place's opening?".
--
-- A place's opening is its first figure: the first count at a place where
-- nothing had been counted or moved before. The commit judges it under the
-- branch's count lock; the reports used to judge it again at read time from
-- the takes' commit stamps, and a stamp taken before the lock could put two
-- counts in a different order than they were committed — hiding a real
-- variance as an opening. The reports now read this column. NULL on every
-- line written before this migration: those are still judged at read time,
-- from the counts and movements that came before them. Nothing is rewritten.
--
-- Undo: ALTER TABLE "pos"."stock_take_line" DROP COLUMN "opening"; (the
-- per-line answers written since are lost; the reports fall back to the
-- read-time judgement for every line).

ALTER TABLE "pos"."stock_take_line" ADD COLUMN "opening" boolean;
