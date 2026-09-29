CREATE TABLE "core"."display_response_snapshot" (
	"credential_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"journal_epoch" integer,
	"prepared_at" timestamp with time zone NOT NULL,
	"response_kind" text NOT NULL,
	"status_code" integer NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "display_response_snapshot_kind_check" CHECK ("core"."display_response_snapshot"."response_kind" in ('session', 'intent')),
	CONSTRAINT "display_response_snapshot_status_check" CHECK ("core"."display_response_snapshot"."status_code" in (200, 403, 409)),
	CONSTRAINT "display_response_snapshot_epoch_check" CHECK ("core"."display_response_snapshot"."journal_epoch" is null or "core"."display_response_snapshot"."journal_epoch" > 0),
	CONSTRAINT "display_response_snapshot_document_check" CHECK (jsonb_typeof("core"."display_response_snapshot"."document") = 'object')
);
--> statement-breakpoint
ALTER TABLE "core"."display_response_snapshot" ADD CONSTRAINT "display_response_snapshot_credential_id_device_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "core"."device_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."display_response_snapshot" ADD CONSTRAINT "display_response_snapshot_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."display_response_snapshot" ADD CONSTRAINT "display_response_snapshot_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."display_response_snapshot" ADD CONSTRAINT "display_response_snapshot_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."display_response_snapshot" ADD CONSTRAINT "display_response_snapshot_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "display_response_snapshot_operator_idx" ON "core"."display_response_snapshot" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "display_response_snapshot_branch_idx" ON "core"."display_response_snapshot" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "display_response_snapshot_station_idx" ON "core"."display_response_snapshot" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "display_response_snapshot_box_idx" ON "core"."display_response_snapshot" USING btree ("box_id");