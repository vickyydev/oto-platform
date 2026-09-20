CREATE TYPE "public"."core_branch_scope" AS ENUM('ALL', 'SELECTED');--> statement-breakpoint
CREATE TYPE "public"."core_checkin_status" AS ENUM('registered', 'in_park', 'checked_out');--> statement-breakpoint
CREATE TYPE "public"."core_checklist_status" AS ENUM('pending', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."core_escalation_status" AS ENUM('pending', 'acknowledged', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."core_event_type" AS ENUM('birthday', 'private_event', 'school_group', 'other', 'studio_event');--> statement-breakpoint
CREATE TYPE "public"."core_issue_priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."core_issue_status" AS ENUM('open', 'in_progress', 'acknowledged', 'resolved', 'closed', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."core_question_type" AS ENUM('text', 'number', 'boolean', 'single_choice', 'multi_choice', 'photo', 'signature');--> statement-breakpoint
CREATE TYPE "public"."core_task_recurrence" AS ENUM('once', 'daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."core_task_status" AS ENUM('pending', 'in_progress', 'completed', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."core_template_question_type" AS ENUM('text', 'choice', 'boolean');--> statement-breakpoint
CREATE TYPE "public"."core_voucher_status" AS ENUM('active', 'expired', 'redeemed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."fix_report_status" AS ENUM('new', 'in_progress', 'fixed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."kb_article_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."kb_article_type" AS ENUM('SOP', 'Policy', 'Safety', 'Checklist', 'Script', 'FAQ', 'Training', 'Maintenance');--> statement-breakpoint
CREATE TYPE "public"."kb_department" AS ENUM('Front Desk', 'Cafe', 'Floor Staff', 'Cleaning', 'Maintenance', 'Birthday / Events', 'Management', 'Admin');--> statement-breakpoint
CREATE TYPE "public"."kb_role" AS ENUM('Reception', 'Barista', 'Party Host', 'Floor Staff', 'Cleaner', 'Technician', 'Supervisor', 'Manager');--> statement-breakpoint
CREATE TYPE "public"."nanny_reservation_status" AS ENUM('reserved', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."studio_booking_payment_method" AS ENUM('qr_online', 'qr_offline', 'cash', 'card', 'transfer', 'pos', 'other');--> statement-breakpoint
CREATE TYPE "public"."studio_booking_payment_status" AS ENUM('unpaid', 'partial', 'paid', 'pay_on_arrival', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."studio_booking_source_channel" AS ENUM('walkin', 'whatsapp', 'instagram', 'facebook', 'klook', 'website', 'phone', 'other');--> statement-breakpoint
CREATE TYPE "public"."studio_event_status" AS ENUM('draft', 'published', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."studio_event_task_status" AS ENUM('todo', 'doing', 'done');--> statement-breakpoint
CREATE TABLE "access_policies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" varchar NOT NULL,
	"access_level" text NOT NULL,
	"modules" jsonb NOT NULL,
	"branch_scope" text NOT NULL,
	"branch_ids" jsonb,
	"core_account_enabled" boolean DEFAULT false NOT NULL,
	"core_user_id" varchar,
	"core_account_provisioned_at" timestamp,
	"linked_to_existing_core_account" boolean DEFAULT false,
	"provisioning_status" text DEFAULT 'NOT_STARTED',
	"provisioning_last_error" text,
	"provisioning_last_attempt_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "access_policies_person_id_unique" UNIQUE("person_id")
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" varchar,
	"employee_id" varchar,
	"contract_instance_id" varchar,
	"attention_item_id" varchar,
	"template_id" varchar,
	"activity_type" text NOT NULL,
	"summary_text" text NOT NULL,
	"metadata_json" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_catalog" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attention_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" varchar,
	"employee_id" varchar,
	"contract_instance_id" varchar,
	"type" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_date" timestamp,
	"status" text DEFAULT 'open' NOT NULL,
	"rule_key" text DEFAULT '' NOT NULL,
	"entity_key" text DEFAULT '' NOT NULL,
	"fingerprint" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" varchar
);
--> statement-breakpoint
CREATE TABLE "branch_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" varchar NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_id" uuid,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"logo_url" text,
	"google_drive_folder" text,
	"google_drive_folder_name" text,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"core_branch_id" text,
	"core_sync_status" text,
	"core_synced_at" timestamp,
	"core_sync_error" text
);
--> statement-breakpoint
CREATE TABLE "contract_instances" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"template_id" varchar NOT NULL,
	"branch_id" varchar,
	"template_snapshot_html" text NOT NULL,
	"template_snapshot_version" integer NOT NULL,
	"merge_data_json" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"finalized_at" timestamp,
	"pdf_path" text,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_to_email" text,
	"sent_at" timestamp,
	"email_message_id" text,
	"signing_status" text DEFAULT 'not_sent' NOT NULL,
	"signing_token" text,
	"signing_token_expires_at" timestamp,
	"signed_at" timestamp,
	"signature_name" text,
	"signature_ip" text,
	"signed_pdf_path" text,
	"drive_file_id" text,
	"employee_signature_image" text,
	"employee_signed_name" text,
	"employee_signed_date" text,
	"employer_signature_image" text,
	"employer_signed_name" text,
	"employer_signed_title" text,
	"employer_signed_date" text,
	"policy_document_id" varchar,
	"policy_version_int" integer,
	"policy_content_hash" text,
	"policy_title_snapshot" text,
	"policy_published_at_snapshot" timestamp,
	"policy_acknowledged" boolean DEFAULT false,
	"policy_acknowledged_at" timestamp,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "coverage_rules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" varchar NOT NULL,
	"department_id" varchar,
	"day_type" text NOT NULL,
	"min_staff" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "department_branch_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" varchar
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_assets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar,
	"asset_name_snapshot" text NOT NULL,
	"catalog_asset_id" varchar,
	"quantity" integer DEFAULT 1 NOT NULL,
	"serial_number" text,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" varchar NOT NULL,
	"return_required" boolean DEFAULT true NOT NULL,
	"expected_return_by" timestamp,
	"returned_at" timestamp,
	"returned_by" varchar,
	"return_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_changes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"change_type" text NOT NULL,
	"effective_date" timestamp NOT NULL,
	"old_title" text,
	"old_salary" integer,
	"old_incentive_clause" text,
	"old_branch_id" varchar,
	"old_department_id" varchar,
	"new_title" text,
	"new_salary" integer,
	"new_incentive_clause" text,
	"new_branch_id" varchar,
	"new_department_id" varchar,
	"note" text,
	"contract_generated" boolean DEFAULT false,
	"contract_instance_id" varchar,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar,
	"document_type" text NOT NULL,
	"file_name" text NOT NULL,
	"file_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer,
	"note" text,
	"uploaded_by" varchar,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_letters" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar,
	"offboarding_id" varchar,
	"letter_type" text NOT NULL,
	"template_id" varchar,
	"status" text DEFAULT 'draft' NOT NULL,
	"finalized_at" timestamp,
	"signing_token" text,
	"signing_link_created_at" timestamp,
	"signed_at" timestamp,
	"signature_image_url" text,
	"employee_signed_name" text,
	"employee_signed_date" text,
	"rendered_html_snapshot" text,
	"rendered_pdf_url" text,
	"metadata_json" jsonb,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_offboarding" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar,
	"offboarding_type" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"notice_date" timestamp,
	"last_working_day" timestamp NOT NULL,
	"leave_public_holidays_days" integer,
	"leave_annual_days" integer,
	"leave_other_days" integer,
	"leave_other_label" text,
	"notes" text,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_payroll_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"employment_type" text DEFAULT 'MONTHLY' NOT NULL,
	"base_salary_monthly" numeric(12, 2),
	"hourly_rate" numeric(10, 2),
	"default_cost_center_id" varchar,
	"bank_account_name" text,
	"bank_account_number" text,
	"bank_name" text,
	"tax_id" text,
	"social_security_number" text,
	"social_security_enabled" boolean DEFAULT true NOT NULL,
	"tax_withholding_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_payroll_profiles_employee_id_unique" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "employee_presence" (
	"employee_id" varchar PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"is_clocked_in" boolean DEFAULT false NOT NULL,
	"current_work_branch_id" varchar,
	"last_in_at" timestamp,
	"last_out_at" timestamp,
	"last_event_at" timestamp,
	"last_event_type" varchar(10),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_roles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"role_id" varchar NOT NULL,
	"proficiency_level" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_time_off" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"type" text NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp NOT NULL,
	"note" text,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" varchar,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"address" text,
	"branch_id" varchar,
	"status" text DEFAULT 'active' NOT NULL,
	"employment_state" text DEFAULT 'ACTIVE' NOT NULL,
	"offboarding_type" text,
	"notice_date" timestamp,
	"default_merge_data" jsonb,
	"incentive_clause_text" text,
	"food_allowance_per_day" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"start_date" timestamp,
	"probation_days" integer,
	"probation_end_date" timestamp,
	"probation_review_completed_at" timestamp,
	"end_reason" text,
	"last_working_day" timestamp,
	"resignation_form_path" text,
	"termination_letter_path" text,
	"nationality" text,
	"is_foreign_staff" boolean DEFAULT false,
	"visa_expiry_date" timestamp,
	"work_permit_expiry_date" timestamp,
	"sso_number" text,
	"tax_id_number" text,
	"visa_wp_company_handles" boolean,
	"visa_wp_company_pays" boolean,
	"visa_wp_cost_thb" integer,
	"visa_wp_repayment_if_fail_probation" boolean,
	"visa_wp_repayment_if_leave_before_1y" boolean,
	"visa_wp_repayment_terms_text" text,
	"visa_wp_notes" text,
	"job_description" text,
	"face_enrollment_status" text DEFAULT 'NOT_ENROLLED',
	"face_id" text,
	"face_enrolled_at" timestamp,
	"timeclock_pin_hash" text,
	"timeclock_pin_set_at" timestamp,
	"timeclock_pin_required" boolean DEFAULT true,
	"pin_usage_count_30day" integer DEFAULT 0,
	"pin_usage_count_reset_at" timestamp,
	"profile_photo_path" text,
	"profile_photo_captured_at" timestamp,
	"profile_photo_source" text,
	"profile_photo_updated_by" varchar,
	"primary_department_id" varchar,
	"display_order" integer DEFAULT 0 NOT NULL,
	"weekly_off_days" integer[] DEFAULT '{}',
	"user_id" varchar,
	CONSTRAINT "employees_person_id_unique" UNIQUE("person_id")
);
--> statement-breakpoint
CREATE TABLE "enrollment_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"original_filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_auth_attempts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" varchar,
	"branch_id" varchar NOT NULL,
	"kiosk_device_id" varchar,
	"attempt_time" timestamp DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"outcome" text NOT NULL,
	"fail_reason" text,
	"confidence_score" integer,
	"liveness_score" integer,
	"photo_evidence_url" text,
	"session_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_devices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" varchar NOT NULL,
	"name" text NOT NULL,
	"device_secret_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_policies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" varchar,
	"name" varchar(100) NOT NULL,
	"description" text,
	"days_worked_required" integer DEFAULT 5 NOT NULL,
	"days_off_earned" integer DEFAULT 2 NOT NULL,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offboarding_checklist" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offboarding_id" varchar NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar,
	"checklist_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"completed_by" varchar,
	"due_date" timestamp,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_day_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"work_date" date NOT NULL,
	"scheduled_minutes" integer DEFAULT 0 NOT NULL,
	"actual_minutes" integer DEFAULT 0 NOT NULL,
	"scheduled_pay" numeric(12, 2) DEFAULT '0' NOT NULL,
	"actual_pay" numeric(12, 2) DEFAULT '0' NOT NULL,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"variance_minutes" integer DEFAULT 0 NOT NULL,
	"variance_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"flags" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_employee_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"gross_pay" numeric(12, 2) DEFAULT '0' NOT NULL,
	"taxable_income" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_deductions" numeric(12, 2) DEFAULT '0' NOT NULL,
	"net_pay" numeric(12, 2) DEFAULT '0' NOT NULL,
	"employer_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_exception_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_exception_id" uuid NOT NULL,
	"approver_id" varchar NOT NULL,
	"role" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar,
	"work_date" date,
	"exception_type" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"required_approver_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"line_type" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 4),
	"rate" numeric(12, 4),
	"amount" numeric(12, 2) NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"statutory" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"country_code" text DEFAULT 'TH' NOT NULL,
	"period_type" text DEFAULT 'MONTHLY' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"cutoff_at" timestamp with time zone,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" varchar,
	"finalized_by" varchar,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_policy_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"variance_minutes_threshold" integer DEFAULT 15 NOT NULL,
	"variance_amount_threshold" numeric(12, 2) DEFAULT '100' NOT NULL,
	"ot_requires_approval" boolean DEFAULT true NOT NULL,
	"rounding_rule" text DEFAULT 'NONE' NOT NULL,
	"unpaid_break_minutes_default" integer DEFAULT 0 NOT NULL,
	"max_advance_deduction_percent_of_net" numeric(5, 4) DEFAULT '0.30' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_policy_settings_operator_id_unique" UNIQUE("operator_id")
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_period_id" uuid NOT NULL,
	"run_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"created_by" varchar,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"payroll_period_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"slip_number" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"pdf_url" text,
	"slip_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"preferred_name" text,
	"email" text NOT NULL,
	"person_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"timeclock_pin_hash" text,
	"timeclock_pin_fingerprint" text,
	"timeclock_pin_set_at" timestamp,
	"timeclock_pin_required" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "people_email_unique" UNIQUE("email"),
	CONSTRAINT "people_timeclock_pin_fingerprint_unique" UNIQUE("timeclock_pin_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "policy_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content_html" text,
	"pdf_file_url" text,
	"version_int" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp,
	"content_hash" text,
	"is_company_wide" boolean DEFAULT true NOT NULL,
	"branch_id" varchar,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_holidays" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"date" date NOT NULL,
	"year" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_branch_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" varchar
);
--> statement-breakpoint
CREATE TABLE "role_department_map" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" varchar NOT NULL,
	"department_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "salary_advance_repayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"salary_advance_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"remaining_balance_after" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"principal_amount" numeric(12, 2) NOT NULL,
	"issued_date" date NOT NULL,
	"repayment_start_period_id" uuid,
	"repayment_type" text NOT NULL,
	"repayment_amount" numeric(12, 2),
	"repayment_months" integer,
	"percent_of_net" numeric(5, 4),
	"max_percent_of_net_cap" numeric(5, 4) DEFAULT '0.30',
	"remaining_balance" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"week_plan_id" varchar NOT NULL,
	"shift_row_id" varchar NOT NULL,
	"shift_date" date NOT NULL,
	"employee_id" varchar NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" varchar,
	"is_borrowed" boolean DEFAULT false NOT NULL,
	"borrowed_from_branch_id" varchar
);
--> statement-breakpoint
CREATE TABLE "schedule_shift_row_roles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shift_row_id" varchar NOT NULL,
	"role_id" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_shift_rows" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"department_id" varchar NOT NULL,
	"week_plan_id" varchar NOT NULL,
	"row_order" integer DEFAULT 0 NOT NULL,
	"label" text,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"note" text,
	"staff_required" integer DEFAULT 1 NOT NULL,
	"staff_required_by_day" jsonb,
	"color_index" integer,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_template_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_row_id" varchar NOT NULL,
	"day_of_week" integer NOT NULL,
	"employee_id" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_template_row_roles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_row_id" varchar NOT NULL,
	"role_id" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_template_rows" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" varchar NOT NULL,
	"department_id" varchar NOT NULL,
	"row_order" integer DEFAULT 0 NOT NULL,
	"label" text,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"staff_required" integer DEFAULT 1 NOT NULL,
	"staff_required_by_day" jsonb,
	"color_index" integer
);
--> statement-breakpoint
CREATE TABLE "schedule_template_time_off" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" varchar NOT NULL,
	"day_of_week" integer NOT NULL,
	"employee_id" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"name" text NOT NULL,
	"source_week_plan_id" varchar,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_week_plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"week_start_date" date NOT NULL,
	"name" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "shift_required_roles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shift_id" varchar NOT NULL,
	"role_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"department_id" varchar NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"employee_id" varchar,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"notes" text,
	"needs_coverage" boolean DEFAULT false NOT NULL,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sick_leave_policies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar,
	"annual_sick_leave_days" integer DEFAULT 30 NOT NULL,
	"pro_rate_by_start_date" boolean DEFAULT true NOT NULL,
	"year_start_month" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statutory_calculation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"country_code" text NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statutory_rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_id" uuid,
	"branch_id" uuid,
	"country_code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"rules" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"is_default_for_branch" boolean DEFAULT false NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" varchar
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"html_body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"template_type" text DEFAULT 'employment' NOT NULL,
	"forked_from_template_id" varchar,
	"header_show_logo" boolean DEFAULT true NOT NULL,
	"header_show_address" boolean DEFAULT true NOT NULL,
	"header_alignment" text DEFAULT 'left' NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "time_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"work_date" date NOT NULL,
	"adjustment_type" text NOT NULL,
	"before_payload" jsonb,
	"after_payload" jsonb,
	"reason" text,
	"requested_by" varchar NOT NULL,
	"approved_by" varchar,
	"approved_at" timestamp with time zone,
	"approval_status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"shift_date" varchar NOT NULL,
	"scheduled_start_at" timestamp,
	"scheduled_end_at" timestamp,
	"clock_in_at" timestamp,
	"clock_out_at" timestamp,
	"status" text DEFAULT 'RAW' NOT NULL,
	"source_in" text,
	"source_out" text,
	"created_by" varchar,
	"approved_by" varchar,
	"approved_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"event_time" timestamp NOT NULL,
	"auth_method" text DEFAULT 'FACE' NOT NULL,
	"confidence_score" integer,
	"liveness_score" integer,
	"photo_evidence_url" text,
	"kiosk_device_id" varchar,
	"notes" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timekeeping_issues" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"issue_date" varchar NOT NULL,
	"issue_type" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"linked_time_entry_id" varchar,
	"suggested_clock_in_at" timestamp,
	"suggested_clock_out_at" timestamp,
	"user_proposed_clock_in_at" timestamp,
	"user_proposed_clock_out_at" timestamp,
	"reason_code" text,
	"note" text,
	"created_by" varchar,
	"resolved_by" varchar,
	"resolved_at" timestamp,
	"resolution_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_branch_access" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"branch_id" varchar,
	"access_scope" text DEFAULT 'selected_branches' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"full_name" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"operator_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"created_by" varchar,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "checklist_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"template_item_id" uuid NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"response" jsonb,
	"photo_url" text,
	"completed_by" varchar,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"assigned_to" varchar,
	"status" "core_checklist_status" DEFAULT 'pending',
	"started_at" timestamp,
	"completed_at" timestamp,
	"due_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"requires_note" boolean DEFAULT false,
	"requires_photo" boolean DEFAULT false,
	"is_critical" boolean DEFAULT false,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar,
	"department_id" varchar,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"recurrence" "core_task_recurrence" DEFAULT 'once',
	"scheduled_time" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"event_type" "core_event_type" DEFAULT 'birthday' NOT NULL,
	"title" text NOT NULL,
	"event_date" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text,
	"duration_minutes" integer,
	"child_name" text,
	"booking_name" text,
	"parent_name" text,
	"whatsapp_phone_raw" text,
	"whatsapp_phone_e164" text,
	"whatsapp_parse_valid" boolean DEFAULT true,
	"whatsapp_parse_error" text,
	"num_children" integer,
	"num_adults" integer,
	"program_name" text,
	"program_details" text,
	"allergies_notes" text,
	"cake_notes" text,
	"special_requests" text,
	"internal_staff_notes" text,
	"total_value" integer,
	"prepayment_amount" integer,
	"prepayment_date" text,
	"prepayment_method" text,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar,
	"updated_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "directory_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"cache_key" text NOT NULL,
	"cache_data" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dropoff_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"parent_full_name" text NOT NULL,
	"whatsapp_phone" text NOT NULL,
	"children" jsonb NOT NULL,
	"has_allergies_or_medical" boolean DEFAULT false NOT NULL,
	"allergies_medical_details" text,
	"allow_staff_order_food" boolean DEFAULT false NOT NULL,
	"food_notes_restrictions" text,
	"photo_url" text NOT NULL,
	"signature_url" text,
	"status" text DEFAULT 'in' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"picked_up_at" timestamp,
	"picked_up_by" varchar,
	"out_photo_url" text,
	"out_signed_name" text,
	"staff_notes" text,
	"edit_log" jsonb
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"escalated_to" varchar NOT NULL,
	"escalated_by" varchar NOT NULL,
	"status" "core_escalation_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"acknowledged_at" timestamp,
	"resolved_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"reported_by" varchar NOT NULL,
	"reported_by_name" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"location" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"status" "fix_report_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"department_id" varchar,
	"title" text NOT NULL,
	"description" text,
	"status" "core_issue_status" DEFAULT 'open' NOT NULL,
	"priority" "core_issue_priority" DEFAULT 'medium' NOT NULL,
	"category" text,
	"photo_urls" jsonb,
	"reported_by" varchar,
	"assigned_to" varchar,
	"resolved_by" varchar,
	"resolved_at" timestamp,
	"resolution_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"content" text,
	"quick_answer" jsonb,
	"departments" text[],
	"roles" text[],
	"tags" text[],
	"branch_scope" text NOT NULL,
	"branch_ids" jsonb,
	"published_by" varchar,
	"published_by_name" text,
	"published_at" timestamp DEFAULT now() NOT NULL,
	"change_notes" text
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"type" "kb_article_type" DEFAULT 'SOP' NOT NULL,
	"content" text,
	"quick_answer" jsonb,
	"departments" text[] DEFAULT ARRAY[]::text[],
	"roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[],
	"branch_scope" "core_branch_scope" DEFAULT 'ALL' NOT NULL,
	"branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "kb_article_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_id" varchar,
	"owner_name" text,
	"last_reviewed_at" timestamp,
	"published_at" timestamp,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"embedding_status" text DEFAULT 'pending',
	"embedding_updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "module_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"quiz_attempt_id" uuid,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nanny_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"nanny_employee_id" varchar NOT NULL,
	"nanny_full_name" text NOT NULL,
	"service_checkin_id" uuid,
	"child_full_name" text,
	"parent_full_name" text,
	"reservation_date" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"status" "nanny_reservation_status" DEFAULT 'reserved' NOT NULL,
	"reserved_by_user_id" varchar,
	"reserved_at" timestamp DEFAULT now() NOT NULL,
	"activated_at" timestamp,
	"completed_at" timestamp,
	"cancelled_at" timestamp,
	"cancellation_reason" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"responses" jsonb,
	"score" real,
	"passed" boolean,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"question" text NOT NULL,
	"options" text[] NOT NULL,
	"correct_answer" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"service_type" text,
	"parent_full_name" text NOT NULL,
	"whatsapp_phone_raw" text NOT NULL,
	"whatsapp_phone_e164" text,
	"child_full_name" text NOT NULL,
	"child_age" integer,
	"allergies_medical_details" text,
	"food_notes_restrictions" text,
	"staff_notes" text,
	"photo_url" text,
	"requested_duration_minutes" integer,
	"requested_end_at" timestamp,
	"nanny_employee_id" varchar,
	"nanny_assigned" text,
	"nanny_assigned_by_user_id" varchar,
	"nanny_assigned_at" timestamp,
	"consent_signed" boolean DEFAULT false,
	"consent_signature" text,
	"consent_signed_name" text,
	"consent_signed_at" timestamp,
	"registered_at" timestamp DEFAULT now() NOT NULL,
	"checked_in_at" timestamp,
	"checked_in_by" varchar,
	"checked_out_at" timestamp,
	"checked_out_by" varchar,
	"out_photo_url" text,
	"out_signed_name" text,
	"out_signature" text,
	"edit_log" jsonb,
	"customer_name" text,
	"customer_phone" text,
	"notes" text,
	"estimated_duration" integer,
	"service_started_at" timestamp,
	"service_completed_at" timestamp,
	"served_by" varchar
);
--> statement-breakpoint
CREATE TABLE "sop_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"departments" text[] DEFAULT ARRAY['general']::text[],
	"last_updated" timestamp DEFAULT now(),
	"reading_time" integer DEFAULT 3,
	"cover_image_url" text,
	"summary" text,
	"steps" jsonb,
	"rules" jsonb,
	"common_mistakes" jsonb,
	"unsure_tips" jsonb,
	"scope" text DEFAULT 'GLOBAL' NOT NULL,
	"branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_event_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_name" text NOT NULL,
	"whatsapp_phone" text,
	"source_channel" "studio_booking_source_channel",
	"adults_count" integer DEFAULT 0 NOT NULL,
	"kids_count" integer DEFAULT 0 NOT NULL,
	"adult_names" text,
	"kid_names" text,
	"amount_total" real DEFAULT 0 NOT NULL,
	"amount_paid" real DEFAULT 0 NOT NULL,
	"payment_status" "studio_booking_payment_status" DEFAULT 'unpaid' NOT NULL,
	"payment_method" "studio_booking_payment_method",
	"payment_date" text,
	"pos_reference" text,
	"internal_notes" text,
	"arrived" boolean DEFAULT false NOT NULL,
	"arrived_at" timestamp,
	"custom_field_values" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_event_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"concept" text,
	"fnb_details" text,
	"notes" text,
	"description" text,
	"location" text,
	"max_participants" integer,
	"custom_info" jsonb,
	"studio_status" "studio_event_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "studio_event_details_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "studio_event_form_schema" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"schema_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "studio_event_form_schema_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "studio_event_info_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_event_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_time" varchar(10),
	"due_datetime" timestamp,
	"department_id" varchar,
	"assigned_to_user_id" varchar,
	"requires_photo_evidence" boolean DEFAULT false NOT NULL,
	"requires_questions_answered" boolean DEFAULT false NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"status" "studio_event_task_status" DEFAULT 'todo' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"completed_by" varchar NOT NULL,
	"responses" jsonb,
	"photo_urls" jsonb,
	"note" text,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"question_type" "core_question_type" DEFAULT 'text',
	"options" text[],
	"is_required" boolean DEFAULT true,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_template_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"question_type" "core_template_question_type" DEFAULT 'text' NOT NULL,
	"options" text[],
	"is_required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"branch_scope" "core_branch_scope" DEFAULT 'ALL' NOT NULL,
	"branch_ids" jsonb DEFAULT '[]'::jsonb,
	"department_id" varchar,
	"recurrence" "core_task_recurrence" DEFAULT 'once' NOT NULL,
	"preferred_due_time" text,
	"requires_photo_evidence" boolean DEFAULT false NOT NULL,
	"requires_responses" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid,
	"generated_for_date" text,
	"event_id" uuid,
	"branch_id" varchar,
	"department_id" varchar,
	"title" text NOT NULL,
	"description" text,
	"status" "core_task_status" DEFAULT 'pending' NOT NULL,
	"priority" "core_issue_priority" DEFAULT 'medium' NOT NULL,
	"recurrence" "core_task_recurrence" DEFAULT 'once' NOT NULL,
	"due_at" timestamp,
	"assigned_to" varchar,
	"requires_photo_evidence" boolean DEFAULT false NOT NULL,
	"requires_responses" boolean DEFAULT false NOT NULL,
	"reference_photo_url" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar,
	"department_id" varchar,
	"title" text NOT NULL,
	"description" text,
	"content" text,
	"video_url" text,
	"duration_minutes" integer,
	"passing_score" real DEFAULT 70,
	"is_active" boolean DEFAULT true NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"scope" text DEFAULT 'GLOBAL' NOT NULL,
	"branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "troubleshooting_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar,
	"department_id" varchar,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"root_node_id" uuid,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "troubleshooting_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"is_start" boolean DEFAULT false,
	"is_resolution" boolean DEFAULT false,
	"is_escalation" boolean DEFAULT false,
	"options" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar,
	"user_id" varchar,
	"template_id" uuid,
	"token" text NOT NULL,
	"remaining_uses" integer NOT NULL,
	"status" "core_voucher_status" DEFAULT 'active' NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"last_redeemed_at" timestamp,
	"valid_from_override" timestamp,
	"valid_to_override" timestamp,
	"notes" text,
	"custom_image_url" text,
	CONSTRAINT "user_vouchers_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "voucher_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"branch_id" varchar,
	"redeemed_by" varchar NOT NULL,
	"notes" text,
	"redeemed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voucher_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar,
	"name" text NOT NULL,
	"image_url" text NOT NULL,
	"description" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"valid_from" timestamp,
	"valid_to" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar
);
--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_contract_instance_id_contract_instances_id_fk" FOREIGN KEY ("contract_instance_id") REFERENCES "public"."contract_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_contract_instance_id_contract_instances_id_fk" FOREIGN KEY ("contract_instance_id") REFERENCES "public"."contract_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_events" ADD CONSTRAINT "branch_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_events" ADD CONSTRAINT "branch_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_policy_document_id_policy_documents_id_fk" FOREIGN KEY ("policy_document_id") REFERENCES "public"."policy_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_rules" ADD CONSTRAINT "coverage_rules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_rules" ADD CONSTRAINT "coverage_rules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_branch_assignments" ADD CONSTRAINT "department_branch_assignments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_branch_assignments" ADD CONSTRAINT "department_branch_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_branch_assignments" ADD CONSTRAINT "department_branch_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_catalog_asset_id_asset_catalog_id_fk" FOREIGN KEY ("catalog_asset_id") REFERENCES "public"."asset_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_old_branch_id_branches_id_fk" FOREIGN KEY ("old_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_old_department_id_departments_id_fk" FOREIGN KEY ("old_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_new_branch_id_branches_id_fk" FOREIGN KEY ("new_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_new_department_id_departments_id_fk" FOREIGN KEY ("new_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_contract_instance_id_contract_instances_id_fk" FOREIGN KEY ("contract_instance_id") REFERENCES "public"."contract_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_offboarding_id_employee_offboarding_id_fk" FOREIGN KEY ("offboarding_id") REFERENCES "public"."employee_offboarding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_offboarding" ADD CONSTRAINT "employee_offboarding_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_offboarding" ADD CONSTRAINT "employee_offboarding_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_offboarding" ADD CONSTRAINT "employee_offboarding_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_profiles" ADD CONSTRAINT "employee_payroll_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_profiles" ADD CONSTRAINT "employee_payroll_profiles_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_profiles" ADD CONSTRAINT "employee_payroll_profiles_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_presence" ADD CONSTRAINT "employee_presence_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_presence" ADD CONSTRAINT "employee_presence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_presence" ADD CONSTRAINT "employee_presence_current_work_branch_id_branches_id_fk" FOREIGN KEY ("current_work_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_roles" ADD CONSTRAINT "employee_roles_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_roles" ADD CONSTRAINT "employee_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_profile_photo_updated_by_users_id_fk" FOREIGN KEY ("profile_photo_updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_sessions" ADD CONSTRAINT "enrollment_sessions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_sessions" ADD CONSTRAINT "enrollment_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_auth_attempts" ADD CONSTRAINT "kiosk_auth_attempts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_auth_attempts" ADD CONSTRAINT "kiosk_auth_attempts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_auth_attempts" ADD CONSTRAINT "kiosk_auth_attempts_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_offboarding_id_employee_offboarding_id_fk" FOREIGN KEY ("offboarding_id") REFERENCES "public"."employee_offboarding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_day_reconciliations" ADD CONSTRAINT "payroll_day_reconciliations_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_day_reconciliations" ADD CONSTRAINT "payroll_day_reconciliations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_day_reconciliations" ADD CONSTRAINT "payroll_day_reconciliations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employee_summaries" ADD CONSTRAINT "payroll_employee_summaries_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employee_summaries" ADD CONSTRAINT "payroll_employee_summaries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exception_approvals" ADD CONSTRAINT "payroll_exception_approvals_payroll_exception_id_payroll_exceptions_id_fk" FOREIGN KEY ("payroll_exception_id") REFERENCES "public"."payroll_exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exception_approvals" ADD CONSTRAINT "payroll_exception_approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy_settings" ADD CONSTRAINT "payroll_policy_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy_settings" ADD CONSTRAINT "payroll_policy_settings_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_payroll_period_id_payroll_periods_id_fk" FOREIGN KEY ("payroll_period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_period_id_payroll_periods_id_fk" FOREIGN KEY ("payroll_period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_branch_assignments" ADD CONSTRAINT "role_branch_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_branch_assignments" ADD CONSTRAINT "role_branch_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_branch_assignments" ADD CONSTRAINT "role_branch_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_department_map" ADD CONSTRAINT "role_department_map_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_department_map" ADD CONSTRAINT "role_department_map_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advance_repayments" ADD CONSTRAINT "salary_advance_repayments_salary_advance_id_salary_advances_id_fk" FOREIGN KEY ("salary_advance_id") REFERENCES "public"."salary_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advance_repayments" ADD CONSTRAINT "salary_advance_repayments_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advance_repayments" ADD CONSTRAINT "salary_advance_repayments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_repayment_start_period_id_payroll_periods_id_fk" FOREIGN KEY ("repayment_start_period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_week_plan_id_schedule_week_plans_id_fk" FOREIGN KEY ("week_plan_id") REFERENCES "public"."schedule_week_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_shift_row_id_schedule_shift_rows_id_fk" FOREIGN KEY ("shift_row_id") REFERENCES "public"."schedule_shift_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_borrowed_from_branch_id_branches_id_fk" FOREIGN KEY ("borrowed_from_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_row_roles" ADD CONSTRAINT "schedule_shift_row_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_row_roles" ADD CONSTRAINT "schedule_shift_row_roles_shift_row_id_schedule_shift_rows_id_fk" FOREIGN KEY ("shift_row_id") REFERENCES "public"."schedule_shift_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_row_roles" ADD CONSTRAINT "schedule_shift_row_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_week_plan_id_schedule_week_plans_id_fk" FOREIGN KEY ("week_plan_id") REFERENCES "public"."schedule_week_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_assignments" ADD CONSTRAINT "schedule_template_assignments_template_row_id_schedule_template_rows_id_fk" FOREIGN KEY ("template_row_id") REFERENCES "public"."schedule_template_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_assignments" ADD CONSTRAINT "schedule_template_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_row_roles" ADD CONSTRAINT "schedule_template_row_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_row_roles" ADD CONSTRAINT "schedule_template_row_roles_template_row_id_schedule_template_rows_id_fk" FOREIGN KEY ("template_row_id") REFERENCES "public"."schedule_template_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_row_roles" ADD CONSTRAINT "schedule_template_row_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_rows" ADD CONSTRAINT "schedule_template_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_rows" ADD CONSTRAINT "schedule_template_rows_template_id_schedule_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."schedule_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_rows" ADD CONSTRAINT "schedule_template_rows_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_time_off" ADD CONSTRAINT "schedule_template_time_off_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_time_off" ADD CONSTRAINT "schedule_template_time_off_template_id_schedule_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."schedule_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_time_off" ADD CONSTRAINT "schedule_template_time_off_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_source_week_plan_id_schedule_week_plans_id_fk" FOREIGN KEY ("source_week_plan_id") REFERENCES "public"."schedule_week_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_week_plans" ADD CONSTRAINT "schedule_week_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_week_plans" ADD CONSTRAINT "schedule_week_plans_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_week_plans" ADD CONSTRAINT "schedule_week_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_required_roles" ADD CONSTRAINT "shift_required_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_required_roles" ADD CONSTRAINT "shift_required_roles_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_required_roles" ADD CONSTRAINT "shift_required_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_policies" ADD CONSTRAINT "sick_leave_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_policies" ADD CONSTRAINT "sick_leave_policies_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_calculation_results" ADD CONSTRAINT "statutory_calculation_results_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_calculation_results" ADD CONSTRAINT "statutory_calculation_results_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "public"."kiosk_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_linked_time_entry_id_time_entries_id_fk" FOREIGN KEY ("linked_time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_run_id_checklist_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."checklist_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_template_item_id_checklist_template_items_id_fk" FOREIGN KEY ("template_item_id") REFERENCES "public"."checklist_template_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_cache" ADD CONSTRAINT "directory_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_cache" ADD CONSTRAINT "directory_cache_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_checkins" ADD CONSTRAINT "dropoff_checkins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_checkins" ADD CONSTRAINT "dropoff_checkins_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_checkins" ADD CONSTRAINT "dropoff_checkins_picked_up_by_users_id_fk" FOREIGN KEY ("picked_up_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_escalated_to_users_id_fk" FOREIGN KEY ("escalated_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_escalated_by_users_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_statuses" ADD CONSTRAINT "event_statuses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_module_id_training_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."training_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_quiz_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("quiz_attempt_id") REFERENCES "public"."quiz_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_nanny_employee_id_employees_id_fk" FOREIGN KEY ("nanny_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_service_checkin_id_service_checkins_id_fk" FOREIGN KEY ("service_checkin_id") REFERENCES "public"."service_checkins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_reserved_by_user_id_users_id_fk" FOREIGN KEY ("reserved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_module_id_training_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."training_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_module_id_training_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."training_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_nanny_employee_id_employees_id_fk" FOREIGN KEY ("nanny_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_nanny_assigned_by_user_id_users_id_fk" FOREIGN KEY ("nanny_assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_checked_out_by_users_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_served_by_users_id_fk" FOREIGN KEY ("served_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_articles" ADD CONSTRAINT "sop_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_bookings" ADD CONSTRAINT "studio_event_bookings_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_details" ADD CONSTRAINT "studio_event_details_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_form_schema" ADD CONSTRAINT "studio_event_form_schema_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_info_blocks" ADD CONSTRAINT "studio_event_info_blocks_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_template_questions" ADD CONSTRAINT "task_template_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_template_questions" ADD CONSTRAINT "task_template_questions_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."core_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_nodes" ADD CONSTRAINT "troubleshooting_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_nodes" ADD CONSTRAINT "troubleshooting_nodes_flow_id_troubleshooting_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."troubleshooting_flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_template_id_voucher_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."voucher_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucher_id_user_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."user_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_templates" ADD CONSTRAINT "voucher_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_templates" ADD CONSTRAINT "voucher_templates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_templates" ADD CONSTRAINT "voucher_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_access_policies_tenant" ON "access_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_branch_events_branch" ON "branch_events" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_branch_events_start_time" ON "branch_events" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "idx_branch_events_branch_time" ON "branch_events" USING btree ("branch_id","start_time");--> statement-breakpoint
CREATE INDEX "idx_branches_tenant" ON "branches" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_branches_operator" ON "branches" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_departments_tenant" ON "departments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_employee_payroll_profiles_tenant" ON "employee_payroll_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_employee_payroll_profiles_operator" ON "employee_payroll_profiles" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_employee_payroll_profiles_employee" ON "employee_payroll_profiles" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_employee_presence_tenant" ON "employee_presence" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_time_off_tenant" ON "employee_time_off" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_time_off_employee_dates" ON "employee_time_off" USING btree ("employee_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "idx_time_off_branch_dates" ON "employee_time_off" USING btree ("branch_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "idx_employees_tenant" ON "employees" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_employees_user" ON "employees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_files_tenant_created" ON "files" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_operators_tenant" ON "operators" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_operators_status" ON "operators" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_payroll_reconciliations_run" ON "payroll_day_reconciliations" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_reconciliations_employee" ON "payroll_day_reconciliations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_reconciliations_date" ON "payroll_day_reconciliations" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX "idx_payroll_employee_summaries_run" ON "payroll_employee_summaries" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_employee_summaries_employee" ON "payroll_employee_summaries" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_exception_approvals_exception" ON "payroll_exception_approvals" USING btree ("payroll_exception_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_exceptions_run" ON "payroll_exceptions" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_exceptions_employee" ON "payroll_exceptions" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_exceptions_status" ON "payroll_exceptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_payroll_line_items_run" ON "payroll_line_items" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_line_items_employee" ON "payroll_line_items" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_line_items_code" ON "payroll_line_items" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_payroll_periods_tenant" ON "payroll_periods" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_periods_operator" ON "payroll_periods" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_periods_dates" ON "payroll_periods" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "idx_payroll_policy_settings_tenant" ON "payroll_policy_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_policy_settings_operator" ON "payroll_policy_settings" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_runs_period" ON "payroll_runs" USING btree ("payroll_period_id");--> statement-breakpoint
CREATE INDEX "idx_payslips_run" ON "payslips" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "idx_payslips_employee" ON "payslips" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_payslips_slip_number" ON "payslips" USING btree ("slip_number");--> statement-breakpoint
CREATE INDEX "idx_public_holidays_tenant" ON "public_holidays" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_public_holidays_year" ON "public_holidays" USING btree ("year");--> statement-breakpoint
CREATE INDEX "idx_public_holidays_date" ON "public_holidays" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_roles_tenant" ON "roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_salary_advance_repayments_advance" ON "salary_advance_repayments" USING btree ("salary_advance_id");--> statement-breakpoint
CREATE INDEX "idx_salary_advance_repayments_run" ON "salary_advance_repayments" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "idx_salary_advances_tenant" ON "salary_advances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_salary_advances_operator" ON "salary_advances" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_salary_advances_employee" ON "salary_advances" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_salary_advances_status" ON "salary_advances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_schedule_assignments_tenant" ON "schedule_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_assignments_shift_date" ON "schedule_assignments" USING btree ("shift_row_id","shift_date");--> statement-breakpoint
CREATE INDEX "idx_assignments_employee_date" ON "schedule_assignments" USING btree ("employee_id","shift_date");--> statement-breakpoint
CREATE INDEX "idx_assignments_week_plan" ON "schedule_assignments" USING btree ("week_plan_id");--> statement-breakpoint
CREATE INDEX "idx_assignments_borrowed" ON "schedule_assignments" USING btree ("is_borrowed");--> statement-breakpoint
CREATE INDEX "idx_schedule_shift_row_roles_tenant" ON "schedule_shift_row_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shift_row_roles_shift" ON "schedule_shift_row_roles" USING btree ("shift_row_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_shift_rows_tenant" ON "schedule_shift_rows" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shift_rows_week_plan" ON "schedule_shift_rows" USING btree ("week_plan_id","department_id");--> statement-breakpoint
CREATE INDEX "idx_template_assignments_row" ON "schedule_template_assignments" USING btree ("template_row_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_template_row_roles_tenant" ON "schedule_template_row_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_template_row_roles_row" ON "schedule_template_row_roles" USING btree ("template_row_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_template_rows_tenant" ON "schedule_template_rows" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_template_rows_template" ON "schedule_template_rows" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_template_time_off_template" ON "schedule_template_time_off" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_template_time_off_tenant" ON "schedule_template_time_off" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_templates_tenant" ON "schedule_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_templates_branch" ON "schedule_templates" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_week_plans_tenant" ON "schedule_week_plans" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_week_plans_branch_week" ON "schedule_week_plans" USING btree ("branch_id","week_start_date");--> statement-breakpoint
CREATE INDEX "idx_shift_required_roles_tenant" ON "shift_required_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shifts_tenant" ON "shifts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shifts_branch_date" ON "shifts" USING btree ("branch_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_shifts_employee_date" ON "shifts" USING btree ("employee_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_sick_leave_policies_tenant" ON "sick_leave_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sick_leave_policies_branch" ON "sick_leave_policies" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_statutory_results_run" ON "statutory_calculation_results" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "idx_statutory_results_employee" ON "statutory_calculation_results" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_statutory_rule_sets_tenant" ON "statutory_rule_sets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_statutory_rule_sets_operator" ON "statutory_rule_sets" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_statutory_rule_sets_branch" ON "statutory_rule_sets" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_statutory_rule_sets_country" ON "statutory_rule_sets" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "idx_statutory_rule_sets_effective" ON "statutory_rule_sets" USING btree ("effective_from");--> statement-breakpoint
CREATE INDEX "idx_statutory_rule_sets_status" ON "statutory_rule_sets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_time_adjustments_tenant" ON "time_adjustments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_time_adjustments_employee" ON "time_adjustments" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_time_adjustments_date" ON "time_adjustments" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX "idx_time_entries_tenant" ON "time_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_time_entries_employee_date" ON "time_entries" USING btree ("employee_id","shift_date");--> statement-breakpoint
CREATE INDEX "idx_time_entries_branch_date" ON "time_entries" USING btree ("branch_id","shift_date");--> statement-breakpoint
CREATE INDEX "idx_time_entries_status" ON "time_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_time_events_tenant" ON "time_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_time_events_employee_time" ON "time_events" USING btree ("employee_id","event_time");--> statement-breakpoint
CREATE INDEX "idx_time_events_branch_time" ON "time_events" USING btree ("branch_id","event_time");--> statement-breakpoint
CREATE INDEX "idx_time_events_event_time" ON "time_events" USING btree ("event_time");--> statement-breakpoint
CREATE INDEX "idx_timekeeping_issues_tenant" ON "timekeeping_issues" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_timekeeping_issues_employee_date" ON "timekeeping_issues" USING btree ("employee_id","issue_date");--> statement-breakpoint
CREATE INDEX "idx_timekeeping_issues_branch_date" ON "timekeeping_issues" USING btree ("branch_id","issue_date");--> statement-breakpoint
CREATE INDEX "idx_timekeeping_issues_status" ON "timekeeping_issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_user_branch_access_tenant" ON "user_branch_access" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_users_operator" ON "users" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_users_username" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_checklist_run_items_tenant" ON "checklist_run_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_run_items_run" ON "checklist_run_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_runs_tenant" ON "checklist_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_runs_branch" ON "checklist_runs" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_runs_assigned" ON "checklist_runs" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_checklist_template_items_tenant" ON "checklist_template_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_template_items_template" ON "checklist_template_items" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_tenant" ON "checklist_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_branch" ON "checklist_templates" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_core_events_tenant" ON "core_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_core_events_branch" ON "core_events" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_core_events_date" ON "core_events" USING btree ("event_date");--> statement-breakpoint
CREATE INDEX "idx_directory_cache_tenant" ON "directory_cache" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_directory_cache_branch_key" ON "directory_cache" USING btree ("branch_id","cache_key");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_tenant" ON "dropoff_checkins" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_branch" ON "dropoff_checkins" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_created_at" ON "dropoff_checkins" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_status" ON "dropoff_checkins" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_escalations_tenant" ON "escalations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_escalations_issue" ON "escalations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "idx_event_statuses_tenant" ON "event_statuses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_tenant" ON "fix_reports" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_branch" ON "fix_reports" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_status" ON "fix_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_created" ON "fix_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_issues_tenant" ON "issues" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_issues_branch" ON "issues" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_issues_status" ON "issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_kb_versions_article" ON "kb_article_versions" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_kb_versions_tenant" ON "kb_article_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_tenant" ON "kb_articles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_status" ON "kb_articles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_type" ON "kb_articles" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_branch_scope" ON "kb_articles" USING btree ("branch_scope");--> statement-breakpoint
CREATE INDEX "idx_module_completions_tenant" ON "module_completions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_module_completions_module" ON "module_completions" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_module_completions_user" ON "module_completions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_tenant" ON "nanny_reservations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_branch" ON "nanny_reservations" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_nanny" ON "nanny_reservations" USING btree ("nanny_employee_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_date" ON "nanny_reservations" USING btree ("reservation_date");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_status" ON "nanny_reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_tenant" ON "quiz_attempts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_module" ON "quiz_attempts" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_user" ON "quiz_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_questions_tenant" ON "quiz_questions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_questions_module" ON "quiz_questions" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_service_checkins_tenant" ON "service_checkins" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_service_checkins_branch" ON "service_checkins" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_service_checkins_status" ON "service_checkins" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_service_checkins_registered_at" ON "service_checkins" USING btree ("registered_at");--> statement-breakpoint
CREATE INDEX "idx_sop_articles_tenant" ON "sop_articles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_studio_event_bookings_event" ON "studio_event_bookings" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_studio_event_details_event" ON "studio_event_details" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_studio_event_form_schema_event" ON "studio_event_form_schema" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_studio_event_info_blocks_event" ON "studio_event_info_blocks" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_studio_event_tasks_event" ON "studio_event_tasks" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_task_completions_tenant" ON "task_completions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_completions_task" ON "task_completions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_questions_tenant" ON "task_questions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_questions_task" ON "task_questions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_template_questions_tenant" ON "task_template_questions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_template_questions_template" ON "task_template_questions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_task_templates_tenant" ON "task_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_templates_active" ON "task_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_tasks_tenant" ON "tasks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_branch" ON "tasks" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_assigned" ON "tasks" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_tasks_due_at" ON "tasks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_event" ON "tasks" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_training_modules_tenant" ON "training_modules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_training_modules_branch" ON "training_modules" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_troubleshooting_flows_tenant" ON "troubleshooting_flows" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_troubleshooting_flows_branch" ON "troubleshooting_flows" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_troubleshooting_nodes_tenant" ON "troubleshooting_nodes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_troubleshooting_nodes_flow" ON "troubleshooting_nodes" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "idx_user_vouchers_tenant" ON "user_vouchers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_user_vouchers_employee" ON "user_vouchers" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_user_vouchers_user" ON "user_vouchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_voucher_redemptions_tenant" ON "voucher_redemptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_voucher_redemptions_voucher" ON "voucher_redemptions" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "idx_voucher_redemptions_branch" ON "voucher_redemptions" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_voucher_templates_tenant" ON "voucher_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_voucher_templates_branch" ON "voucher_templates" USING btree ("branch_id");