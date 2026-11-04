CREATE TABLE "pos"."sale_hold" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"note" text,
	"paid_satang" bigint DEFAULT 0 NOT NULL,
	"balance_satang" bigint NOT NULL,
	"held_by_account_id" uuid NOT NULL,
	"held_station_id" uuid NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"action_id" text,
	"released_at" timestamp with time zone,
	"released_by_account_id" uuid,
	"released_reason" text,
	"resumed_station_id" uuid,
	"resume_action_id" text,
	"flagged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_hold_kind_check" CHECK ("pos"."sale_hold"."kind" in ('held','part_paid')),
	CONSTRAINT "sale_hold_released_check" CHECK (("pos"."sale_hold"."released_at" is null) = ("pos"."sale_hold"."released_reason" is null)
          and ("pos"."sale_hold"."released_reason" is null or "pos"."sale_hold"."released_reason" in ('resumed','paid','voided','not_collected','refunded'))),
	CONSTRAINT "sale_hold_money_check" CHECK ("pos"."sale_hold"."paid_satang" >= 0 and "pos"."sale_hold"."balance_satang" > 0
          and (("pos"."sale_hold"."kind" = 'held' and "pos"."sale_hold"."paid_satang" = 0) or ("pos"."sale_hold"."kind" = 'part_paid' and "pos"."sale_hold"."paid_satang" > 0))),
	CONSTRAINT "sale_hold_label_check" CHECK (length(btrim("pos"."sale_hold"."label")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "pos"."sale_hold" ADD CONSTRAINT "sale_hold_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_hold" ADD CONSTRAINT "sale_hold_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_hold" ADD CONSTRAINT "sale_hold_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_hold" ADD CONSTRAINT "sale_hold_held_by_account_id_account_id_fk" FOREIGN KEY ("held_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_hold" ADD CONSTRAINT "sale_hold_held_station_id_station_id_fk" FOREIGN KEY ("held_station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_hold" ADD CONSTRAINT "sale_hold_released_by_account_id_account_id_fk" FOREIGN KEY ("released_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_hold" ADD CONSTRAINT "sale_hold_resumed_station_id_station_id_fk" FOREIGN KEY ("resumed_station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_hold_open_unique" ON "pos"."sale_hold" USING btree ("sale_id") WHERE released_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_hold_action_unique" ON "pos"."sale_hold" USING btree ("operator_id","action_id") WHERE action_id is not null;--> statement-breakpoint
CREATE INDEX "sale_hold_branch_open_idx" ON "pos"."sale_hold" USING btree ("branch_id","held_at") WHERE released_at is null;--> statement-breakpoint
CREATE INDEX "sale_hold_operator_idx" ON "pos"."sale_hold" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "sale_hold_branch_idx" ON "pos"."sale_hold" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "sale_hold_sale_idx" ON "pos"."sale_hold" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_hold_held_by_idx" ON "pos"."sale_hold" USING btree ("held_by_account_id");--> statement-breakpoint
CREATE INDEX "sale_hold_held_station_idx" ON "pos"."sale_hold" USING btree ("held_station_id");--> statement-breakpoint
CREATE INDEX "sale_hold_released_by_idx" ON "pos"."sale_hold" USING btree ("released_by_account_id");--> statement-breakpoint
CREATE INDEX "sale_hold_resumed_station_idx" ON "pos"."sale_hold" USING btree ("resumed_station_id");