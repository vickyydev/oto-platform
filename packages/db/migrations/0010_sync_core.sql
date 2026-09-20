-- S2-05 — the sync core: the station session document and its lease, the box's
-- durable outbox, the cloud ledger every fact lands in, quarantine and
-- anomalies for the ones that did not, the change feed a box pulls, and the
-- cursor that keeps all of it idempotent.
--
-- Expand only. Nine new tables in `edge`, and five nullable-or-defaulted
-- columns on two existing ones — nothing is renamed, retyped or dropped — so
-- the release now deployed runs unchanged against this database and a rollback
-- onto it is uneventful.
--
-- `core.box` gains the public half of the keypair a box signs its events with.
-- It is a keypair rather than the shared secret the ticket sketches because
-- S2-04 stores only SHA-256 of the box secret, and a hash cannot verify an
-- HMAC; the alternative would be a second, recoverable per-box credential
-- sitting in the database. `sync_key_algorithm` is NOT NULL with a default,
-- which Postgres fills as metadata rather than by rewriting the table.
--
-- `core.audit_log` gains `action_id` and `source_event_id`, which is what
-- makes one user action followable across the till, the box log and the cloud.
-- Neither is a foreign key: the ledger is swept after a year and the audit log
-- is not, so a constraint would either block the sweep or take audit rows with
-- it.
--
-- Nothing here is unique over existing data, so no index in this migration can
-- refuse to build on a live database.

