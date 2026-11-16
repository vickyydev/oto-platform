CREATE TABLE "pos"."prebooking_deposit_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"draft_id" uuid NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos"."prebooking_draft" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_satang" bigint NOT NULL,
	"currency" text NOT NULL,
	"booking" jsonb NOT NULL,
	"booking_claim" jsonb,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prebooking_draft_amount_check" CHECK ("pos"."prebooking_draft"."amount_satang" > 0 and "pos"."prebooking_draft"."amount_satang" % 100 = 0)
);
--> statement-breakpoint
ALTER TABLE "pos"."prebooking_deposit_request" ADD CONSTRAINT "prebooking_deposit_request_draft_id_prebooking_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "pos"."prebooking_draft"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prebooking_deposit_request" ADD CONSTRAINT "prebooking_deposit_request_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prebooking_draft" ADD CONSTRAINT "prebooking_draft_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prebooking_draft" ADD CONSTRAINT "prebooking_draft_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prebooking_draft" ADD CONSTRAINT "prebooking_draft_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prebooking_deposit_attempt_unique" ON "pos"."prebooking_deposit_request" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "prebooking_deposit_draft_idx" ON "pos"."prebooking_deposit_request" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prebooking_draft_open_conversation_unique" ON "pos"."prebooking_draft" USING btree ("conversation_id") WHERE "pos"."prebooking_draft"."booked_at" is null;--> statement-breakpoint
CREATE INDEX "prebooking_draft_operator_idx" ON "pos"."prebooking_draft" USING btree ("operator_id","conversation_id");