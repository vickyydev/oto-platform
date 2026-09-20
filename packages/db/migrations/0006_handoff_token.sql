CREATE TABLE "core"."handoff_token" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"audience_origin" text NOT NULL,
	"key_id" text NOT NULL,
	"session_secret" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_token_audience_check" CHECK ("core"."handoff_token"."audience" in ('pos','console','oto_app','radar','booth','inbox'))
);
--> statement-breakpoint
ALTER TABLE "core"."handoff_token" ADD CONSTRAINT "handoff_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "core"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."handoff_token" ADD CONSTRAINT "handoff_token_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoff_token_session_idx" ON "core"."handoff_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "handoff_token_account_idx" ON "core"."handoff_token" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "handoff_token_expires_idx" ON "core"."handoff_token" USING btree ("expires_at");