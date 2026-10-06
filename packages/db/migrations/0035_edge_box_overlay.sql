-- Offline selling, Round 3 (plan docs/progress/plans/offline/PLAN.md §2.3,
-- SCRUM-269) — the counter box's own record of what it wrote offline.
--
-- `edge.box_overlay` holds the members, children and visits a counter box
-- recorded while it could not reach the platform. Each row is written in the
-- same store transaction as the fact queued for the platform, so the next
-- lookup at that counter finds the family it just signed up; the row is pruned
-- once a cache pull brings the platform's own copy.
--
-- On a Raspberry Pi the same table is created in its SQLite file at boot
-- (`SQLITE_BOX_SCHEMA` in @oto/box-agent). Here it is the virtual box's, in the
-- `edge` schema of the platform database. New table only; nothing else changes.

CREATE TABLE "edge"."box_overlay" (
	"box_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"member_id" uuid,
	"phone" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_overlay_box_id_kind_entity_id_pk" PRIMARY KEY("box_id","kind","entity_id"),
	CONSTRAINT "box_overlay_kind_check" CHECK ("edge"."box_overlay"."kind" in ('member','child','visit')),
	CONSTRAINT "box_overlay_phone_check" CHECK ("edge"."box_overlay"."phone" is null or "edge"."box_overlay"."phone" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
ALTER TABLE "edge"."box_overlay" ADD CONSTRAINT "box_overlay_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_overlay" ADD CONSTRAINT "box_overlay_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_overlay_operator_idx" ON "edge"."box_overlay" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "box_overlay_phone_idx" ON "edge"."box_overlay" USING btree ("box_id","phone");--> statement-breakpoint
CREATE INDEX "box_overlay_member_idx" ON "edge"."box_overlay" USING btree ("box_id","member_id");