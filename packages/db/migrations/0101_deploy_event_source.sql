ALTER TABLE "core"."deploy_event" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "core"."deploy_event" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "core"."deploy_event" ADD COLUMN "source_event_id" text;--> statement-breakpoint
ALTER TABLE "core"."deploy_event" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_event_source_event_unique" ON "core"."deploy_event" USING btree ("source","source_event_id") WHERE "core"."deploy_event"."source_event_id" is not null;--> statement-breakpoint
ALTER TABLE "core"."deploy_event" ADD CONSTRAINT "deploy_event_source_pair_check" CHECK (("core"."deploy_event"."source" is null) = ("core"."deploy_event"."source_event_id" is null));