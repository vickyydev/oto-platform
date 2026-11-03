CREATE TABLE "pos"."event_pass_hold" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"child_id" uuid,
	"member_id" uuid,
	"price_snapshot_satang" bigint NOT NULL,
	"pricing_mode" text NOT NULL,
	"parent_attending" boolean DEFAULT false NOT NULL,
	"register_properly" boolean DEFAULT false NOT NULL,
	"attendance_days" date[] DEFAULT '{}'::date[] NOT NULL,
	"writeback" jsonb NOT NULL,
	"account_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"box_id" uuid,
	"action_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_pass_hold_type_check" CHECK ("pos"."event_pass_hold"."event_type" in ('camp','event')),
	CONSTRAINT "event_pass_hold_status_check" CHECK ("pos"."event_pass_hold"."status" in ('pending','applied','released')),
	CONSTRAINT "event_pass_hold_price_check" CHECK ("pos"."event_pass_hold"."price_snapshot_satang" > 0)
);
--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_child_id_child_id_fk" FOREIGN KEY ("child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_pass_hold" ADD CONSTRAINT "event_pass_hold_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_pass_hold_sale_unique" ON "pos"."event_pass_hold" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "event_pass_hold_operator_idx" ON "pos"."event_pass_hold" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "event_pass_hold_branch_idx" ON "pos"."event_pass_hold" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "event_pass_hold_child_idx" ON "pos"."event_pass_hold" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "event_pass_hold_member_idx" ON "pos"."event_pass_hold" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "event_pass_hold_account_idx" ON "pos"."event_pass_hold" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "event_pass_hold_station_idx" ON "pos"."event_pass_hold" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "event_pass_hold_box_idx" ON "pos"."event_pass_hold" USING btree ("box_id");