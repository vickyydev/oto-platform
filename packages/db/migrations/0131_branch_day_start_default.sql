-- SCRUM-1010 (the park's day runs midnight to midnight) - 0131, step 1 of 2.
-- Only the column DEFAULT moves to midnight, for parks created from now on.
-- Every existing park still holds its explicit value (05:00 everywhere the
-- 0009 default wrote it), so nothing changes day yet; the switch of existing
-- parks is its own migration. No stored business date is rewritten.
--
-- TO REVERSE: ALTER COLUMN "business_day_start" SET DEFAULT '05:00'.
ALTER TABLE "core"."branch" ALTER COLUMN "business_day_start" SET DEFAULT '00:00';
