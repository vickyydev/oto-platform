-- SCRUM-1012 (the loss report, E4 c) - 0133: each count stores which of the
-- branch's boxes held records they had not sent when it was committed, so the
-- loss report can say a count was made while a counter box had sales it had
-- not sent. NULL on every count committed before this migration (unknown); no
-- stored row is rewritten.
ALTER TABLE "pos"."stock_take" ADD COLUMN "unsent_boxes" jsonb;