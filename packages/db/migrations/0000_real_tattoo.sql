CREATE TYPE "public"."account_status" AS ENUM('invited', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('operator', 'branch', 'department', 'record');--> statement-breakpoint
CREATE TYPE "public"."verification_purpose" AS ENUM('setup', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('whatsapp', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."member_created_via" AS ENUM('pos', 'booking', 'import');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('draft', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."station_kind" AS ENUM('till', 'kiosk', 'gate', 'display');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"employee_id" uuid,
	"phone" text NOT NULL,
	"password_hash" text,
	"phone_verified_at" timestamp with time zone,
	"status" "account_status" DEFAULT 'invited' NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"address" text,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "department" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"nickname" text,
	"phone" text,
	"email" text,
	"department_id" uuid,
	"branch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operator" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"branch_id" uuid,
	"station_id" uuid,
	"pending_lookup_phone" text,
	"pending_lookup_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" "verification_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "child" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date_of_birth" date,
	"age_years" integer,
	"allergies" text,
	"medical_notes" text,
	"medical_alert" boolean DEFAULT false NOT NULL,
	"dietary" text,
	"food_restrictions" text,
	"notes" text,
	"last_confirmed_at" timestamp with time zone,
	"consent_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"nickname" text NOT NULL,
	"email" text,
	"tier_code" text DEFAULT 'tourist' NOT NULL,
	"preferred_channel" "contact_channel",
	"notes" text,
	"created_via" "member_created_via" DEFAULT 'pos' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "member_tier_verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"from_tier" text NOT NULL,
	"to_tier" text NOT NULL,
	"evidence_type" text NOT NULL,
	"evidence_expires_at" timestamp with time zone,
	"verified_by_account_id" uuid,
	"branch_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tier" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"requires_verification" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "visit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"member_id" uuid,
	"visit_date" date NOT NULL,
	"status" "visit_status" DEFAULT 'draft' NOT NULL,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_child" (
	"visit_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_child_visit_id_child_id_pk" PRIMARY KEY("visit_id","child_id")
);
--> statement-breakpoint
CREATE TABLE "branch_holiday" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branch_tax_config" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"category_id" uuid,
	"name" text NOT NULL,
	"price_satang" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_category" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"taxable_category" text DEFAULT 'fnb' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tax_override" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"category_id" uuid,
	"product_id" uuid,
	"vat_rate_bp" integer,
	"service_charge_bp" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_package" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"duration_label" text NOT NULL,
	"hours" integer NOT NULL,
	"prices" jsonb NOT NULL,
	"tier_pricing" jsonb,
	"adult_rules" jsonb,
	"freebies" jsonb,
	"credit_rule" jsonb,
	"gate_access" boolean DEFAULT false NOT NULL,
	"translations" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"branch_id" uuid,
	"actor_account_id" uuid,
	"request_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_object" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer,
	"owner_entity_type" text NOT NULL,
	"owner_entity_id" uuid NOT NULL,
	"uploaded_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"key" text NOT NULL,
	"account_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_key_account_id_key_pk" PRIMARY KEY("account_id","key")
);
--> statement-breakpoint
CREATE TABLE "station" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "station_kind" DEFAULT 'till' NOT NULL,
	"device_key_hash" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendee" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_id" uuid,
	"name" text NOT NULL,
	"age_years" integer,
	"kind" text DEFAULT 'child' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"member_id" uuid,
	"reference" text NOT NULL,
	"booking_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_satang" bigint DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid,
	"method" text NOT NULL,
	"amount_satang" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_level" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_location" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"member_id" uuid,
	"created_by_account_id" uuid,
	"kind" text DEFAULT 'sale' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_satang" bigint DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_satang" bigint DEFAULT 0 NOT NULL,
	"total_satang" bigint DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"member_id" uuid,
	"balance_satang" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet_id" uuid NOT NULL,
	"amount_satang" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wristband" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" text NOT NULL,
	"kind" text DEFAULT 'kid' NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_code" ADD CONSTRAINT "verification_code_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child" ADD CONSTRAINT "child_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_tier_verification" ADD CONSTRAINT "member_tier_verification_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_tier_verification" ADD CONSTRAINT "member_tier_verification_verified_by_account_id_account_id_fk" FOREIGN KEY ("verified_by_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_tier_verification" ADD CONSTRAINT "member_tier_verification_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier" ADD CONSTRAINT "tier_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_child" ADD CONSTRAINT "visit_child_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_child" ADD CONSTRAINT "visit_child_child_id_child_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."child"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_holiday" ADD CONSTRAINT "branch_holiday_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tax_config" ADD CONSTRAINT "branch_tax_config_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_product_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_override" ADD CONSTRAINT "tax_override_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_override" ADD CONSTRAINT "tax_override_category_id_product_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_override" ADD CONSTRAINT "tax_override_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_package" ADD CONSTRAINT "ticket_package_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_package" ADD CONSTRAINT "ticket_package_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_uploaded_by_account_id_account_id_fk" FOREIGN KEY ("uploaded_by_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station" ADD CONSTRAINT "station_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_level" ADD CONSTRAINT "stock_level_stock_location_id_stock_location_id_fk" FOREIGN KEY ("stock_location_id") REFERENCES "public"."stock_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_level" ADD CONSTRAINT "stock_level_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_location" ADD CONSTRAINT "stock_location_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_line" ADD CONSTRAINT "transaction_line_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entry" ADD CONSTRAINT "wallet_entry_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wristband" ADD CONSTRAINT "wristband_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wristband" ADD CONSTRAINT "wristband_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_phone_unique" ON "account" USING btree ("operator_id","phone");--> statement-breakpoint
CREATE INDEX "account_operator_idx" ON "account" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "account_employee_idx" ON "account" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "branch_operator_idx" ON "branch" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_code_unique" ON "branch" USING btree ("operator_id","code");--> statement-breakpoint
CREATE INDEX "department_operator_idx" ON "department" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "department_branch_idx" ON "department" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "employee_operator_idx" ON "employee" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "employee_department_idx" ON "employee" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "employee_branch_idx" ON "employee" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "employee_phone_idx" ON "employee" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "role_operator_idx" ON "role" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_name_unique" ON "role" USING btree ("name");--> statement-breakpoint
CREATE INDEX "role_assignment_account_idx" ON "role_assignment" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "role_assignment_role_idx" ON "role_assignment" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignment_unique" ON "role_assignment" USING btree ("account_id","role_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "role_permission_role_idx" ON "role_permission" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permission_unique" ON "role_permission" USING btree ("role_id","permission");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_account_idx" ON "session" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verification_code_account_idx" ON "verification_code" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "child_member_idx" ON "child" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_phone_unique" ON "member" USING btree ("operator_id","phone");--> statement-breakpoint
CREATE INDEX "member_operator_idx" ON "member" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "member_phone_idx" ON "member" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "mtv_member_idx" ON "member_tier_verification" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "mtv_branch_idx" ON "member_tier_verification" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "mtv_verified_by_idx" ON "member_tier_verification" USING btree ("verified_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tier_code_unique" ON "tier" USING btree ("operator_id","code");--> statement-breakpoint
CREATE INDEX "tier_operator_idx" ON "tier" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "visit_operator_idx" ON "visit" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "visit_branch_idx" ON "visit" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "visit_member_idx" ON "visit" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "visit_date_idx" ON "visit" USING btree ("visit_date");--> statement-breakpoint
CREATE INDEX "visit_child_child_idx" ON "visit_child" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "branch_holiday_branch_idx" ON "branch_holiday" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "branch_holiday_dates_idx" ON "branch_holiday" USING btree ("starts_on","ends_on");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_tax_config_unique" ON "branch_tax_config" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "product_operator_idx" ON "product" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "product_branch_idx" ON "product" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "product_category_idx" ON "product" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "product_category_operator_idx" ON "product_category" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "tax_override_branch_idx" ON "tax_override" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "tax_override_category_idx" ON "tax_override" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "tax_override_product_idx" ON "tax_override" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "ticket_package_operator_idx" ON "ticket_package" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "ticket_package_branch_idx" ON "ticket_package" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_package_name_unique" ON "ticket_package" USING btree ("branch_id","name");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "audit_operator_idx" ON "audit_log" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "audit_branch_idx" ON "audit_log" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "file_object_owner_idx" ON "file_object" USING btree ("owner_entity_type","owner_entity_id");--> statement-breakpoint
CREATE INDEX "file_object_operator_idx" ON "file_object" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_key" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "station_branch_idx" ON "station" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "attendee_booking_idx" ON "attendee" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_branch_idx" ON "booking" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "booking_member_idx" ON "booking" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "booking_operator_idx" ON "booking" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "booking_date_idx" ON "booking" USING btree ("booking_date");--> statement-breakpoint
CREATE INDEX "item_operator_idx" ON "item" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "payment_tx_idx" ON "payment" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "stock_level_location_idx" ON "stock_level" USING btree ("stock_location_id");--> statement-breakpoint
CREATE INDEX "stock_level_item_idx" ON "stock_level" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_location_branch_idx" ON "stock_location" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "transaction_branch_idx" ON "transaction" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "transaction_member_idx" ON "transaction" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "transaction_operator_idx" ON "transaction" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "transaction_account_idx" ON "transaction" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE INDEX "transaction_line_tx_idx" ON "transaction_line" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "wallet_member_idx" ON "wallet" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "wallet_operator_idx" ON "wallet" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_wallet_idx" ON "wallet_entry" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "wristband_branch_idx" ON "wristband" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "wristband_code_idx" ON "wristband" USING btree ("code");--> statement-breakpoint
CREATE INDEX "wristband_operator_idx" ON "wristband" USING btree ("operator_id");