CREATE TABLE "core"."display_pairing_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"pairing_code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "display_pairing_request_claim_check" CHECK (
      ("core"."display_pairing_request"."credential_id" is null and "core"."display_pairing_request"."claimed_at" is null)
      or ("core"."display_pairing_request"."credential_id" is not null and "core"."display_pairing_request"."claimed_at" is not null and "core"."display_pairing_request"."pairing_code_hash" is null)
    )
);
--> statement-breakpoint
ALTER TABLE "core"."display_pairing_request" ADD CONSTRAINT "display_pairing_request_credential_id_device_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "core"."device_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "display_pairing_request_token_unique" ON "core"."display_pairing_request" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "display_pairing_request_code_unique" ON "core"."display_pairing_request" USING btree ("pairing_code_hash") WHERE pairing_code_hash is not null;--> statement-breakpoint
CREATE INDEX "display_pairing_request_credential_idx" ON "core"."display_pairing_request" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "display_pairing_request_expiry_idx" ON "core"."display_pairing_request" USING btree ("expires_at");