CREATE TABLE "pos"."settlement_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"source_key" text NOT NULL,
	"device_id" uuid,
	"command_id" uuid,
	"tid" text,
	"mid" text,
	"batch_ref" text,
	"file_name" text,
	"result_hash" text,
	"matched" integer DEFAULT 0 NOT NULL,
	"unmatched" integer DEFAULT 0 NOT NULL,
	"mismatched" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "settlement_batch_source_check" CHECK ("pos"."settlement_batch"."source" in ('terminal','2c2p')),
	CONSTRAINT "settlement_batch_state_check" CHECK ("pos"."settlement_batch"."state" in ('pending','matched','attention','failed','unsupported')),
	CONSTRAINT "settlement_batch_counts_check" CHECK ("pos"."settlement_batch"."matched" >= 0 and "pos"."settlement_batch"."unmatched" >= 0 and "pos"."settlement_batch"."mismatched" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."settlement_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"attempt_id" uuid,
	"method" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"tid" text,
	"approval_code" text,
	"terminal_ref" text,
	"invoice_no" text,
	"tran_ref" text,
	"payment_id" text,
	"transaction_type" text,
	"match" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_line_method_check" CHECK ("pos"."settlement_line"."method" in ('card','qr')),
	CONSTRAINT "settlement_line_match_check" CHECK ("pos"."settlement_line"."match" in ('matched','unmatched','amount_mismatch','ambiguous','reference_mismatch')),
	CONSTRAINT "settlement_line_amount_check" CHECK ("pos"."settlement_line"."amount_satang" > 0)
);
--> statement-breakpoint
ALTER TABLE "edge"."box_command" DROP CONSTRAINT "box_command_kind_check";--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "core"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_command_id_box_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "edge"."box_command"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_line" ADD CONSTRAINT "settlement_line_batch_id_settlement_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "pos"."settlement_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_line" ADD CONSTRAINT "settlement_line_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batch_source_unique" ON "pos"."settlement_batch" USING btree ("operator_id","branch_id","source","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batch_command_unique" ON "pos"."settlement_batch" USING btree ("command_id") WHERE command_id is not null;--> statement-breakpoint
CREATE INDEX "settlement_batch_branch_date_idx" ON "pos"."settlement_batch" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_line_batch_no_unique" ON "pos"."settlement_line" USING btree ("batch_id","line_no");--> statement-breakpoint
CREATE INDEX "settlement_line_attempt_idx" ON "pos"."settlement_line" USING btree ("attempt_id");--> statement-breakpoint
ALTER TABLE "edge"."box_command" ADD CONSTRAINT "box_command_kind_check" CHECK ("edge"."box_command"."kind" in ('test_print','config_apply','clear_cache','collect_logs','restart','go_offline','go_online','reset_store','simulate','terminal_sale','terminal_settle','drawer_kick'));
