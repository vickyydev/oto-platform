CREATE TABLE "qa_analysis_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"lease_token" uuid NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_analysis_attempts_revision_check" CHECK ("qa_analysis_attempts"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "qa_report_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_report_attachments_size_check" CHECK ("qa_report_attachments"."size">0 AND "qa_report_attachments"."size"<=26214400),
	CONSTRAINT "qa_report_attachments_type_check" CHECK ("qa_report_attachments"."content_type" IN ('image/png','image/jpeg','image/webp','video/mp4','video/webm')),
	CONSTRAINT "qa_report_attachments_sha_check" CHECK ("qa_report_attachments"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "qa_report_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"sequence" bigserial NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"client_request_id" uuid,
	"analyzed_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_report_messages_role_check" CHECK ("qa_report_messages"."role" IN ('user','assistant')),
	CONSTRAINT "qa_report_messages_content_check" CHECK (length("qa_report_messages"."content") BETWEEN 1 AND 24000),
	CONSTRAINT "qa_report_messages_kind_check" CHECK (("qa_report_messages"."role"='user' AND "qa_report_messages"."client_request_id" IS NOT NULL AND "qa_report_messages"."analyzed_revision" IS NULL) OR ("qa_report_messages"."role"='assistant' AND "qa_report_messages"."client_request_id" IS NULL AND "qa_report_messages"."analyzed_revision">0))
);
--> statement-breakpoint
CREATE TABLE "qa_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"title" text NOT NULL,
	"context" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"assessment" text DEFAULT 'reported' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"analyzed_revision" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"jira_key" text,
	"jira_url" text,
	"jira_creation_pending" boolean DEFAULT false NOT NULL,
	"source_evidence" jsonb,
	"last_error" text,
	"worker_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_reports_status_check" CHECK ("qa_reports"."status" IN ('draft','queued','processing','complete','retrying','needs_configuration')),
	CONSTRAINT "qa_reports_assessment_check" CHECK ("qa_reports"."assessment" IN ('reported','code_supported','guidance','needs_investigation','related_report')),
	CONSTRAINT "qa_reports_revision_check" CHECK ("qa_reports"."revision">0 AND "qa_reports"."analyzed_revision">=0 AND "qa_reports"."analyzed_revision"<="qa_reports"."revision" AND "qa_reports"."attempts">=0),
	CONSTRAINT "qa_reports_lease_check" CHECK ((("qa_reports"."status"='processing') AND "qa_reports"."lease_token" IS NOT NULL AND "qa_reports"."lease_expires_at" IS NOT NULL AND "qa_reports"."worker_id" IS NOT NULL) OR (("qa_reports"."status"<>'processing') AND "qa_reports"."lease_token" IS NULL AND "qa_reports"."lease_expires_at" IS NULL AND "qa_reports"."worker_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "qa_analysis_attempts" ADD CONSTRAINT "qa_analysis_attempts_report_id_qa_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "qa_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_report_attachments" ADD CONSTRAINT "qa_report_attachments_report_id_qa_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "qa_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_report_messages" ADD CONSTRAINT "qa_report_messages_report_id_qa_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "qa_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_reports" ADD CONSTRAINT "qa_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_reports" ADD CONSTRAINT "qa_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_analysis_attempts_result_unique" ON "qa_analysis_attempts" USING btree ("report_id","revision") WHERE "qa_analysis_attempts"."result" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "qa_analysis_attempts_created_idx" ON "qa_analysis_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_report_attachments_object_unique" ON "qa_report_attachments" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "qa_report_attachments_report_idx" ON "qa_report_attachments" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_report_messages_request_unique" ON "qa_report_messages" USING btree ("report_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_report_messages_revision_unique" ON "qa_report_messages" USING btree ("report_id","analyzed_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_reports_request_unique" ON "qa_reports" USING btree ("tenant_id","user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "qa_reports_owner_created_idx" ON "qa_reports" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "qa_reports_queue_idx" ON "qa_reports" USING btree ("status","next_attempt_at","updated_at");