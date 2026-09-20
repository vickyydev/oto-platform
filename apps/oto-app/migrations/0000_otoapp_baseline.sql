CREATE TYPE "announcement_priority" AS ENUM('info', 'warning', 'urgent');--> statement-breakpoint
CREATE TYPE "beo_assignment_mode" AS ENUM('INDIVIDUAL', 'ROLE', 'DEPARTMENT');--> statement-breakpoint
CREATE TYPE "beo_assignment_target_type" AS ENUM('DEPARTMENT', 'ROLE', 'USER');--> statement-breakpoint
CREATE TYPE "beo_cake_mode" AS ENUM('INTERNAL', 'EXTERNAL', 'NONE');--> statement-breakpoint
CREATE TYPE "beo_deposit_payment_method" AS ENUM('CASH', 'CARD', 'TRANSFER', 'QR_PAYMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "beo_dietary_tag" AS ENUM('VEG', 'VEGAN', 'HALAL', 'NO_PORK', 'NUT_ALLERGY', 'DAIRY_FREE', 'GLUTEN_FREE', 'OTHER');--> statement-breakpoint
CREATE TYPE "beo_entertainment_assignment_mode" AS ENUM('INDIVIDUAL', 'ROLE', 'EXTERNAL_VENDOR');--> statement-breakpoint
CREATE TYPE "beo_entertainment_type" AS ENUM('MASCOT', 'FACE_PAINT', 'GAME_LEADER', 'EXTERNAL_PERFORMER', 'OTHER');--> statement-breakpoint
CREATE TYPE "beo_host_responsibility" AS ENUM('GUEST_COORDINATION', 'TIMELINE_ADHERENCE', 'PARENT_COMMUNICATION', 'ISSUE_ESCALATION');--> statement-breakpoint
CREATE TYPE "beo_setup_charge_mode" AS ENUM('included', 'per_item', 'total');--> statement-breakpoint
CREATE TYPE "beo_setup_item" AS ENUM('BALLOONS', 'BACKDROP', 'TABLE_LAYOUT', 'CAKE_TABLE', 'SIGNAGE', 'DECORATIONS', 'PARTY_SUPPLIES', 'OTHER');--> statement-breakpoint
CREATE TYPE "beo_timeline_assigned_to_type" AS ENUM('PARTY_HOST', 'SETUP_RESPONSIBLE', 'KITCHEN_RESPONSIBLE', 'ENTERTAINMENT', 'SPECIFIC_USER');--> statement-breakpoint
CREATE TYPE "camp_attendance_status" AS ENUM('waiting', 'checked_in', 'checked_out');--> statement-breakpoint
CREATE TYPE "checker_result_status" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TYPE "checklist_attachment_type" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "checklist_type" AS ENUM('operational', 'checker');--> statement-breakpoint
CREATE TYPE "core_branch_scope" AS ENUM('ALL', 'SELECTED');--> statement-breakpoint
CREATE TYPE "core_checkin_status" AS ENUM('registered', 'in_park', 'checked_out');--> statement-breakpoint
CREATE TYPE "core_checklist_status" AS ENUM('pending', 'in_progress', 'completed', 'cancelled', 'issues', 'missed');--> statement-breakpoint
CREATE TYPE "core_escalation_status" AS ENUM('pending', 'acknowledged', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "core_event_type" AS ENUM('birthday', 'private_event', 'school_group', 'other', 'studio_event', 'workshop', 'camp');--> statement-breakpoint
CREATE TYPE "core_issue_priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "core_issue_status" AS ENUM('open', 'in_progress', 'acknowledged', 'resolved', 'closed', 'escalated');--> statement-breakpoint
CREATE TYPE "core_question_type" AS ENUM('text', 'number', 'boolean', 'single_choice', 'multi_choice', 'photo', 'signature');--> statement-breakpoint
CREATE TYPE "core_task_level" AS ENUM('line', 'management', 'strategic');--> statement-breakpoint
CREATE TYPE "core_task_recurrence" AS ENUM('once', 'daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "core_task_status" AS ENUM('pending', 'in_progress', 'completed', 'overdue', 'cancelled', 'blocked');--> statement-breakpoint
CREATE TYPE "core_template_question_type" AS ENUM('text', 'choice', 'boolean');--> statement-breakpoint
CREATE TYPE "core_voucher_status" AS ENUM('active', 'expired', 'redeemed', 'cancelled');--> statement-breakpoint
CREATE TYPE "dropoff_form_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "employment_type" AS ENUM('full_time', 'part_time', 'casual');--> statement-breakpoint
CREATE TYPE "event_line_item_category" AS ENUM('ENTERTAINMENT', 'FOOD', 'SERVICE', 'ADD_ON', 'PACKAGE', 'OTHER');--> statement-breakpoint
CREATE TYPE "event_line_item_source_type" AS ENUM('manual', 'setup', 'package', 'food', 'addon', 'entertainment', 'custom');--> statement-breakpoint
CREATE TYPE "fix_comment_author_type" AS ENUM('staff_user', 'supplier_token');--> statement-breakpoint
CREATE TYPE "fix_report_priority" AS ENUM('urgent', 'high', 'normal', 'low');--> statement-breakpoint
CREATE TYPE "fix_report_status" AS ENUM('new', 'in_progress', 'fixed', 'closed', 'pending', 'done');--> statement-breakpoint
CREATE TYPE "hiring_media_mood" AS ENUM('fun', 'energetic', 'calm', 'professional');--> statement-breakpoint
CREATE TYPE "hiring_status" AS ENUM('not_hiring', 'hiring');--> statement-breakpoint
CREATE TYPE "invitation_theme" AS ENUM('enchanted_castle', 'space_adventure', 'candy_wonderland', 'jungle_quest', 'ocean_magic');--> statement-breakpoint
CREATE TYPE "kb_article_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "kb_article_type" AS ENUM('SOP', 'Policy', 'Safety', 'Checklist', 'Script', 'FAQ', 'Training', 'Maintenance');--> statement-breakpoint
CREATE TYPE "kb_department" AS ENUM('Front Desk', 'Cafe', 'Floor Staff', 'Cleaning', 'Maintenance', 'Birthday / Events', 'Management', 'Admin');--> statement-breakpoint
CREATE TYPE "kb_role" AS ENUM('Reception', 'Barista', 'Party Host', 'Floor Staff', 'Cleaner', 'Technician', 'Supervisor', 'Manager');--> statement-breakpoint
CREATE TYPE "knowledge_file_status" AS ENUM('pending', 'processing', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "knowledge_file_type" AS ENUM('pdf', 'image', 'video');--> statement-breakpoint
CREATE TYPE "message_channel" AS ENUM('whatsapp', 'telegram');--> statement-breakpoint
CREATE TYPE "message_status" AS ENUM('opened_client', 'copied', 'failed');--> statement-breakpoint
CREATE TYPE "nanny_reservation_status" AS ENUM('reserved', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "notification_type" AS ENUM('task_comment', 'task_assigned', 'task_status_changed', 'task_completed', 'task_escalated', 'task_attachment', 'task_checklist_update', 'task_mentioned', 'checklist_assigned', 'announcement', 'task_due_date_changed', 'task_priority_changed');--> statement-breakpoint
CREATE TYPE "org_chart_mode" AS ENUM('live', 'draft');--> statement-breakpoint
CREATE TYPE "org_chart_node_type" AS ENUM('person', 'vacant_role');--> statement-breakpoint
CREATE TYPE "org_chart_scope_type" AS ENUM('company', 'branch');--> statement-breakpoint
CREATE TYPE "parent_experience_language" AS ENUM('en', 'th', 'ru', 'zh');--> statement-breakpoint
CREATE TYPE "rsvp_source" AS ENUM('guest_link', 'parent_portal');--> statement-breakpoint
CREATE TYPE "rsvp_status" AS ENUM('yes', 'no', 'maybe');--> statement-breakpoint
CREATE TYPE "sop_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "studio_booking_payment_method" AS ENUM('qr_online', 'qr_offline', 'cash', 'card', 'transfer', 'pos', 'other');--> statement-breakpoint
CREATE TYPE "studio_booking_payment_status" AS ENUM('unpaid', 'partial', 'paid', 'pay_on_arrival', 'refunded');--> statement-breakpoint
CREATE TYPE "studio_booking_source_channel" AS ENUM('walkin', 'whatsapp', 'instagram', 'facebook', 'klook', 'website', 'phone', 'other');--> statement-breakpoint
CREATE TYPE "studio_event_status" AS ENUM('draft', 'published', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "studio_event_task_status" AS ENUM('todo', 'doing', 'done');--> statement-breakpoint
CREATE TYPE "task_activity_type" AS ENUM('created', 'status_changed', 'completed', 'progress_updated', 'blocked', 'unblocked', 'priority_changed', 'assigned', 'escalated', 'de_escalated', 'edited', 'comment_added', 'attachment_added', 'attachment_removed', 'checklist_item_added', 'checklist_item_checked', 'checklist_item_unchecked', 'checklist_item_removed', 'due_date_changed', 'description_changed');--> statement-breakpoint
CREATE TYPE "task_assignment_type" AS ENUM('employee', 'advisor', 'role', 'department', 'branch');--> statement-breakpoint
CREATE TYPE "translation_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "translation_language" AS ENUM('en', 'th', 'ru', 'zh');--> statement-breakpoint
CREATE TABLE "access_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"username" text,
	"password_encrypted" text NOT NULL,
	"notes" text,
	"branch_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"visibility_level" text DEFAULT 'admin_only' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "access_view_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"access_item_id" uuid NOT NULL,
	"viewed_by" varchar NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "advisor_attendance_corrections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"before_values" jsonb NOT NULL,
	"after_values" jsonb NOT NULL,
	"changed_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisor_attendance_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"check_in_at" timestamp NOT NULL,
	"check_out_at" timestamp,
	"check_in_date" varchar NOT NULL,
	"is_overnight" boolean DEFAULT false NOT NULL,
	"duration_minutes" integer,
	"auth_method" text NOT NULL,
	"confidence_score" integer,
	"liveness_score" integer,
	"photo_evidence_url" text,
	"kiosk_device_id" varchar,
	"voided_at" timestamp,
	"voided_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisor_enrollment_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" varchar NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
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
	"suppress_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" varchar
);
--> statement-breakpoint
CREATE TABLE "auth_otp_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"phone_e164" text NOT NULL,
	"event_type" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"success" boolean DEFAULT false NOT NULL,
	"fail_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_reset_tokens" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar,
	"person_id" varchar,
	"token_type" text NOT NULL,
	"phone_e164" text NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_set_menu_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"token" text NOT NULL,
	"is_submitted" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp,
	"selections" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_set_menu_selections_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "beo_set_menu_selections_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "beo_set_menu_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"calendar_color" text,
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
CREATE TABLE "cash_daily" (
	"tenant_id" text NOT NULL,
	"date" date NOT NULL,
	"cash_in" numeric DEFAULT '0' NOT NULL,
	"cash_out" numeric DEFAULT '0' NOT NULL,
	"net" numeric DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_txns" (
	"tenant_id" text NOT NULL,
	"xero_bank_transaction_id" text NOT NULL,
	"date" date NOT NULL,
	"bank_account_name" text,
	"type" text,
	"total" numeric NOT NULL,
	"direction" text NOT NULL,
	"raw_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "casual_workers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"nickname" text NOT NULL,
	"job_title" text,
	"branch_id" varchar NOT NULL,
	"department_id" varchar NOT NULL,
	"role_id" varchar NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"daily_rate" integer NOT NULL,
	"rate_type" text DEFAULT 'daily' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"archived_at" timestamp,
	"employee_snapshot_json" jsonb
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
CREATE TABLE "duty_blocks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"date" date NOT NULL,
	"employee_id" varchar NOT NULL,
	"assignment_id" varchar NOT NULL,
	"duty_type_id" varchar,
	"duty_name" text,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"notes" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duty_types" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_duration_minutes" integer,
	"color" text,
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
	"signed_pdf_path" text,
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
	"is_half_day" boolean DEFAULT false NOT NULL,
	"half_day_period" text,
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
	"thai_name" text,
	"nickname" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"address" text,
	"branch_id" varchar,
	"status" text DEFAULT 'pending' NOT NULL,
	"employment_state" text DEFAULT 'ACTIVE' NOT NULL,
	"offboarding_type" text,
	"notice_date" timestamp,
	"default_merge_data" jsonb,
	"incentive_clause_text" text,
	"food_allowance_per_day" integer,
	"employment_basis" text DEFAULT 'FULL_TIME' NOT NULL,
	"daily_rate" integer,
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
	"phone_e164" text,
	"face_enrollment_status" text DEFAULT 'NOT_ENROLLED',
	"face_id" text,
	"face_enrolled_at" timestamp,
	"timeclock_pin_hash" text,
	"timeclock_pin_set_at" timestamp,
	"timeclock_pin_required" boolean DEFAULT true,
	"phone_fallback_count_30day" integer DEFAULT 0,
	"phone_fallback_count_reset_at" timestamp,
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
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar,
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
	"person_id" varchar,
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
CREATE TABLE "kiosk_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_devices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"branch_id" varchar NOT NULL,
	"name" text,
	"device_secret_hash" text,
	"kiosk_type" text DEFAULT 'face_recognition',
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp,
	"last_ip" text,
	"last_user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kiosk_device_id" varchar NOT NULL,
	"session_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
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
	"is_protected" boolean DEFAULT false NOT NULL,
	"timeclock_pin_hash" text,
	"timeclock_pin_fingerprint" text,
	"timeclock_pin_set_at" timestamp,
	"timeclock_pin_required" boolean DEFAULT true,
	"phone_number" text,
	"phone_e164" text,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"phone_verified_at" timestamp,
	"department_id" varchar,
	"face_enrollment_status" text DEFAULT 'NOT_ENROLLED',
	"face_id" text,
	"face_enrolled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "people_email_unique" UNIQUE("email"),
	CONSTRAINT "people_timeclock_pin_fingerprint_unique" UNIQUE("timeclock_pin_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "pl_facts" (
	"report_raw_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"section" text NOT NULL,
	"line_name" text NOT NULL,
	"location_name" text NOT NULL,
	"value" numeric NOT NULL
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
	"assignee_type" text DEFAULT 'employee' NOT NULL,
	"employee_id" varchar,
	"casual_worker_id" varchar,
	"daily_rate_snapshot" integer,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" varchar,
	"is_borrowed" boolean DEFAULT false NOT NULL,
	"borrowed_from_branch_id" varchar,
	"role_id" varchar
);
--> statement-breakpoint
CREATE TABLE "schedule_audit_log" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"week_plan_id" varchar,
	"branch_id" varchar,
	"department_id" varchar,
	"week_start_date" date,
	"action" varchar(50) NOT NULL,
	"description" text,
	"performed_by" varchar,
	"snapshot_data" jsonb,
	"summary_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_shift_breaks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"shift_row_id" varchar NOT NULL,
	"shift_date" date NOT NULL,
	"employee_id" varchar,
	"casual_worker_id" varchar,
	"assignment_id" varchar NOT NULL,
	"break_start_time" time NOT NULL,
	"break_end_time" time NOT NULL,
	"break_duration_minutes" integer DEFAULT 60 NOT NULL,
	"source" text DEFAULT 'auto_rule' NOT NULL,
	"has_conflict" boolean DEFAULT false NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"department_id" varchar,
	"shift_group_id" varchar NOT NULL,
	"sort_order_within_group" integer DEFAULT 0,
	"week_plan_id" varchar,
	"row_order" integer DEFAULT 0 NOT NULL,
	"label" text,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"note" text,
	"staff_required" integer DEFAULT 1 NOT NULL,
	"staff_required_by_day" jsonb,
	"color_index" integer,
	"break_enabled" boolean DEFAULT true NOT NULL,
	"break_duration_minutes" integer DEFAULT 60 NOT NULL,
	"break_base_offset_minutes" integer DEFAULT 150 NOT NULL,
	"break_stagger_minutes" integer DEFAULT 30 NOT NULL,
	"active_from_date" date,
	"active_until_date" date,
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
CREATE TABLE "schedule_template_duty_blocks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_assignment_id" varchar NOT NULL,
	"duty_type_id" varchar,
	"duty_name" text,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"notes" text
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
	"department_id" varchar,
	"shift_group_id" varchar,
	"row_order" integer DEFAULT 0 NOT NULL,
	"label" text,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"staff_required" integer DEFAULT 1 NOT NULL,
	"staff_required_by_day" jsonb,
	"color_index" integer,
	"break_enabled" boolean DEFAULT true NOT NULL,
	"break_duration_minutes" integer DEFAULT 60 NOT NULL,
	"break_base_offset_minutes" integer DEFAULT 150 NOT NULL,
	"break_stagger_minutes" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_template_time_off" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" varchar NOT NULL,
	"day_of_week" integer NOT NULL,
	"employee_id" varchar NOT NULL,
	"type" text DEFAULT 'CHANGE_DAY_OFF' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"department_id" varchar,
	"shift_group_id" varchar,
	"name" text NOT NULL,
	"source_week_plan_id" varchar,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "shift_groups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "staff_cost_allocations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"allocation_percent" real NOT NULL,
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
	"branch_id" varchar,
	"country_code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"rules" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" varchar,
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
	"html_body_th" text,
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
	"reason_code" text,
	"reason_notes" text,
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
CREATE TABLE "user_module_overrides" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"module_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"branch_scope_type" text DEFAULT 'HOME_ONLY' NOT NULL,
	"branch_ids" jsonb DEFAULT '[]'::jsonb,
	"notes" text,
	"updated_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"full_name" text NOT NULL,
	"preferred_name" text,
	"role" text DEFAULT 'staff' NOT NULL,
	"operator_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"permission_review_required" boolean DEFAULT false NOT NULL,
	"created_by" varchar,
	"last_login_at" timestamp,
	"phone_number" text,
	"phone_e164" text,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"phone_verified_at" timestamp,
	"profile_photo_path" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE "xero_reports_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"report_type" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"tracking_category_id" text,
	"raw_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xero_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"sync_type" text NOT NULL,
	"from_date" date,
	"to_date" date,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xero_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"xero_tenant_id" text,
	"xero_tenant_name" text,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"id_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text,
	"connected_by" varchar,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xero_tracking_categories" (
	"tenant_id" text NOT NULL,
	"tracking_category_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text,
	"raw_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xero_tracking_options" (
	"tenant_id" text NOT NULL,
	"tracking_category_id" text NOT NULL,
	"tracking_option_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"priority" "announcement_priority" DEFAULT 'info' NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp NOT NULL,
	"branch_ids" text[],
	"department_ids" text[],
	"show_to_everyone" boolean DEFAULT true NOT NULL,
	"created_by" varchar,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ask_oto_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content_text" text,
	"content_json" jsonb,
	"question_id" text,
	"answer_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ask_oto_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"branch_id" varchar,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_assignment_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_type" "beo_assignment_target_type" NOT NULL,
	"department_id" varchar,
	"role_id" varchar,
	"user_id" varchar,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_bar_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"service_time" text,
	"items" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_bar_plans_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "beo_entertainment_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"entertainment_required" boolean DEFAULT false NOT NULL,
	"entertainment_type" "beo_entertainment_type",
	"assignment_mode" "beo_entertainment_assignment_mode",
	"assigned_user_id" varchar,
	"assigned_role_id" varchar,
	"vendor_name" text,
	"vendor_contact" text,
	"resolved_user_id" varchar,
	"resolved_at" timestamp,
	"requirements_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_entertainment_assignments_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "beo_entertainment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entertainment_option_id" uuid,
	"custom_name" text,
	"assignment_target_id" uuid,
	"duration_minutes" integer,
	"start_time" text,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_entertainment_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_duration_minutes" integer,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_entertainment_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"template_id" uuid,
	"template_name_at_apply" text,
	"template_updated_at_at_apply" timestamp,
	"name" text NOT NULL,
	"description" text,
	"duration_minutes" integer,
	"price" integer DEFAULT 0 NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_event_billing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"package_price" integer,
	"add_ons" jsonb,
	"total_calculated" integer,
	"deposit_required" boolean DEFAULT false NOT NULL,
	"deposit_amount" integer,
	"deposit_paid" boolean DEFAULT false NOT NULL,
	"deposit_paid_amount" integer,
	"deposit_payment_method" "beo_deposit_payment_method",
	"deposit_paid_at" timestamp,
	"pos_order_ref" text,
	"billing_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_event_billing_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "beo_kitchen_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"food_required" boolean DEFAULT true NOT NULL,
	"food_package_id" text,
	"food_package_name" text,
	"dietary_tags" text[],
	"dietary_notes" text,
	"cake_mode" "beo_cake_mode" DEFAULT 'NONE',
	"cake_quantity" integer DEFAULT 1 NOT NULL,
	"own_cake_charge" integer,
	"cake_time" text,
	"cake_notes" text,
	"kitchen_ready_offset_minutes" integer DEFAULT 20 NOT NULL,
	"kitchen_responsible_type" text,
	"kitchen_responsible_id" text,
	"kitchen_responsible_mode" "beo_assignment_mode",
	"kitchen_responsible_user_id" varchar,
	"kitchen_responsible_role_id" varchar,
	"kitchen_resolved_user_id" varchar,
	"kitchen_resolved_at" timestamp,
	"kitchen_notes" text,
	"service_schedule" jsonb,
	"menus" jsonb,
	"simplified_menus" jsonb,
	"set_menu_enabled" boolean DEFAULT false NOT NULL,
	"set_menu_template_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_kitchen_plans_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "beo_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"branch_ids" text[] DEFAULT '{}'::text[],
	"name" text NOT NULL,
	"capacity" integer,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_package_snapshot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"source_template_line_item_id" uuid,
	"category" text DEFAULT 'other' NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_label" text,
	"included" boolean DEFAULT true NOT NULL,
	"unit_price" integer DEFAULT 0 NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_package_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"template_id" uuid,
	"template_name_at_apply" text,
	"template_updated_at_at_apply" timestamp,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	"package_name" text NOT NULL,
	"base_price" integer DEFAULT 0 NOT NULL,
	"included_summary" text,
	"excluded_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_package_snapshots_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "beo_party_host_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"assignment_mode" "beo_assignment_mode" DEFAULT 'INDIVIDUAL' NOT NULL,
	"assigned_user_id" varchar,
	"assigned_role_id" varchar,
	"resolved_user_id" varchar,
	"resolved_at" timestamp,
	"backup_user_id" varchar,
	"assigned_employee_id" varchar,
	"backup_employee_id" varchar,
	"responsibilities" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_party_host_assignments_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "beo_setup_item_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"notes" text,
	"default_cost" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_setup_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"assignment_target_id" uuid,
	"deadline_offset_minutes" integer,
	"notes" text,
	"price_amount" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beo_setup_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"setup_required" boolean DEFAULT true NOT NULL,
	"setup_items" text[],
	"setup_notes" text,
	"setup_responsible_mode" "beo_assignment_mode",
	"setup_responsible_user_id" varchar,
	"setup_responsible_role_id" varchar,
	"setup_responsible_department_id" varchar,
	"setup_deadline_offset_minutes" integer DEFAULT 30 NOT NULL,
	"setup_resolved_user_id" varchar,
	"setup_resolved_at" timestamp,
	"setup_charge_mode" "beo_setup_charge_mode" DEFAULT 'included',
	"setup_total_price" integer,
	"setup_tasks" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "beo_setup_plans_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "beo_timeline_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"offset_from_start_minutes" integer DEFAULT 0 NOT NULL,
	"assigned_to_type" "beo_timeline_assigned_to_type" DEFAULT 'PARTY_HOST' NOT NULL,
	"assigned_user_id" varchar,
	"is_system_generated" boolean DEFAULT false NOT NULL,
	"source_key" text,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"completed_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "birthday_package_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"base_price" integer DEFAULT 0 NOT NULL,
	"pricing_mode" text DEFAULT 'fixed',
	"included_summary" text,
	"excluded_summary" text,
	"tags" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "camp_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_registration_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attendance_date" date NOT NULL,
	"status" "camp_attendance_status" DEFAULT 'waiting' NOT NULL,
	"checked_in_at" timestamp,
	"checked_in_by" varchar(255),
	"checked_out_at" timestamp,
	"checked_out_by" varchar(255),
	"payment_method" varchar(50),
	"drop_off_person" text,
	"pick_up_person" text,
	"staff_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_camp_attendance_reg_date" UNIQUE("camp_registration_id","attendance_date")
);
--> statement-breakpoint
CREATE TABLE "camp_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"child_full_name" text NOT NULL,
	"date_of_birth" text NOT NULL,
	"parent_guardian_name" text NOT NULL,
	"emergency_contact_number" text NOT NULL,
	"allergies_notes" text,
	"allergies" text,
	"food_restrictions" text,
	"behavioral_notes" text,
	"special_notes" text,
	"authorized_pickup_persons" text,
	"primary_language" text,
	"child_photo_url" text,
	"parent_photo_url" text,
	"pickup_photo_url" text,
	"parent_contacts" jsonb,
	"attendance_days" jsonb DEFAULT '[]'::jsonb,
	"agreed_camp_rules" boolean DEFAULT false NOT NULL,
	"agreed_child_healthy" boolean DEFAULT false NOT NULL,
	"agreed_camp_rules_date" timestamp,
	"agreed_camp_rules_history" jsonb DEFAULT '[]'::jsonb,
	"parent_signature" text NOT NULL,
	"signature_date" text NOT NULL,
	"checked_in_at" timestamp,
	"checked_in_by" varchar(255),
	"checked_out_at" timestamp,
	"checked_out_by" varchar(255),
	"is_one_time" boolean DEFAULT false NOT NULL,
	"added_by_manager" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"checklist_template_id" uuid,
	"checklist_template_item_id" uuid,
	"pending_checklist_id" uuid,
	"pending_item_index" integer,
	"type" "checklist_attachment_type" NOT NULL,
	"s3_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"original_filename" text,
	"width" integer,
	"height" integer,
	"duration_seconds" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"photo_evidence_urls" jsonb DEFAULT '[]'::jsonb,
	"note" text,
	"completed_by" varchar,
	"completed_at" timestamp,
	"result_status" "checker_result_status",
	"fail_note" text,
	"fail_photo_url" text,
	"created_task_id" uuid,
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
	"template_version_applied" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"completed_by" varchar,
	"due_at" timestamp,
	"period_start" timestamp,
	"period_end" timestamp,
	"missed_at" timestamp,
	"responsible_staff" jsonb DEFAULT '[]'::jsonb,
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
	"reference_media_urls" jsonb DEFAULT '[]'::jsonb,
	"requires_note" boolean DEFAULT false,
	"requires_photo" boolean DEFAULT false,
	"camera_enabled" boolean DEFAULT true NOT NULL,
	"gallery_enabled" boolean DEFAULT false NOT NULL,
	"is_critical" boolean DEFAULT false,
	"linked_to_fix" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"department_id" varchar,
	"zone_label" text
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar,
	"branch_ids" jsonb DEFAULT '[]'::jsonb,
	"department_id" varchar,
	"location_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"checklist_type" "checklist_type" DEFAULT 'operational' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"recurrence" "core_task_recurrence" DEFAULT 'once',
	"weekly_days" jsonb DEFAULT '[]'::jsonb,
	"monthly_day" integer,
	"scheduled_time" text,
	"checker_rounds" integer DEFAULT 2,
	"schedule_time_1" text,
	"schedule_time_2" text,
	"schedule_time_3" text,
	"schedule_time_4" text,
	"schedule_time_5" text,
	"reference_media_urls" jsonb DEFAULT '[]'::jsonb,
	"requires_photo_evidence" boolean DEFAULT false NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"assigned_employee_id" varchar,
	"assigned_role_id" varchar,
	"assigned_department_id" varchar,
	"allowed_checker_roles" jsonb DEFAULT '[]'::jsonb,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"location_id" uuid,
	"location_text" text,
	"event_type" "core_event_type" DEFAULT 'birthday' NOT NULL,
	"color" text,
	"title" text NOT NULL,
	"activities" text,
	"decoration" text,
	"event_date" text NOT NULL,
	"camp_end_date" text,
	"camp_day_hosts" jsonb,
	"camp_cancelled_days" jsonb,
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
	"kid_turning_age" integer,
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
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"suppressed_timeline_sources" text[] DEFAULT '{}'::text[],
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
	"contact_method" text DEFAULT 'whatsapp',
	"whatsapp_phone_e164" text,
	"telegram_username" text,
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
CREATE TABLE "dropoff_form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"source_language" text DEFAULT 'en' NOT NULL,
	"schema_json" jsonb NOT NULL,
	"is_draft" boolean DEFAULT true NOT NULL,
	"published_at" timestamp,
	"published_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dropoff_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar,
	"name" text DEFAULT 'Drop-off Form' NOT NULL,
	"status" "dropoff_form_status" DEFAULT 'draft' NOT NULL,
	"active_published_version_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_role_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"role_id" varchar NOT NULL,
	"role_name" text NOT NULL,
	"unavailable_date" varchar(10) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "entertainment_package_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"duration_minutes" integer,
	"default_price" integer DEFAULT 0 NOT NULL,
	"included" boolean DEFAULT false NOT NULL,
	"billable_by_default" boolean DEFAULT true NOT NULL,
	"category" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar
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
CREATE TABLE "event_line_item_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_unit_price_inc_vat" integer DEFAULT 0 NOT NULL,
	"default_qty" integer DEFAULT 1 NOT NULL,
	"category" "event_line_item_category" DEFAULT 'OTHER' NOT NULL,
	"is_included_by_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"internal_note" text,
	"created_by_user_id" varchar,
	"updated_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"template_id" uuid,
	"name" text NOT NULL,
	"category" "event_line_item_category" DEFAULT 'OTHER' NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_price_inc_vat" integer DEFAULT 0 NOT NULL,
	"is_included" boolean DEFAULT false NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"auto_generated" boolean DEFAULT false NOT NULL,
	"source_type" "event_line_item_source_type" DEFAULT 'manual',
	"source_id" text,
	"notes" text,
	"override_reason" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" varchar,
	"updated_by_user_id" varchar,
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
CREATE TABLE "fix_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fix_id" uuid NOT NULL,
	"author_type" "fix_comment_author_type" NOT NULL,
	"author_user_id" varchar,
	"supplier_token_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"reported_by" varchar NOT NULL,
	"reported_by_name" text,
	"title" text NOT NULL,
	"description" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"location_id" uuid,
	"location" text NOT NULL,
	"location_note" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"priority" "fix_report_priority" DEFAULT 'normal' NOT NULL,
	"status" "fix_report_status" DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp,
	"assigned_department_id" varchar,
	"source_checklist_run_item_id" uuid,
	"closed_at" timestamp,
	"closed_by_user_id" varchar,
	"closed_by_supplier_token_id" uuid,
	"done_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_supplier_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"allowed_branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "guest_invite_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"token" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar,
	"revoked_at" timestamp,
	"last_accessed_at" timestamp,
	CONSTRAINT "guest_invite_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "hiring_media_assets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"original_name" varchar(255),
	"file_url" varchar(500) NOT NULL,
	"thumbnail_url" varchar(500),
	"mime_type" varchar(100),
	"file_size" integer,
	"branch_id" varchar,
	"department_id" varchar,
	"mood" "hiring_media_mood",
	"description" text,
	"tags" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"uploaded_by" varchar
);
--> statement-breakpoint
CREATE TABLE "i18n_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text DEFAULT 'dropoff' NOT NULL,
	"version_id" uuid NOT NULL,
	"lang" "translation_language" NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"is_manual_override" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"theme_id" "invitation_theme" DEFAULT 'enchanted_castle' NOT NULL,
	"language" "parent_experience_language" DEFAULT 'en' NOT NULL,
	"child_name" varchar(100) NOT NULL,
	"child_age" varchar(10),
	"message" varchar(280),
	"event_date" date NOT NULL,
	"start_time" varchar(10) NOT NULL,
	"end_time" varchar(10),
	"location_name" varchar(200),
	"location_map_url" varchar(500),
	"photo_url" text,
	"generated_image_url" text,
	"generated_pdf_url" text,
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
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"embedding" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"file_type" "knowledge_file_type" NOT NULL,
	"storage_url" text NOT NULL,
	"thumbnail_url" text,
	"mime_type" text,
	"size_bytes" integer,
	"branch_id" varchar,
	"department_id" varchar,
	"language" text DEFAULT 'en' NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[],
	"version" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"index_status" "knowledge_file_status" DEFAULT 'pending' NOT NULL,
	"index_error" text,
	"page_count" integer,
	"title" text,
	"description" text,
	"created_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_branch_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_user_id" varchar NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"actor_user_id" varchar,
	"actor_name" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_nodes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" "org_chart_mode" DEFAULT 'live' NOT NULL,
	"scope_type" "org_chart_scope_type" DEFAULT 'company' NOT NULL,
	"scope_branch_id" varchar,
	"node_type" "org_chart_node_type" DEFAULT 'person' NOT NULL,
	"person_employee_id" varchar,
	"title" varchar(255),
	"nickname_override" varchar(100),
	"position_title" varchar(255),
	"branch_id" varchar,
	"department_id" varchar,
	"reports_to_node_id" varchar,
	"expected_monthly_salary" real,
	"is_vacant" boolean DEFAULT false NOT NULL,
	"is_advisor" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hiring_status" "hiring_status" DEFAULT 'not_hiring',
	"employment_type" "employment_type",
	"job_description" text,
	"key_responsibilities" jsonb,
	"requirements" jsonb,
	"salary_range" varchar(100),
	"benefits" jsonb,
	"contact_phone" varchar(50),
	"contact_line" varchar(100),
	"contact_email" varchar(255),
	"apply_url" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar,
	"last_edited_by" varchar
);
--> statement-breakpoint
CREATE TABLE "package_line_item_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_template_id" uuid NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"qty_default" integer DEFAULT 1 NOT NULL,
	"qty_editable" boolean DEFAULT true NOT NULL,
	"unit_label" text,
	"included" boolean DEFAULT true NOT NULL,
	"default_unit_price" integer DEFAULT 0 NOT NULL,
	"billable_by_default" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_message_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"channel" "message_channel" DEFAULT 'whatsapp' NOT NULL,
	"language" "parent_experience_language" DEFAULT 'en' NOT NULL,
	"message_template_version" varchar(50),
	"rendered_message_text" text NOT NULL,
	"sent_by_user_id" varchar,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"recipient_phone" varchar(50),
	"status" "message_status" DEFAULT 'opened_client' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_portal_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"token" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar,
	"revoked_at" timestamp,
	"last_accessed_at" timestamp,
	CONSTRAINT "parent_portal_tokens_token_unique" UNIQUE("token")
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
CREATE TABLE "rsvp_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"guest_name" varchar(100) NOT NULL,
	"phone" varchar(50),
	"attending_status" "rsvp_status" DEFAULT 'yes' NOT NULL,
	"number_of_kids" integer DEFAULT 1 NOT NULL,
	"number_of_adults" integer DEFAULT 1 NOT NULL,
	"notes" varchar(500),
	"source" "rsvp_source" DEFAULT 'guest_link' NOT NULL,
	"language" "parent_experience_language" DEFAULT 'en' NOT NULL,
	"guest_identifier" varchar(100),
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"service_type" text,
	"parent_full_name" text NOT NULL,
	"contact_method" text DEFAULT 'whatsapp',
	"whatsapp_phone_raw" text NOT NULL,
	"whatsapp_phone_e164" text,
	"telegram_username" text,
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
	"structured_steps" jsonb,
	"steps" jsonb,
	"rules" jsonb,
	"common_mistakes" jsonb,
	"unsure_tips" jsonb,
	"scope" text DEFAULT 'GLOBAL' NOT NULL,
	"branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "sop_status" DEFAULT 'published' NOT NULL
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
	"completed_at" timestamp,
	"completed_by_user_id" varchar,
	"status" "studio_event_task_status" DEFAULT 'todo' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"branch_id" varchar,
	"activity_type" "task_activity_type" NOT NULL,
	"description" text NOT NULL,
	"user_id" varchar,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"assignment_type" "task_assignment_type" NOT NULL,
	"assignment_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_url" text NOT NULL,
	"file_size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"uploaded_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"is_checked" boolean DEFAULT false NOT NULL,
	"due_at" timestamp,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"author_id" varchar NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"weekly_days" jsonb DEFAULT '[]'::jsonb,
	"monthly_day" integer,
	"preferred_due_time" text,
	"requires_photo_evidence" boolean DEFAULT false NOT NULL,
	"requires_responses" boolean DEFAULT false NOT NULL,
	"task_level" "core_task_level" DEFAULT 'line' NOT NULL,
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
	"weekly_days" jsonb DEFAULT '[]'::jsonb,
	"monthly_day" integer,
	"preferred_due_time" text,
	"is_recurring_definition" boolean DEFAULT false NOT NULL,
	"parent_task_id" uuid,
	"due_at" timestamp,
	"start_at" timestamp,
	"scheduled_mode" boolean DEFAULT false NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"status_manual_override" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"completed_at" timestamp,
	"assigned_to" varchar,
	"assigned_employee_id" varchar,
	"assigned_role_id" varchar,
	"assigned_department_id" varchar,
	"requires_photo_evidence" boolean DEFAULT false NOT NULL,
	"requires_responses" boolean DEFAULT false NOT NULL,
	"reference_photo_url" text,
	"task_level" "core_task_level" DEFAULT 'line' NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"last_movement_at" timestamp DEFAULT now(),
	"owner_user_id" varchar,
	"archived_at" timestamp,
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
CREATE TABLE "translation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"status" "translation_job_status" DEFAULT 'queued' NOT NULL,
	"target_languages" jsonb DEFAULT '["th","ru","zh"]'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
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
ALTER TABLE "access_items" ADD CONSTRAINT "access_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_items" ADD CONSTRAINT "access_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_view_logs" ADD CONSTRAINT "access_view_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_view_logs" ADD CONSTRAINT "access_view_logs_access_item_id_access_items_id_fk" FOREIGN KEY ("access_item_id") REFERENCES "access_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_view_logs" ADD CONSTRAINT "access_view_logs_viewed_by_users_id_fk" FOREIGN KEY ("viewed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_contract_instance_id_contract_instances_id_fk" FOREIGN KEY ("contract_instance_id") REFERENCES "contract_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_corrections" ADD CONSTRAINT "advisor_attendance_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_corrections" ADD CONSTRAINT "advisor_attendance_corrections_session_id_advisor_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "advisor_attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_corrections" ADD CONSTRAINT "advisor_attendance_corrections_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_corrections" ADD CONSTRAINT "advisor_attendance_corrections_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_sessions" ADD CONSTRAINT "advisor_attendance_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_sessions" ADD CONSTRAINT "advisor_attendance_sessions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_sessions" ADD CONSTRAINT "advisor_attendance_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_sessions" ADD CONSTRAINT "advisor_attendance_sessions_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_attendance_sessions" ADD CONSTRAINT "advisor_attendance_sessions_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_enrollment_sessions" ADD CONSTRAINT "advisor_enrollment_sessions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_enrollment_sessions" ADD CONSTRAINT "advisor_enrollment_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_contract_instance_id_contract_instances_id_fk" FOREIGN KEY ("contract_instance_id") REFERENCES "contract_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_otp_events" ADD CONSTRAINT "auth_otp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_reset_tokens" ADD CONSTRAINT "auth_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_reset_tokens" ADD CONSTRAINT "auth_reset_tokens_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_set_menu_selections" ADD CONSTRAINT "beo_set_menu_selections_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_set_menu_selections" ADD CONSTRAINT "beo_set_menu_selections_template_id_beo_set_menu_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "beo_set_menu_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_set_menu_templates" ADD CONSTRAINT "beo_set_menu_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_events" ADD CONSTRAINT "branch_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_events" ADD CONSTRAINT "branch_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casual_workers" ADD CONSTRAINT "casual_workers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casual_workers" ADD CONSTRAINT "casual_workers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casual_workers" ADD CONSTRAINT "casual_workers_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casual_workers" ADD CONSTRAINT "casual_workers_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casual_workers" ADD CONSTRAINT "casual_workers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_policy_document_id_policy_documents_id_fk" FOREIGN KEY ("policy_document_id") REFERENCES "policy_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_rules" ADD CONSTRAINT "coverage_rules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_rules" ADD CONSTRAINT "coverage_rules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_branch_assignments" ADD CONSTRAINT "department_branch_assignments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_branch_assignments" ADD CONSTRAINT "department_branch_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_branch_assignments" ADD CONSTRAINT "department_branch_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_blocks" ADD CONSTRAINT "duty_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_blocks" ADD CONSTRAINT "duty_blocks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_blocks" ADD CONSTRAINT "duty_blocks_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_blocks" ADD CONSTRAINT "duty_blocks_assignment_id_schedule_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "schedule_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_blocks" ADD CONSTRAINT "duty_blocks_duty_type_id_duty_types_id_fk" FOREIGN KEY ("duty_type_id") REFERENCES "duty_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_blocks" ADD CONSTRAINT "duty_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_types" ADD CONSTRAINT "duty_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_catalog_asset_id_asset_catalog_id_fk" FOREIGN KEY ("catalog_asset_id") REFERENCES "asset_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_old_branch_id_branches_id_fk" FOREIGN KEY ("old_branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_old_department_id_departments_id_fk" FOREIGN KEY ("old_department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_new_branch_id_branches_id_fk" FOREIGN KEY ("new_branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_new_department_id_departments_id_fk" FOREIGN KEY ("new_department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_contract_instance_id_contract_instances_id_fk" FOREIGN KEY ("contract_instance_id") REFERENCES "contract_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_offboarding_id_employee_offboarding_id_fk" FOREIGN KEY ("offboarding_id") REFERENCES "employee_offboarding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_offboarding" ADD CONSTRAINT "employee_offboarding_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_offboarding" ADD CONSTRAINT "employee_offboarding_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_offboarding" ADD CONSTRAINT "employee_offboarding_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_profiles" ADD CONSTRAINT "employee_payroll_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_profiles" ADD CONSTRAINT "employee_payroll_profiles_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_payroll_profiles" ADD CONSTRAINT "employee_payroll_profiles_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_presence" ADD CONSTRAINT "employee_presence_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_presence" ADD CONSTRAINT "employee_presence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_presence" ADD CONSTRAINT "employee_presence_current_work_branch_id_branches_id_fk" FOREIGN KEY ("current_work_branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_roles" ADD CONSTRAINT "employee_roles_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_roles" ADD CONSTRAINT "employee_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_profile_photo_updated_by_users_id_fk" FOREIGN KEY ("profile_photo_updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_sessions" ADD CONSTRAINT "enrollment_sessions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_sessions" ADD CONSTRAINT "enrollment_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_auth_attempts" ADD CONSTRAINT "kiosk_auth_attempts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_auth_attempts" ADD CONSTRAINT "kiosk_auth_attempts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_auth_attempts" ADD CONSTRAINT "kiosk_auth_attempts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_auth_attempts" ADD CONSTRAINT "kiosk_auth_attempts_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_codes" ADD CONSTRAINT "kiosk_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_codes" ADD CONSTRAINT "kiosk_codes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_sessions" ADD CONSTRAINT "kiosk_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_sessions" ADD CONSTRAINT "kiosk_sessions_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_offboarding_id_employee_offboarding_id_fk" FOREIGN KEY ("offboarding_id") REFERENCES "employee_offboarding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_checklist" ADD CONSTRAINT "offboarding_checklist_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_day_reconciliations" ADD CONSTRAINT "payroll_day_reconciliations_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_day_reconciliations" ADD CONSTRAINT "payroll_day_reconciliations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_day_reconciliations" ADD CONSTRAINT "payroll_day_reconciliations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employee_summaries" ADD CONSTRAINT "payroll_employee_summaries_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employee_summaries" ADD CONSTRAINT "payroll_employee_summaries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exception_approvals" ADD CONSTRAINT "payroll_exception_approvals_payroll_exception_id_payroll_exceptions_id_fk" FOREIGN KEY ("payroll_exception_id") REFERENCES "payroll_exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exception_approvals" ADD CONSTRAINT "payroll_exception_approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy_settings" ADD CONSTRAINT "payroll_policy_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy_settings" ADD CONSTRAINT "payroll_policy_settings_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_payroll_period_id_payroll_periods_id_fk" FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_period_id_payroll_periods_id_fk" FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pl_facts" ADD CONSTRAINT "pl_facts_report_raw_id_xero_reports_raw_id_fk" FOREIGN KEY ("report_raw_id") REFERENCES "xero_reports_raw"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_branch_assignments" ADD CONSTRAINT "role_branch_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_branch_assignments" ADD CONSTRAINT "role_branch_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_branch_assignments" ADD CONSTRAINT "role_branch_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_department_map" ADD CONSTRAINT "role_department_map_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_department_map" ADD CONSTRAINT "role_department_map_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advance_repayments" ADD CONSTRAINT "salary_advance_repayments_salary_advance_id_salary_advances_id_fk" FOREIGN KEY ("salary_advance_id") REFERENCES "salary_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advance_repayments" ADD CONSTRAINT "salary_advance_repayments_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advance_repayments" ADD CONSTRAINT "salary_advance_repayments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_repayment_start_period_id_payroll_periods_id_fk" FOREIGN KEY ("repayment_start_period_id") REFERENCES "payroll_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_week_plan_id_schedule_week_plans_id_fk" FOREIGN KEY ("week_plan_id") REFERENCES "schedule_week_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_shift_row_id_schedule_shift_rows_id_fk" FOREIGN KEY ("shift_row_id") REFERENCES "schedule_shift_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_casual_worker_id_casual_workers_id_fk" FOREIGN KEY ("casual_worker_id") REFERENCES "casual_workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_borrowed_from_branch_id_branches_id_fk" FOREIGN KEY ("borrowed_from_branch_id") REFERENCES "branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_audit_log" ADD CONSTRAINT "schedule_audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_audit_log" ADD CONSTRAINT "schedule_audit_log_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_audit_log" ADD CONSTRAINT "schedule_audit_log_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_breaks" ADD CONSTRAINT "schedule_shift_breaks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_breaks" ADD CONSTRAINT "schedule_shift_breaks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_breaks" ADD CONSTRAINT "schedule_shift_breaks_shift_row_id_schedule_shift_rows_id_fk" FOREIGN KEY ("shift_row_id") REFERENCES "schedule_shift_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_breaks" ADD CONSTRAINT "schedule_shift_breaks_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_breaks" ADD CONSTRAINT "schedule_shift_breaks_casual_worker_id_casual_workers_id_fk" FOREIGN KEY ("casual_worker_id") REFERENCES "casual_workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_breaks" ADD CONSTRAINT "schedule_shift_breaks_assignment_id_schedule_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "schedule_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_row_roles" ADD CONSTRAINT "schedule_shift_row_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_row_roles" ADD CONSTRAINT "schedule_shift_row_roles_shift_row_id_schedule_shift_rows_id_fk" FOREIGN KEY ("shift_row_id") REFERENCES "schedule_shift_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_row_roles" ADD CONSTRAINT "schedule_shift_row_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_shift_group_id_shift_groups_id_fk" FOREIGN KEY ("shift_group_id") REFERENCES "shift_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_week_plan_id_schedule_week_plans_id_fk" FOREIGN KEY ("week_plan_id") REFERENCES "schedule_week_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_shift_rows" ADD CONSTRAINT "schedule_shift_rows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_assignments" ADD CONSTRAINT "schedule_template_assignments_template_row_id_schedule_template_rows_id_fk" FOREIGN KEY ("template_row_id") REFERENCES "schedule_template_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_assignments" ADD CONSTRAINT "schedule_template_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_duty_blocks" ADD CONSTRAINT "schedule_template_duty_blocks_template_assignment_id_schedule_template_assignments_id_fk" FOREIGN KEY ("template_assignment_id") REFERENCES "schedule_template_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_duty_blocks" ADD CONSTRAINT "schedule_template_duty_blocks_duty_type_id_duty_types_id_fk" FOREIGN KEY ("duty_type_id") REFERENCES "duty_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_row_roles" ADD CONSTRAINT "schedule_template_row_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_row_roles" ADD CONSTRAINT "schedule_template_row_roles_template_row_id_schedule_template_rows_id_fk" FOREIGN KEY ("template_row_id") REFERENCES "schedule_template_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_row_roles" ADD CONSTRAINT "schedule_template_row_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_rows" ADD CONSTRAINT "schedule_template_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_rows" ADD CONSTRAINT "schedule_template_rows_template_id_schedule_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "schedule_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_rows" ADD CONSTRAINT "schedule_template_rows_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_rows" ADD CONSTRAINT "schedule_template_rows_shift_group_id_shift_groups_id_fk" FOREIGN KEY ("shift_group_id") REFERENCES "shift_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_time_off" ADD CONSTRAINT "schedule_template_time_off_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_time_off" ADD CONSTRAINT "schedule_template_time_off_template_id_schedule_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "schedule_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_time_off" ADD CONSTRAINT "schedule_template_time_off_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_shift_group_id_shift_groups_id_fk" FOREIGN KEY ("shift_group_id") REFERENCES "shift_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_source_week_plan_id_schedule_week_plans_id_fk" FOREIGN KEY ("source_week_plan_id") REFERENCES "schedule_week_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_week_plans" ADD CONSTRAINT "schedule_week_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_week_plans" ADD CONSTRAINT "schedule_week_plans_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_week_plans" ADD CONSTRAINT "schedule_week_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_groups" ADD CONSTRAINT "shift_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_groups" ADD CONSTRAINT "shift_groups_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_groups" ADD CONSTRAINT "shift_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_required_roles" ADD CONSTRAINT "shift_required_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_required_roles" ADD CONSTRAINT "shift_required_roles_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_required_roles" ADD CONSTRAINT "shift_required_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_policies" ADD CONSTRAINT "sick_leave_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_policies" ADD CONSTRAINT "sick_leave_policies_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_cost_allocations" ADD CONSTRAINT "staff_cost_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_cost_allocations" ADD CONSTRAINT "staff_cost_allocations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_cost_allocations" ADD CONSTRAINT "staff_cost_allocations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_calculation_results" ADD CONSTRAINT "statutory_calculation_results_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_calculation_results" ADD CONSTRAINT "statutory_calculation_results_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_rule_sets" ADD CONSTRAINT "statutory_rule_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_adjustments" ADD CONSTRAINT "time_adjustments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_kiosk_device_id_kiosk_devices_id_fk" FOREIGN KEY ("kiosk_device_id") REFERENCES "kiosk_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_events" ADD CONSTRAINT "time_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_linked_time_entry_id_time_entries_id_fk" FOREIGN KEY ("linked_time_entry_id") REFERENCES "time_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timekeeping_issues" ADD CONSTRAINT "timekeeping_issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_module_overrides" ADD CONSTRAINT "user_module_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_module_overrides" ADD CONSTRAINT "user_module_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_module_overrides" ADD CONSTRAINT "user_module_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_tokens" ADD CONSTRAINT "xero_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_tokens" ADD CONSTRAINT "xero_tokens_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_oto_messages" ADD CONSTRAINT "ask_oto_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_oto_messages" ADD CONSTRAINT "ask_oto_messages_thread_id_ask_oto_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "ask_oto_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_oto_threads" ADD CONSTRAINT "ask_oto_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_oto_threads" ADD CONSTRAINT "ask_oto_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_oto_threads" ADD CONSTRAINT "ask_oto_threads_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD CONSTRAINT "beo_assignment_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD CONSTRAINT "beo_assignment_targets_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD CONSTRAINT "beo_assignment_targets_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD CONSTRAINT "beo_assignment_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_bar_plans" ADD CONSTRAINT "beo_bar_plans_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_assignments" ADD CONSTRAINT "beo_entertainment_assignments_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_assignments" ADD CONSTRAINT "beo_entertainment_assignments_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_assignments" ADD CONSTRAINT "beo_entertainment_assignments_assigned_role_id_roles_id_fk" FOREIGN KEY ("assigned_role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_assignments" ADD CONSTRAINT "beo_entertainment_assignments_resolved_user_id_users_id_fk" FOREIGN KEY ("resolved_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_items" ADD CONSTRAINT "beo_entertainment_items_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_items" ADD CONSTRAINT "beo_entertainment_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_items" ADD CONSTRAINT "beo_entertainment_items_entertainment_option_id_beo_entertainment_options_id_fk" FOREIGN KEY ("entertainment_option_id") REFERENCES "beo_entertainment_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_items" ADD CONSTRAINT "beo_entertainment_items_assignment_target_id_beo_assignment_targets_id_fk" FOREIGN KEY ("assignment_target_id") REFERENCES "beo_assignment_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_options" ADD CONSTRAINT "beo_entertainment_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_selections" ADD CONSTRAINT "beo_entertainment_selections_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_entertainment_selections" ADD CONSTRAINT "beo_entertainment_selections_template_id_entertainment_package_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "entertainment_package_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_event_billing" ADD CONSTRAINT "beo_event_billing_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_kitchen_plans" ADD CONSTRAINT "beo_kitchen_plans_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_kitchen_plans" ADD CONSTRAINT "beo_kitchen_plans_kitchen_responsible_user_id_users_id_fk" FOREIGN KEY ("kitchen_responsible_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_kitchen_plans" ADD CONSTRAINT "beo_kitchen_plans_kitchen_responsible_role_id_roles_id_fk" FOREIGN KEY ("kitchen_responsible_role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_kitchen_plans" ADD CONSTRAINT "beo_kitchen_plans_kitchen_resolved_user_id_users_id_fk" FOREIGN KEY ("kitchen_resolved_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_locations" ADD CONSTRAINT "beo_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_locations" ADD CONSTRAINT "beo_locations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_package_snapshot_items" ADD CONSTRAINT "beo_package_snapshot_items_snapshot_id_beo_package_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "beo_package_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_package_snapshot_items" ADD CONSTRAINT "beo_package_snapshot_items_source_template_line_item_id_package_line_item_templates_id_fk" FOREIGN KEY ("source_template_line_item_id") REFERENCES "package_line_item_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD CONSTRAINT "beo_package_snapshots_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD CONSTRAINT "beo_package_snapshots_template_id_birthday_package_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "birthday_package_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_party_host_assignments" ADD CONSTRAINT "beo_party_host_assignments_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_party_host_assignments" ADD CONSTRAINT "beo_party_host_assignments_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_party_host_assignments" ADD CONSTRAINT "beo_party_host_assignments_assigned_role_id_roles_id_fk" FOREIGN KEY ("assigned_role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_party_host_assignments" ADD CONSTRAINT "beo_party_host_assignments_resolved_user_id_users_id_fk" FOREIGN KEY ("resolved_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_party_host_assignments" ADD CONSTRAINT "beo_party_host_assignments_backup_user_id_users_id_fk" FOREIGN KEY ("backup_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_party_host_assignments" ADD CONSTRAINT "beo_party_host_assignments_assigned_employee_id_employees_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_party_host_assignments" ADD CONSTRAINT "beo_party_host_assignments_backup_employee_id_employees_id_fk" FOREIGN KEY ("backup_employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_item_options" ADD CONSTRAINT "beo_setup_item_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_items" ADD CONSTRAINT "beo_setup_items_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_items" ADD CONSTRAINT "beo_setup_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_items" ADD CONSTRAINT "beo_setup_items_assignment_target_id_beo_assignment_targets_id_fk" FOREIGN KEY ("assignment_target_id") REFERENCES "beo_assignment_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_plans" ADD CONSTRAINT "beo_setup_plans_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_plans" ADD CONSTRAINT "beo_setup_plans_setup_responsible_user_id_users_id_fk" FOREIGN KEY ("setup_responsible_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_plans" ADD CONSTRAINT "beo_setup_plans_setup_responsible_role_id_roles_id_fk" FOREIGN KEY ("setup_responsible_role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_plans" ADD CONSTRAINT "beo_setup_plans_setup_responsible_department_id_departments_id_fk" FOREIGN KEY ("setup_responsible_department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_setup_plans" ADD CONSTRAINT "beo_setup_plans_setup_resolved_user_id_users_id_fk" FOREIGN KEY ("setup_resolved_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_timeline_items" ADD CONSTRAINT "beo_timeline_items_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_timeline_items" ADD CONSTRAINT "beo_timeline_items_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_timeline_items" ADD CONSTRAINT "beo_timeline_items_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD CONSTRAINT "birthday_package_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD CONSTRAINT "birthday_package_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_attendance" ADD CONSTRAINT "camp_attendance_camp_registration_id_camp_registrations_id_fk" FOREIGN KEY ("camp_registration_id") REFERENCES "camp_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_registrations" ADD CONSTRAINT "camp_registrations_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_attachments" ADD CONSTRAINT "checklist_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_attachments" ADD CONSTRAINT "checklist_attachments_checklist_template_id_checklist_templates_id_fk" FOREIGN KEY ("checklist_template_id") REFERENCES "checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_attachments" ADD CONSTRAINT "checklist_attachments_checklist_template_item_id_checklist_template_items_id_fk" FOREIGN KEY ("checklist_template_item_id") REFERENCES "checklist_template_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_attachments" ADD CONSTRAINT "checklist_attachments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_run_id_checklist_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "checklist_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_template_item_id_checklist_template_items_id_fk" FOREIGN KEY ("template_item_id") REFERENCES "checklist_template_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_assigned_employee_id_employees_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_assigned_department_id_departments_id_fk" FOREIGN KEY ("assigned_department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_cache" ADD CONSTRAINT "directory_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_cache" ADD CONSTRAINT "directory_cache_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_checkins" ADD CONSTRAINT "dropoff_checkins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_checkins" ADD CONSTRAINT "dropoff_checkins_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_checkins" ADD CONSTRAINT "dropoff_checkins_picked_up_by_users_id_fk" FOREIGN KEY ("picked_up_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_form_versions" ADD CONSTRAINT "dropoff_form_versions_form_id_dropoff_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "dropoff_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_form_versions" ADD CONSTRAINT "dropoff_form_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_forms" ADD CONSTRAINT "dropoff_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropoff_forms" ADD CONSTRAINT "dropoff_forms_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_role_availability" ADD CONSTRAINT "employee_role_availability_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_role_availability" ADD CONSTRAINT "employee_role_availability_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_role_availability" ADD CONSTRAINT "employee_role_availability_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD CONSTRAINT "entertainment_package_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD CONSTRAINT "entertainment_package_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_escalated_to_users_id_fk" FOREIGN KEY ("escalated_to") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_escalated_by_users_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_line_item_templates" ADD CONSTRAINT "event_line_item_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_line_item_templates" ADD CONSTRAINT "event_line_item_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_line_item_templates" ADD CONSTRAINT "event_line_item_templates_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_line_items" ADD CONSTRAINT "event_line_items_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_line_items" ADD CONSTRAINT "event_line_items_template_id_event_line_item_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "event_line_item_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_line_items" ADD CONSTRAINT "event_line_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_line_items" ADD CONSTRAINT "event_line_items_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_statuses" ADD CONSTRAINT "event_statuses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_comments" ADD CONSTRAINT "fix_comments_fix_id_fix_reports_id_fk" FOREIGN KEY ("fix_id") REFERENCES "fix_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_comments" ADD CONSTRAINT "fix_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_assigned_department_id_departments_id_fk" FOREIGN KEY ("assigned_department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_source_checklist_run_item_id_checklist_run_items_id_fk" FOREIGN KEY ("source_checklist_run_item_id") REFERENCES "checklist_run_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_supplier_tokens" ADD CONSTRAINT "fix_supplier_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_supplier_tokens" ADD CONSTRAINT "fix_supplier_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_invite_tokens" ADD CONSTRAINT "guest_invite_tokens_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_invite_tokens" ADD CONSTRAINT "guest_invite_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_media_assets" ADD CONSTRAINT "hiring_media_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_media_assets" ADD CONSTRAINT "hiring_media_assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_media_assets" ADD CONSTRAINT "hiring_media_assets_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_media_assets" ADD CONSTRAINT "hiring_media_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "i18n_translations" ADD CONSTRAINT "i18n_translations_version_id_dropoff_form_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "dropoff_form_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_designs" ADD CONSTRAINT "invitation_designs_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_file_id_knowledge_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "knowledge_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_branch_access" ADD CONSTRAINT "location_branch_access_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_branch_access" ADD CONSTRAINT "location_branch_access_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_module_id_training_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "training_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_completions" ADD CONSTRAINT "module_completions_quiz_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("quiz_attempt_id") REFERENCES "quiz_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_nanny_employee_id_employees_id_fk" FOREIGN KEY ("nanny_employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_service_checkin_id_service_checkins_id_fk" FOREIGN KEY ("service_checkin_id") REFERENCES "service_checkins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nanny_reservations" ADD CONSTRAINT "nanny_reservations_reserved_by_user_id_users_id_fk" FOREIGN KEY ("reserved_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_scope_branch_id_branches_id_fk" FOREIGN KEY ("scope_branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_person_employee_id_employees_id_fk" FOREIGN KEY ("person_employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_last_edited_by_users_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_line_item_templates" ADD CONSTRAINT "package_line_item_templates_package_template_id_birthday_package_templates_id_fk" FOREIGN KEY ("package_template_id") REFERENCES "birthday_package_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_message_logs" ADD CONSTRAINT "parent_message_logs_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_message_logs" ADD CONSTRAINT "parent_message_logs_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_portal_tokens" ADD CONSTRAINT "parent_portal_tokens_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_portal_tokens" ADD CONSTRAINT "parent_portal_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_module_id_training_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "training_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_module_id_training_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "training_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp_entries" ADD CONSTRAINT "rsvp_entries_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_nanny_employee_id_employees_id_fk" FOREIGN KEY ("nanny_employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_nanny_assigned_by_user_id_users_id_fk" FOREIGN KEY ("nanny_assigned_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_checked_out_by_users_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checkins" ADD CONSTRAINT "service_checkins_served_by_users_id_fk" FOREIGN KEY ("served_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_articles" ADD CONSTRAINT "sop_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_bookings" ADD CONSTRAINT "studio_event_bookings_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_details" ADD CONSTRAINT "studio_event_details_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_form_schema" ADD CONSTRAINT "studio_event_form_schema_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_info_blocks" ADD CONSTRAINT "studio_event_info_blocks_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_template_questions" ADD CONSTRAINT "task_template_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_template_questions" ADD CONSTRAINT "task_template_questions_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "task_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "task_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_employee_id_employees_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_role_id_roles_id_fk" FOREIGN KEY ("assigned_role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_department_id_departments_id_fk" FOREIGN KEY ("assigned_department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_modules" ADD CONSTRAINT "training_modules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_jobs" ADD CONSTRAINT "translation_jobs_version_id_dropoff_form_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "dropoff_form_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_flows" ADD CONSTRAINT "troubleshooting_flows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_nodes" ADD CONSTRAINT "troubleshooting_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troubleshooting_nodes" ADD CONSTRAINT "troubleshooting_nodes_flow_id_troubleshooting_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "troubleshooting_flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vouchers" ADD CONSTRAINT "user_vouchers_template_id_voucher_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "voucher_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucher_id_user_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "user_vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_templates" ADD CONSTRAINT "voucher_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_templates" ADD CONSTRAINT "voucher_templates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_templates" ADD CONSTRAINT "voucher_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_access_items_tenant" ON "access_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_access_items_status" ON "access_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_access_items_visibility" ON "access_items" USING btree ("visibility_level");--> statement-breakpoint
CREATE INDEX "idx_access_policies_tenant" ON "access_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_access_view_logs_item" ON "access_view_logs" USING btree ("access_item_id");--> statement-breakpoint
CREATE INDEX "idx_access_view_logs_user" ON "access_view_logs" USING btree ("viewed_by");--> statement-breakpoint
CREATE INDEX "idx_advisor_attendance_correction_session" ON "advisor_attendance_corrections" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_advisor_attendance_correction_tenant" ON "advisor_attendance_corrections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_advisor_attendance_person_open" ON "advisor_attendance_sessions" USING btree ("person_id","check_out_at");--> statement-breakpoint
CREATE INDEX "idx_advisor_attendance_branch_date" ON "advisor_attendance_sessions" USING btree ("branch_id","check_in_date");--> statement-breakpoint
CREATE INDEX "idx_advisor_attendance_tenant" ON "advisor_attendance_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_attendance_one_open_session" ON "advisor_attendance_sessions" USING btree ("person_id") WHERE "advisor_attendance_sessions"."check_out_at" IS NULL AND "advisor_attendance_sessions"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_advisor_enrollment_token" ON "advisor_enrollment_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_advisor_enrollment_person" ON "advisor_enrollment_sessions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "idx_auth_otp_events_user" ON "auth_otp_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_auth_otp_events_phone" ON "auth_otp_events" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "idx_auth_otp_events_created" ON "auth_otp_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_auth_rate_limits_key" ON "auth_rate_limits" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_auth_rate_limits_expires" ON "auth_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_auth_reset_tokens_user" ON "auth_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_auth_reset_tokens_person" ON "auth_reset_tokens" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "idx_auth_reset_tokens_expires" ON "auth_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_beo_set_menu_selections_event" ON "beo_set_menu_selections" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_set_menu_selections_token" ON "beo_set_menu_selections" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_beo_set_menu_templates_tenant" ON "beo_set_menu_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_branch_events_branch" ON "branch_events" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_branch_events_start_time" ON "branch_events" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "idx_branch_events_branch_time" ON "branch_events" USING btree ("branch_id","start_time");--> statement-breakpoint
CREATE INDEX "idx_branches_tenant" ON "branches" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_branches_operator" ON "branches" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_tenant_calendar_color_unique" ON "branches" USING btree ("tenant_id",lower("calendar_color")) WHERE "branches"."calendar_color" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_casual_workers_tenant" ON "casual_workers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_casual_workers_branch" ON "casual_workers" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_casual_workers_status" ON "casual_workers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_casual_workers_dates" ON "casual_workers" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "idx_departments_tenant" ON "departments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_duty_blocks_employee_date" ON "duty_blocks" USING btree ("employee_id","date");--> statement-breakpoint
CREATE INDEX "idx_duty_blocks_branch_date" ON "duty_blocks" USING btree ("branch_id","date");--> statement-breakpoint
CREATE INDEX "idx_duty_blocks_assignment" ON "duty_blocks" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "idx_duty_types_tenant" ON "duty_types" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_employee_payroll_profiles_tenant" ON "employee_payroll_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_employee_payroll_profiles_operator" ON "employee_payroll_profiles" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_employee_payroll_profiles_employee" ON "employee_payroll_profiles" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_employee_presence_tenant" ON "employee_presence" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_time_off_tenant" ON "employee_time_off" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_time_off_employee_dates" ON "employee_time_off" USING btree ("employee_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "idx_time_off_branch_dates" ON "employee_time_off" USING btree ("branch_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "idx_employees_tenant" ON "employees" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_employees_user" ON "employees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_employees_phone_e164" ON "employees" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "idx_files_tenant_created" ON "files" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_kiosk_codes_branch" ON "kiosk_codes" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_kiosk_codes_hash" ON "kiosk_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_kiosk_devices_branch" ON "kiosk_devices" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_kiosk_devices_tenant" ON "kiosk_devices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_kiosk_sessions_device" ON "kiosk_sessions" USING btree ("kiosk_device_id");--> statement-breakpoint
CREATE INDEX "idx_kiosk_sessions_token" ON "kiosk_sessions" USING btree ("session_token_hash");--> statement-breakpoint
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
CREATE INDEX "idx_people_phone_e164" ON "people" USING btree ("phone_e164");--> statement-breakpoint
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
CREATE INDEX "idx_assignments_casual_worker" ON "schedule_assignments" USING btree ("casual_worker_id","shift_date");--> statement-breakpoint
CREATE INDEX "idx_assignments_week_plan" ON "schedule_assignments" USING btree ("week_plan_id");--> statement-breakpoint
CREATE INDEX "idx_assignments_borrowed" ON "schedule_assignments" USING btree ("is_borrowed");--> statement-breakpoint
CREATE INDEX "idx_assignments_type" ON "schedule_assignments" USING btree ("assignee_type");--> statement-breakpoint
CREATE INDEX "idx_assignments_role" ON "schedule_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_audit_tenant" ON "schedule_audit_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_audit_week_plan" ON "schedule_audit_log" USING btree ("week_plan_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_audit_created" ON "schedule_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_shift_breaks_tenant" ON "schedule_shift_breaks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shift_breaks_shift_date" ON "schedule_shift_breaks" USING btree ("shift_row_id","shift_date");--> statement-breakpoint
CREATE INDEX "idx_shift_breaks_assignment" ON "schedule_shift_breaks" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "idx_shift_breaks_employee_date" ON "schedule_shift_breaks" USING btree ("employee_id","shift_date");--> statement-breakpoint
CREATE INDEX "idx_schedule_shift_row_roles_tenant" ON "schedule_shift_row_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shift_row_roles_shift" ON "schedule_shift_row_roles" USING btree ("shift_row_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_shift_rows_tenant" ON "schedule_shift_rows" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shift_rows_week_plan" ON "schedule_shift_rows" USING btree ("week_plan_id","department_id");--> statement-breakpoint
CREATE INDEX "idx_shift_rows_branch_active" ON "schedule_shift_rows" USING btree ("branch_id","active_from_date","active_until_date");--> statement-breakpoint
CREATE INDEX "idx_template_assignments_row" ON "schedule_template_assignments" USING btree ("template_row_id");--> statement-breakpoint
CREATE INDEX "idx_tmpl_duty_blocks_assignment" ON "schedule_template_duty_blocks" USING btree ("template_assignment_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_template_row_roles_tenant" ON "schedule_template_row_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_template_row_roles_row" ON "schedule_template_row_roles" USING btree ("template_row_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_template_rows_tenant" ON "schedule_template_rows" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_template_rows_template" ON "schedule_template_rows" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_template_time_off_template" ON "schedule_template_time_off" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_template_time_off_tenant" ON "schedule_template_time_off" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_templates_tenant" ON "schedule_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_templates_branch" ON "schedule_templates" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_templates_shift_group" ON "schedule_templates" USING btree ("shift_group_id");--> statement-breakpoint
CREATE INDEX "idx_schedule_week_plans_tenant" ON "schedule_week_plans" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_week_plans_branch_week" ON "schedule_week_plans" USING btree ("branch_id","week_start_date");--> statement-breakpoint
CREATE INDEX "idx_shift_groups_tenant" ON "shift_groups" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shift_groups_branch" ON "shift_groups" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_shift_required_roles_tenant" ON "shift_required_roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shifts_tenant" ON "shifts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shifts_branch_date" ON "shifts" USING btree ("branch_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_shifts_employee_date" ON "shifts" USING btree ("employee_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_sick_leave_policies_tenant" ON "sick_leave_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sick_leave_policies_branch" ON "sick_leave_policies" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_staff_cost_allocations_tenant" ON "staff_cost_allocations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_staff_cost_allocations_employee" ON "staff_cost_allocations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_staff_cost_allocations_branch" ON "staff_cost_allocations" USING btree ("branch_id");--> statement-breakpoint
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
CREATE INDEX "idx_user_module_overrides_user" ON "user_module_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_module_overrides_tenant" ON "user_module_overrides" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_users_operator" ON "users" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_users_username" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_ask_oto_messages_thread" ON "ask_oto_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_ask_oto_messages_tenant" ON "ask_oto_messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_ask_oto_threads_user" ON "ask_oto_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ask_oto_threads_tenant" ON "ask_oto_threads" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_beo_assignment_targets_tenant" ON "beo_assignment_targets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_beo_bar_plans_event" ON "beo_bar_plans" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_entertainment_event" ON "beo_entertainment_assignments" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_entertainment_items_event" ON "beo_entertainment_items" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_entertainment_items_tenant" ON "beo_entertainment_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_beo_entertainment_options_tenant" ON "beo_entertainment_options" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_beo_entertainment_selections_event" ON "beo_entertainment_selections" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_event_billing_event" ON "beo_event_billing" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_kitchen_plans_event" ON "beo_kitchen_plans" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_locations_tenant" ON "beo_locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_beo_locations_branch" ON "beo_locations" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_beo_package_snapshot_items_snapshot" ON "beo_package_snapshot_items" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_beo_package_snapshots_event" ON "beo_package_snapshots" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_party_host_event" ON "beo_party_host_assignments" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_setup_item_options_tenant" ON "beo_setup_item_options" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_beo_setup_items_event" ON "beo_setup_items" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_setup_items_tenant" ON "beo_setup_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_beo_setup_plans_event" ON "beo_setup_plans" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_timeline_items_event" ON "beo_timeline_items" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_beo_timeline_items_sort" ON "beo_timeline_items" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_birthday_package_templates_tenant" ON "birthday_package_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_birthday_package_templates_active" ON "birthday_package_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_camp_attendance_reg" ON "camp_attendance" USING btree ("camp_registration_id");--> statement-breakpoint
CREATE INDEX "idx_camp_attendance_tenant_date" ON "camp_attendance" USING btree ("tenant_id","attendance_date");--> statement-breakpoint
CREATE INDEX "idx_camp_registrations_event" ON "camp_registrations" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_camp_registrations_tenant" ON "camp_registrations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_attachments_tenant" ON "checklist_attachments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_attachments_template" ON "checklist_attachments" USING btree ("checklist_template_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_attachments_item" ON "checklist_attachments" USING btree ("checklist_template_item_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_attachments_pending" ON "checklist_attachments" USING btree ("pending_checklist_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_run_items_tenant" ON "checklist_run_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_run_items_run" ON "checklist_run_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_run_items_result" ON "checklist_run_items" USING btree ("result_status");--> statement-breakpoint
CREATE INDEX "idx_checklist_runs_tenant" ON "checklist_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_runs_branch" ON "checklist_runs" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_runs_assigned" ON "checklist_runs" USING btree ("assigned_to");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_checklist_runs_period" ON "checklist_runs" USING btree ("tenant_id","template_id","branch_id","period_start") WHERE "checklist_runs"."period_start" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_checklist_template_items_tenant" ON "checklist_template_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_template_items_template" ON "checklist_template_items" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_template_items_department" ON "checklist_template_items" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_tenant" ON "checklist_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_branch" ON "checklist_templates" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_location" ON "checklist_templates" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_type" ON "checklist_templates" USING btree ("checklist_type");--> statement-breakpoint
CREATE INDEX "idx_core_events_tenant" ON "core_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_core_events_branch" ON "core_events" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_core_events_date" ON "core_events" USING btree ("event_date");--> statement-breakpoint
CREATE INDEX "idx_core_events_archived" ON "core_events" USING btree ("is_archived");--> statement-breakpoint
CREATE INDEX "idx_directory_cache_tenant" ON "directory_cache" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_directory_cache_branch_key" ON "directory_cache" USING btree ("branch_id","cache_key");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_tenant" ON "dropoff_checkins" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_branch" ON "dropoff_checkins" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_created_at" ON "dropoff_checkins" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_dropoff_checkins_status" ON "dropoff_checkins" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_dropoff_form_versions_form" ON "dropoff_form_versions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "idx_dropoff_form_versions_version" ON "dropoff_form_versions" USING btree ("form_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_dropoff_forms_tenant" ON "dropoff_forms" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_dropoff_forms_branch" ON "dropoff_forms" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "era_tenant_idx" ON "employee_role_availability" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "era_employee_idx" ON "employee_role_availability" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "era_date_idx" ON "employee_role_availability" USING btree ("unavailable_date");--> statement-breakpoint
CREATE INDEX "era_employee_role_date_idx" ON "employee_role_availability" USING btree ("employee_id","role_id","unavailable_date");--> statement-breakpoint
CREATE INDEX "idx_entertainment_package_templates_tenant" ON "entertainment_package_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_entertainment_package_templates_active" ON "entertainment_package_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_escalations_tenant" ON "escalations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_escalations_issue" ON "escalations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "idx_event_line_item_templates_tenant" ON "event_line_item_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_event_line_item_templates_category" ON "event_line_item_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_event_line_item_templates_active" ON "event_line_item_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_event_line_items_event" ON "event_line_items" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_line_items_template" ON "event_line_items" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_event_line_items_sort" ON "event_line_items" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_event_statuses_tenant" ON "event_statuses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_fix_comments_fix" ON "fix_comments" USING btree ("fix_id");--> statement-breakpoint
CREATE INDEX "idx_fix_comments_created" ON "fix_comments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_tenant" ON "fix_reports" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_branch" ON "fix_reports" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_status" ON "fix_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_created" ON "fix_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_priority" ON "fix_reports" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_scheduled" ON "fix_reports" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_dept" ON "fix_reports" USING btree ("assigned_department_id");--> statement-breakpoint
CREATE INDEX "idx_fix_reports_source_checklist_item" ON "fix_reports" USING btree ("source_checklist_run_item_id");--> statement-breakpoint
CREATE INDEX "idx_fix_supplier_tokens_tenant" ON "fix_supplier_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_fix_supplier_tokens_hash" ON "fix_supplier_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_fix_supplier_tokens_enabled" ON "fix_supplier_tokens" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "idx_guest_invite_tokens_event" ON "guest_invite_tokens" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_guest_invite_tokens_token" ON "guest_invite_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_hiring_media_tenant" ON "hiring_media_assets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_hiring_media_branch" ON "hiring_media_assets" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_hiring_media_mood" ON "hiring_media_assets" USING btree ("mood");--> statement-breakpoint
CREATE INDEX "idx_i18n_translations_version" ON "i18n_translations" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "idx_i18n_translations_lookup" ON "i18n_translations" USING btree ("version_id","lang","key");--> statement-breakpoint
CREATE INDEX "idx_invitation_designs_event" ON "invitation_designs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_issues_tenant" ON "issues" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_issues_branch" ON "issues" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_issues_status" ON "issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_kb_versions_article" ON "kb_article_versions" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_kb_versions_tenant" ON "kb_article_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_tenant" ON "kb_articles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_status" ON "kb_articles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_type" ON "kb_articles" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_branch_scope" ON "kb_articles" USING btree ("branch_scope");--> statement-breakpoint
CREATE INDEX "idx_knowledge_chunks_file" ON "knowledge_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_chunks_tenant" ON "knowledge_chunks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_files_tenant" ON "knowledge_files" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_files_branch" ON "knowledge_files" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_files_status" ON "knowledge_files" USING btree ("index_status");--> statement-breakpoint
CREATE INDEX "idx_knowledge_files_active" ON "knowledge_files" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_location_branch_location" ON "location_branch_access" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "idx_location_branch_branch" ON "location_branch_access" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_locations_tenant" ON "locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_locations_parent" ON "locations" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_module_completions_tenant" ON "module_completions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_module_completions_module" ON "module_completions" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_module_completions_user" ON "module_completions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_tenant" ON "nanny_reservations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_branch" ON "nanny_reservations" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_nanny" ON "nanny_reservations" USING btree ("nanny_employee_id");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_date" ON "nanny_reservations" USING btree ("reservation_date");--> statement-breakpoint
CREATE INDEX "idx_nanny_reservations_status" ON "nanny_reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient" ON "notifications" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient_unread" ON "notifications" USING btree ("recipient_user_id","is_read");--> statement-breakpoint
CREATE INDEX "idx_notifications_created" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_reference" ON "notifications" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_tenant" ON "org_nodes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_mode" ON "org_nodes" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_scope" ON "org_nodes" USING btree ("scope_type","scope_branch_id");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_employee" ON "org_nodes" USING btree ("person_employee_id");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_reports_to" ON "org_nodes" USING btree ("reports_to_node_id");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_department" ON "org_nodes" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "idx_package_line_item_templates_package" ON "package_line_item_templates" USING btree ("package_template_id");--> statement-breakpoint
CREATE INDEX "idx_parent_message_logs_event" ON "parent_message_logs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_parent_portal_tokens_event" ON "parent_portal_tokens" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_parent_portal_tokens_token" ON "parent_portal_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_tenant" ON "quiz_attempts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_module" ON "quiz_attempts" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_attempts_user" ON "quiz_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_questions_tenant" ON "quiz_questions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_quiz_questions_module" ON "quiz_questions" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_rsvp_entries_event" ON "rsvp_entries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_rsvp_entries_status" ON "rsvp_entries" USING btree ("event_id","attending_status");--> statement-breakpoint
CREATE INDEX "idx_rsvp_entries_guest_identifier" ON "rsvp_entries" USING btree ("event_id","guest_identifier");--> statement-breakpoint
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
CREATE INDEX "idx_task_activities_tenant" ON "task_activities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_activities_task" ON "task_activities" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_activities_branch" ON "task_activities" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_task_activities_created" ON "task_activities" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_task_assignments_task" ON "task_assignments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_assignments_type_id" ON "task_assignments" USING btree ("assignment_type","assignment_id");--> statement-breakpoint
CREATE INDEX "idx_task_assignments_tenant" ON "task_assignments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_attachments_tenant" ON "task_attachments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_attachments_task" ON "task_attachments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_checklist_items_tenant" ON "task_checklist_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_checklist_items_task" ON "task_checklist_items" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_comments_tenant" ON "task_comments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_comments_task" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_comments_created" ON "task_comments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_task_completions_tenant" ON "task_completions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_completions_task" ON "task_completions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_questions_tenant" ON "task_questions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_questions_task" ON "task_questions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_template_questions_tenant" ON "task_template_questions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_template_questions_template" ON "task_template_questions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_task_templates_tenant" ON "task_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_task_templates_active" ON "task_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_task_templates_level" ON "task_templates" USING btree ("task_level");--> statement-breakpoint
CREATE INDEX "idx_tasks_tenant" ON "tasks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_branch" ON "tasks" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_assigned" ON "tasks" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_tasks_assigned_employee" ON "tasks" USING btree ("assigned_employee_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_due_at" ON "tasks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_start_at" ON "tasks" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_event" ON "tasks" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_recurring_def" ON "tasks" USING btree ("is_recurring_definition");--> statement-breakpoint
CREATE INDEX "idx_tasks_parent" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_level" ON "tasks" USING btree ("task_level");--> statement-breakpoint
CREATE INDEX "idx_tasks_escalated" ON "tasks" USING btree ("escalated");--> statement-breakpoint
CREATE INDEX "idx_tasks_archived" ON "tasks" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "idx_training_modules_tenant" ON "training_modules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_training_modules_branch" ON "training_modules" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_translation_jobs_version" ON "translation_jobs" USING btree ("version_id");--> statement-breakpoint
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