CREATE TABLE "pos"."party_additional_bill" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"main_settlement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pos"."party_charge" ADD COLUMN "additional_bill_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD COLUMN "additional_bill_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."party_additional_bill" ADD CONSTRAINT "party_additional_bill_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_additional_bill" ADD CONSTRAINT "party_additional_bill_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_additional_bill" ADD CONSTRAINT "party_additional_bill_main_settlement_id_party_settlement_id_fk" FOREIGN KEY ("main_settlement_id") REFERENCES "pos"."party_settlement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_additional_bill_event_idx" ON "pos"."party_additional_bill" USING btree ("branch_id","otoapp_event_id","created_at");--> statement-breakpoint
ALTER TABLE "pos"."party_charge" ADD CONSTRAINT "party_charge_additional_bill_id_party_additional_bill_id_fk" FOREIGN KEY ("additional_bill_id") REFERENCES "pos"."party_additional_bill"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD CONSTRAINT "party_payment_additional_bill_id_party_additional_bill_id_fk" FOREIGN KEY ("additional_bill_id") REFERENCES "pos"."party_additional_bill"("id") ON DELETE restrict ON UPDATE no action;