CREATE TABLE "edge"."box_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"journal_epoch" integer NOT NULL,
	"box_seq" bigint NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"clock_trust" text DEFAULT 'trusted' NOT NULL,
	"clock_offset_ms" integer,
	"station_id" uuid,
	"actor_kind" text DEFAULT 'account' NOT NULL,
	"actor_account_id" uuid,
	"actor_credential_id" uuid,
	"action_id" text,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"sig" text NOT NULL,
	"sig_alg" text DEFAULT 'ed25519' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone,
	CONSTRAINT "box_outbox_seq_check" CHECK ("edge"."box_outbox"."box_seq" > 0),
	CONSTRAINT "box_outbox_epoch_check" CHECK ("edge"."box_outbox"."journal_epoch" > 0),
	CONSTRAINT "box_outbox_type_check" CHECK ("edge"."box_outbox"."type" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
	CONSTRAINT "box_outbox_clock_trust_check" CHECK ("edge"."box_outbox"."clock_trust" in ('trusted','skewed','untrusted')),
	CONSTRAINT "box_outbox_actor_kind_check" CHECK ("edge"."box_outbox"."actor_kind" in ('account','device','box','system')),
	CONSTRAINT "box_outbox_payload_hash_check" CHECK ("edge"."box_outbox"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "box_outbox_state_check" CHECK ("edge"."box_outbox"."state" in ('queued','sending','acked','quarantined','failed'))
);
--> statement-breakpoint
CREATE TABLE "edge"."box_state" (
	"box_id" uuid PRIMARY KEY NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"offline_since" timestamp with time zone,
	"offline_reason" text,
	"offline_set_by_account_id" uuid,
	"journal_epoch" integer DEFAULT 1 NOT NULL,
	"next_box_seq" bigint DEFAULT 1 NOT NULL,
	"store_schema_version" integer DEFAULT 1 NOT NULL,
	"clock_skew_ms" integer DEFAULT 0 NOT NULL,
	"applied_config_version" text,
	"last_cache_applied_at" timestamp with time zone,
	"last_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_state_epoch_check" CHECK ("edge"."box_state"."journal_epoch" > 0),
	CONSTRAINT "box_state_seq_check" CHECK ("edge"."box_state"."next_box_seq" > 0),
	CONSTRAINT "box_state_schema_version_check" CHECK ("edge"."box_state"."store_schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "edge"."station_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"station_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"sequence" bigint,
	"stage" text,
	"intent_type" text,
	"lease_id" uuid,
	"outcome" text,
	"error_code" text,
	"actor_account_id" uuid,
	"action_id" text,
	"payload" jsonb,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_event_kind_check" CHECK ("edge"."station_event"."kind" in ('intent','snapshot','lease','scan','error')),
	CONSTRAINT "station_event_source_check" CHECK ("edge"."station_event"."source" in ('till','display','kiosk','booth','box','console'))
);
--> statement-breakpoint
CREATE TABLE "edge"."station_session" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"stage" text DEFAULT 'identify' NOT NULL,
	"step" smallint,
	"cart" jsonb,
	"member" jsonb,
	"totals" jsonb,
	"payment" jsonb,
	"prompt" jsonb,
	"language" text DEFAULT 'en' NOT NULL,
	"lease_id" uuid,
	"lease_holder" text,
	"lease_holder_kind" text,
	"lease_account_id" uuid,
	"lease_started_at" timestamp with time zone,
	"lease_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"takeover_count" integer DEFAULT 0 NOT NULL,
	"last_intent_at" timestamp with time zone,
	"last_action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_session_sequence_check" CHECK ("edge"."station_session"."sequence" >= 0),
	CONSTRAINT "station_session_step_check" CHECK ("edge"."station_session"."step" is null or ("edge"."station_session"."step" >= 1 and "edge"."station_session"."step" <= 9)),
	CONSTRAINT "station_session_stage_check" CHECK ("edge"."station_session"."stage" in ('identify','welcome','order','input','payment','thankyou')),
	CONSTRAINT "station_session_language_check" CHECK ("edge"."station_session"."language" in ('en','zh','th','ru','fr')),
	CONSTRAINT "station_session_lease_holder_kind_check" CHECK ("edge"."station_session"."lease_holder_kind" is null or "edge"."station_session"."lease_holder_kind" in ('till','kiosk','booth','console')),
	CONSTRAINT "station_session_lease_complete_check" CHECK (("edge"."station_session"."lease_id" is null and "edge"."station_session"."lease_holder" is null and "edge"."station_session"."lease_expires_at" is null)
          or ("edge"."station_session"."lease_id" is not null and "edge"."station_session"."lease_holder" is not null and "edge"."station_session"."lease_expires_at" is not null)),
	CONSTRAINT "station_session_takeover_check" CHECK ("edge"."station_session"."takeover_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "edge"."sync_anomaly" (
	"id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"event_id" uuid,
	"related_event_id" uuid,
	"kind" text NOT NULL,
	"detail" jsonb,
	"action_id" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_anomaly_kind_check" CHECK ("edge"."sync_anomaly"."kind" in ('clock_recomputed','duplicate_replay','sequence_gap','merge','epoch_regressed','late_arrival'))
);
--> statement-breakpoint
CREATE TABLE "edge"."sync_change" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"box_id" uuid,
	"scope" text NOT NULL,
	"op" text DEFAULT 'upsert' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"version" integer,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_change_scope_check" CHECK ("edge"."sync_change"."scope" in ('catalogue','members','staff','deny_list','bookings','bands','station_config','receipt_series')),
	CONSTRAINT "sync_change_op_check" CHECK ("edge"."sync_change"."op" in ('upsert','delete')),
	CONSTRAINT "sync_change_delete_check" CHECK ("edge"."sync_change"."op" <> 'delete' or "edge"."sync_change"."payload" is null)
);
--> statement-breakpoint
CREATE TABLE "edge"."sync_cursor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"journal_epoch" integer NOT NULL,
	"last_box_seq" bigint DEFAULT 0 NOT NULL,
	"last_event_id" uuid,
	"events_applied" bigint DEFAULT 0 NOT NULL,
	"events_duplicate" bigint DEFAULT 0 NOT NULL,
	"events_quarantined" bigint DEFAULT 0 NOT NULL,
	"last_push_at" timestamp with time zone,
	"pull_cursor_seq" bigint DEFAULT 0 NOT NULL,
	"last_pull_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursor_epoch_check" CHECK ("edge"."sync_cursor"."journal_epoch" > 0),
	CONSTRAINT "sync_cursor_seq_check" CHECK ("edge"."sync_cursor"."last_box_seq" >= 0),
	CONSTRAINT "sync_cursor_pull_check" CHECK ("edge"."sync_cursor"."pull_cursor_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "edge"."sync_event" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"journal_epoch" integer NOT NULL,
	"box_seq" bigint NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_trust" text DEFAULT 'trusted' NOT NULL,
	"clock_offset_ms" integer,
	"business_date" date NOT NULL,
	"business_date_source" text DEFAULT 'occurred_at' NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid,
	"actor_kind" text DEFAULT 'account' NOT NULL,
	"actor_account_id" uuid,
	"actor_credential_id" uuid,
	"action_id" text,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"sig" text NOT NULL,
	"sig_alg" text DEFAULT 'ed25519' NOT NULL,
	"batch_id" text,
	CONSTRAINT "sync_event_seq_check" CHECK ("edge"."sync_event"."box_seq" > 0),
	CONSTRAINT "sync_event_epoch_check" CHECK ("edge"."sync_event"."journal_epoch" > 0),
	CONSTRAINT "sync_event_schema_version_check" CHECK ("edge"."sync_event"."schema_version" > 0),
	CONSTRAINT "sync_event_type_check" CHECK ("edge"."sync_event"."type" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
	CONSTRAINT "sync_event_clock_trust_check" CHECK ("edge"."sync_event"."clock_trust" in ('trusted','skewed','untrusted')),
	CONSTRAINT "sync_event_business_date_source_check" CHECK ("edge"."sync_event"."business_date_source" in ('occurred_at','received_at')),
	CONSTRAINT "sync_event_actor_kind_check" CHECK ("edge"."sync_event"."actor_kind" in ('account','device','box','system')),
	CONSTRAINT "sync_event_payload_hash_check" CHECK ("edge"."sync_event"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "edge"."sync_quarantine" (
	"id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"journal_epoch" integer NOT NULL,
	"box_seq" bigint NOT NULL,
	"type" text,
	"schema_version" integer,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"error_code" text,
	"error_message" text,
	"payload" jsonb NOT NULL,
	"payload_hash" text,
	"existing_payload_hash" text,
	"sig" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_id" text,
	"batch_id" text,
	"alert_key" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_account_id" uuid,
	"resolution_note" text,
	"replayed_event_id" uuid,
	CONSTRAINT "sync_quarantine_epoch_check" CHECK ("edge"."sync_quarantine"."journal_epoch" > 0),
	CONSTRAINT "sync_quarantine_reason_check" CHECK ("edge"."sync_quarantine"."reason" in ('conflict','poison','epoch_regressed','sequence_gap','unknown_type','schema_too_new','actor_unknown','signature_invalid','apply_failed')),
	CONSTRAINT "sync_quarantine_status_check" CHECK ("edge"."sync_quarantine"."status" in ('open','replayed','discarded'))
);
--> statement-breakpoint
ALTER TABLE "core"."box" ADD COLUMN "sync_public_key" text;--> statement-breakpoint
ALTER TABLE "core"."box" ADD COLUMN "sync_key_algorithm" text DEFAULT 'ed25519' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."box" ADD COLUMN "sync_key_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "action_id" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "source_event_id" uuid;--> statement-breakpoint
ALTER TABLE "edge"."box_outbox" ADD CONSTRAINT "box_outbox_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_outbox" ADD CONSTRAINT "box_outbox_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_outbox" ADD CONSTRAINT "box_outbox_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_outbox" ADD CONSTRAINT "box_outbox_actor_credential_id_device_credential_id_fk" FOREIGN KEY ("actor_credential_id") REFERENCES "core"."device_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_state" ADD CONSTRAINT "box_state_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_state" ADD CONSTRAINT "box_state_offline_set_by_account_id_account_id_fk" FOREIGN KEY ("offline_set_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_event" ADD CONSTRAINT "station_event_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_event" ADD CONSTRAINT "station_event_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_event" ADD CONSTRAINT "station_event_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_session" ADD CONSTRAINT "station_session_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_session" ADD CONSTRAINT "station_session_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_session" ADD CONSTRAINT "station_session_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_session" ADD CONSTRAINT "station_session_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."station_session" ADD CONSTRAINT "station_session_lease_account_id_account_id_fk" FOREIGN KEY ("lease_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_anomaly" ADD CONSTRAINT "sync_anomaly_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_change" ADD CONSTRAINT "sync_change_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_change" ADD CONSTRAINT "sync_change_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_change" ADD CONSTRAINT "sync_change_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_cursor" ADD CONSTRAINT "sync_cursor_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_event" ADD CONSTRAINT "sync_event_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_event" ADD CONSTRAINT "sync_event_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_event" ADD CONSTRAINT "sync_event_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_event" ADD CONSTRAINT "sync_event_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_event" ADD CONSTRAINT "sync_event_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_event" ADD CONSTRAINT "sync_event_actor_credential_id_device_credential_id_fk" FOREIGN KEY ("actor_credential_id") REFERENCES "core"."device_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_quarantine" ADD CONSTRAINT "sync_quarantine_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."sync_quarantine" ADD CONSTRAINT "sync_quarantine_resolved_by_account_id_account_id_fk" FOREIGN KEY ("resolved_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "box_outbox_journal_unique" ON "edge"."box_outbox" USING btree ("box_id","journal_epoch","box_seq");--> statement-breakpoint
CREATE INDEX "box_outbox_send_idx" ON "edge"."box_outbox" USING btree ("box_id","box_seq") WHERE state in ('queued','sending');--> statement-breakpoint
CREATE INDEX "box_outbox_created_idx" ON "edge"."box_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "box_outbox_station_idx" ON "edge"."box_outbox" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "box_outbox_actor_account_idx" ON "edge"."box_outbox" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "box_outbox_actor_credential_idx" ON "edge"."box_outbox" USING btree ("actor_credential_id");--> statement-breakpoint
CREATE INDEX "box_outbox_action_idx" ON "edge"."box_outbox" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "box_state_offline_idx" ON "edge"."box_state" USING btree ("offline");--> statement-breakpoint
CREATE INDEX "box_state_offline_set_by_idx" ON "edge"."box_state" USING btree ("offline_set_by_account_id");--> statement-breakpoint
CREATE INDEX "station_event_station_received_idx" ON "edge"."station_event" USING btree ("station_id","received_at");--> statement-breakpoint
CREATE INDEX "station_event_box_received_idx" ON "edge"."station_event" USING btree ("box_id","received_at");--> statement-breakpoint
CREATE INDEX "station_event_action_idx" ON "edge"."station_event" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "station_event_actor_idx" ON "edge"."station_event" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "station_event_received_idx" ON "edge"."station_event" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "station_session_box_idx" ON "edge"."station_session" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "station_session_branch_idx" ON "edge"."station_session" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "station_session_operator_idx" ON "edge"."station_session" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "station_session_lease_account_idx" ON "edge"."station_session" USING btree ("lease_account_id");--> statement-breakpoint
CREATE INDEX "station_session_lease_expires_idx" ON "edge"."station_session" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "sync_anomaly_box_detected_idx" ON "edge"."sync_anomaly" USING btree ("box_id","detected_at");--> statement-breakpoint
CREATE INDEX "sync_anomaly_kind_detected_idx" ON "edge"."sync_anomaly" USING btree ("kind","detected_at");--> statement-breakpoint
CREATE INDEX "sync_anomaly_event_idx" ON "edge"."sync_anomaly" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "sync_anomaly_detected_idx" ON "edge"."sync_anomaly" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "sync_change_branch_seq_idx" ON "edge"."sync_change" USING btree ("branch_id","seq");--> statement-breakpoint
CREATE INDEX "sync_change_box_seq_idx" ON "edge"."sync_change" USING btree ("box_id","seq") WHERE box_id is not null;--> statement-breakpoint
CREATE INDEX "sync_change_entity_idx" ON "edge"."sync_change" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "sync_change_created_idx" ON "edge"."sync_change" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_change_operator_idx" ON "edge"."sync_change" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursor_box_epoch_unique" ON "edge"."sync_cursor" USING btree ("box_id","journal_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_event_journal_unique" ON "edge"."sync_event" USING btree ("box_id","journal_epoch","box_seq");--> statement-breakpoint
CREATE INDEX "sync_event_received_idx" ON "edge"."sync_event" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "sync_event_branch_business_idx" ON "edge"."sync_event" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "sync_event_action_idx" ON "edge"."sync_event" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "sync_event_operator_idx" ON "edge"."sync_event" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "sync_event_station_idx" ON "edge"."sync_event" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "sync_event_actor_account_idx" ON "edge"."sync_event" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "sync_event_actor_credential_idx" ON "edge"."sync_event" USING btree ("actor_credential_id");--> statement-breakpoint
CREATE INDEX "sync_quarantine_open_idx" ON "edge"."sync_quarantine" USING btree ("received_at") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "sync_quarantine_box_received_idx" ON "edge"."sync_quarantine" USING btree ("box_id","received_at");--> statement-breakpoint
CREATE INDEX "sync_quarantine_event_idx" ON "edge"."sync_quarantine" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "sync_quarantine_action_idx" ON "edge"."sync_quarantine" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "sync_quarantine_resolved_by_idx" ON "edge"."sync_quarantine" USING btree ("resolved_by_account_id");--> statement-breakpoint
CREATE INDEX "audit_action_id_idx" ON "core"."audit_log" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "audit_source_event_idx" ON "core"."audit_log" USING btree ("source_event_id");