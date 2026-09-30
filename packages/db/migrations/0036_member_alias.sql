-- Offline selling, Round 3 (plan docs/progress/plans/offline/PLAN.md §2.6
-- and OD-7) — a merged member's id keeps working.
--
-- The same phone typed at two counters while both were offline makes two
-- members. At sync the first to arrive survives and the second is recorded as a
-- merge. `crm.member_alias` keeps the discarded id pointing at the survivor, so
-- the children, visits and sales the second counter recorded under it land on
-- the survivor rather than in quarantine.
--
-- Children are never merged automatically: both are kept, and
-- `crm.member.children_review_since` flags the member for staff to confirm at
-- the next visit, so no allergy note disappears.
--
-- One new table and one nullable column; no data is rewritten.

CREATE TABLE "crm"."member_alias" (
	"alias_member_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"source_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."member" ADD COLUMN "children_review_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."member_alias" ADD CONSTRAINT "member_alias_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."member_alias" ADD CONSTRAINT "member_alias_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_alias_member_idx" ON "crm"."member_alias" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "member_alias_operator_idx" ON "crm"."member_alias" USING btree ("operator_id");