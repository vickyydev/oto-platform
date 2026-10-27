CREATE TABLE "core"."app_registry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"origin_urls" jsonb NOT NULL,
	"schema_name" text NOT NULL,
	"owning_service" text NOT NULL,
	"health_url" text,
	"version_source" text NOT NULL,
	"required_permission" text NOT NULL,
	"sort_order" integer NOT NULL,
	"tile_state" text NOT NULL,
	"maintenance_message" text,
	"maintenance_expires_at" timestamp with time zone,
	"maintenance_restore_state" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_registry_key_unique" UNIQUE("key"),
	CONSTRAINT "app_registry_key_check" CHECK ("core"."app_registry"."key" in ('pos', 'console', 'oto_app', 'radar', 'booth', 'inbox')),
	CONSTRAINT "app_registry_origins_object_check" CHECK (jsonb_typeof("core"."app_registry"."origin_urls") = 'object'),
	CONSTRAINT "app_registry_tile_state_check" CHECK ("core"."app_registry"."tile_state" in ('open', 'coming_soon', 'hidden', 'maintenance')),
	CONSTRAINT "app_registry_revision_positive_check" CHECK ("core"."app_registry"."revision" > 0),
	CONSTRAINT "app_registry_maintenance_check" CHECK ((
    "core"."app_registry"."tile_state" = 'maintenance' and "core"."app_registry"."maintenance_message" is not null and length(btrim("core"."app_registry"."maintenance_message")) > 0
    and "core"."app_registry"."maintenance_expires_at" is not null and "core"."app_registry"."maintenance_restore_state" is not null
    and "core"."app_registry"."maintenance_restore_state" in ('open', 'coming_soon', 'hidden')
  ) or (
    "core"."app_registry"."tile_state" <> 'maintenance' and "core"."app_registry"."maintenance_message" is null
    and "core"."app_registry"."maintenance_expires_at" is null and "core"."app_registry"."maintenance_restore_state" is null
  ))
);
--> statement-breakpoint
CREATE TABLE "core"."deploy_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app" text NOT NULL,
	"version" text,
	"commit" text,
	"actor_account_id" uuid,
	"status" text NOT NULL,
	"ci_green" boolean,
	"deployed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_event_status_check" CHECK (length(btrim("core"."deploy_event"."status")) > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."feature_flag" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"target_app" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"operator_id" uuid,
	"value" jsonb NOT NULL,
	"default_value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"reason" text,
	"updated_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flag_kind_check" CHECK ("core"."feature_flag"."kind" in ('feature', 'kill_switch')),
	CONSTRAINT "feature_flag_scope_type_check" CHECK ("core"."feature_flag"."scope_type" in ('platform', 'operator', 'branch', 'station')),
	CONSTRAINT "feature_flag_scope_shape_check" CHECK ((
    "core"."feature_flag"."scope_type" = 'platform' and "core"."feature_flag"."scope_id" is null and "core"."feature_flag"."operator_id" is null
  ) or (
    "core"."feature_flag"."scope_type" <> 'platform' and "core"."feature_flag"."scope_id" is not null and "core"."feature_flag"."operator_id" is not null
  )),
	CONSTRAINT "feature_flag_operator_scope_check" CHECK ("core"."feature_flag"."scope_type" <> 'operator' or "core"."feature_flag"."scope_id" = "core"."feature_flag"."operator_id"),
	CONSTRAINT "feature_flag_revision_positive_check" CHECK ("core"."feature_flag"."revision" > 0),
	CONSTRAINT "feature_flag_kill_switch_check" CHECK ("core"."feature_flag"."kind" <> 'kill_switch' or (
    "core"."feature_flag"."expires_at" is not null and "core"."feature_flag"."reason" is not null and length(btrim("core"."feature_flag"."reason")) > 0
  ))
);
--> statement-breakpoint
CREATE TABLE "core"."suite_control_approval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"operation" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"operator_id" uuid,
	"requester_account_id" uuid NOT NULL,
	"approver_account_id" uuid,
	"state" text NOT NULL,
	"request_expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suite_control_approval_action_check" CHECK ("core"."suite_control_approval"."action" = 'kill_switch.set'),
	CONSTRAINT "suite_control_approval_operation_check" CHECK (jsonb_typeof("core"."suite_control_approval"."operation") = 'object'),
	CONSTRAINT "suite_control_approval_digest_check" CHECK ("core"."suite_control_approval"."payload_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "suite_control_approval_ten_minutes_check" CHECK ("core"."suite_control_approval"."request_expires_at" = "core"."suite_control_approval"."created_at" + interval '10 minutes'),
	CONSTRAINT "suite_control_approval_state_check" CHECK ("core"."suite_control_approval"."state" in ('pending', 'approved', 'consumed', 'expired')),
	CONSTRAINT "suite_control_approval_transition_check" CHECK ((
    "core"."suite_control_approval"."state" = 'pending' and "core"."suite_control_approval"."approver_account_id" is null and "core"."suite_control_approval"."approved_at" is null
    and "core"."suite_control_approval"."consumed_at" is null and "core"."suite_control_approval"."expired_at" is null
  ) or (
    "core"."suite_control_approval"."state" in ('approved', 'consumed') and "core"."suite_control_approval"."approver_account_id" is not null
    and "core"."suite_control_approval"."approver_account_id" <> "core"."suite_control_approval"."requester_account_id" and "core"."suite_control_approval"."approved_at" is not null
    and "core"."suite_control_approval"."approved_at" >= "core"."suite_control_approval"."created_at" and "core"."suite_control_approval"."approved_at" < "core"."suite_control_approval"."request_expires_at" and "core"."suite_control_approval"."expired_at" is null
    and (("core"."suite_control_approval"."state" = 'approved' and "core"."suite_control_approval"."consumed_at" is null)
      or ("core"."suite_control_approval"."state" = 'consumed' and "core"."suite_control_approval"."consumed_at" is not null and "core"."suite_control_approval"."consumed_at" >= "core"."suite_control_approval"."approved_at"
        and "core"."suite_control_approval"."consumed_at" < "core"."suite_control_approval"."request_expires_at"))
  ) or (
    "core"."suite_control_approval"."state" = 'expired' and "core"."suite_control_approval"."consumed_at" is null and "core"."suite_control_approval"."expired_at" is not null and "core"."suite_control_approval"."expired_at" >= "core"."suite_control_approval"."request_expires_at"
    and (("core"."suite_control_approval"."approver_account_id" is null and "core"."suite_control_approval"."approved_at" is null)
      or ("core"."suite_control_approval"."approver_account_id" is not null and "core"."suite_control_approval"."approver_account_id" <> "core"."suite_control_approval"."requester_account_id"
        and "core"."suite_control_approval"."approved_at" is not null and "core"."suite_control_approval"."approved_at" >= "core"."suite_control_approval"."created_at" and "core"."suite_control_approval"."approved_at" < "core"."suite_control_approval"."request_expires_at"))
  ))
);
--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "target_app" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "core"."deploy_event" ADD CONSTRAINT "deploy_event_app_app_registry_key_fk" FOREIGN KEY ("app") REFERENCES "core"."app_registry"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."deploy_event" ADD CONSTRAINT "deploy_event_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."feature_flag" ADD CONSTRAINT "feature_flag_target_app_app_registry_key_fk" FOREIGN KEY ("target_app") REFERENCES "core"."app_registry"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."feature_flag" ADD CONSTRAINT "feature_flag_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."feature_flag" ADD CONSTRAINT "feature_flag_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."suite_control_approval" ADD CONSTRAINT "suite_control_approval_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."suite_control_approval" ADD CONSTRAINT "suite_control_approval_requester_account_id_account_id_fk" FOREIGN KEY ("requester_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."suite_control_approval" ADD CONSTRAINT "suite_control_approval_approver_account_id_account_id_fk" FOREIGN KEY ("approver_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deploy_event_app_time_idx" ON "core"."deploy_event" USING btree ("app","deployed_at");--> statement-breakpoint
CREATE INDEX "deploy_event_actor_idx" ON "core"."deploy_event" USING btree ("actor_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_platform_key_unique" ON "core"."feature_flag" USING btree ("key") WHERE "core"."feature_flag"."scope_type" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_scoped_key_unique" ON "core"."feature_flag" USING btree ("key","scope_type","scope_id") WHERE "core"."feature_flag"."scope_type" <> 'platform';--> statement-breakpoint
CREATE INDEX "feature_flag_operator_idx" ON "core"."feature_flag" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "feature_flag_updated_by_idx" ON "core"."feature_flag" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "feature_flag_target_app_idx" ON "core"."feature_flag" USING btree ("target_app");--> statement-breakpoint
CREATE INDEX "feature_flag_expiry_idx" ON "core"."feature_flag" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "suite_control_approval_requester_idx" ON "core"."suite_control_approval" USING btree ("requester_account_id");--> statement-breakpoint
CREATE INDEX "suite_control_approval_approver_idx" ON "core"."suite_control_approval" USING btree ("approver_account_id");--> statement-breakpoint
CREATE INDEX "suite_control_approval_operator_idx" ON "core"."suite_control_approval" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "suite_control_approval_expiry_idx" ON "core"."suite_control_approval" USING btree ("state","request_expires_at");