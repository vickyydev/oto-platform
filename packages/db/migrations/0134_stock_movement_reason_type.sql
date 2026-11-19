-- SCRUM-1012 (the loss report, E5) - 0134: a correction names its type
-- (delivery, found, recount, damaged, expired, theft, other) beside its
-- free-text reason. Adjust rows only. Every correction written before this
-- migration keeps NULL and the reports read it as "not given"; the ledger is
-- append-only and no stored row is rewritten.
ALTER TABLE "pos"."stock_movement" ADD COLUMN "reason_type" text;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_reason_type_check" CHECK ("pos"."stock_movement"."reason_type" is null or ("pos"."stock_movement"."kind" = 'adjust' and "pos"."stock_movement"."reason_type" in ('delivery','found','recount','damaged','expired','theft','other')));