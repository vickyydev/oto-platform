import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  uuid,
  real,
  date,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { tenants, branches, departments, users, employees, roles } from "../../shared/schema";

// ============================================
// CORE MODULE ENUMS
// ============================================

export const coreIssueStatusEnum = pgEnum("core_issue_status", [
  "open",
  "in_progress",
  "acknowledged",
  "resolved",
  "closed",
  "escalated",
]);

export const coreIssuePriorityEnum = pgEnum("core_issue_priority", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const coreEscalationStatusEnum = pgEnum("core_escalation_status", [
  "pending",
  "acknowledged",
  "resolved",
  "dismissed",
]);

export const fixReportStatusEnum = pgEnum("fix_report_status", [
  "new",
  "in_progress",
  "fixed",
  "closed",
  "pending", // New status for Fix Board
  "done", // New status for Fix Board
]);

export const fixReportPriorityEnum = pgEnum("fix_report_priority", [
  "urgent",
  "high",
  "normal",
  "low",
]);

export const fixCommentAuthorTypeEnum = pgEnum("fix_comment_author_type", [
  "staff_user",
  "supplier_token",
]);

export const coreChecklistStatusEnum = pgEnum("core_checklist_status", [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "issues",
  "missed",
]);

export const checklistTypeEnum = pgEnum("checklist_type", [
  "operational",
  "checker",
]);

export const checkerResultStatusEnum = pgEnum("checker_result_status", [
  "pass",
  "fail",
]);

export const coreTaskStatusEnum = pgEnum("core_task_status", [
  "pending",
  "in_progress",
  "completed",
  "overdue",
  "cancelled",
  "blocked",
]);

export const coreTaskRecurrenceEnum = pgEnum("core_task_recurrence", [
  "once",
  "daily",
  "weekly",
  "monthly",
]);

export const coreTaskLevelEnum = pgEnum("core_task_level", [
  "line",
  "management",
  "strategic",
]);

export const coreQuestionTypeEnum = pgEnum("core_question_type", [
  "text",
  "number",
  "boolean",
  "single_choice",
  "multi_choice",
  "photo",
  "signature",
]);

export const coreEventTypeEnum = pgEnum("core_event_type", [
  "birthday",
  "private_event",
  "school_group",
  "other",
  "studio_event",
  "workshop",
  "camp",
]);

export const coreVoucherStatusEnum = pgEnum("core_voucher_status", [
  "active",
  "expired",
  "redeemed",
  "cancelled",
]);

export const coreBranchScopeEnum = pgEnum("core_branch_scope", [
  "ALL",
  "SELECTED",
]);

export const coreCheckinStatusEnum = pgEnum("core_checkin_status", [
  "registered",
  "in_park",
  "checked_out",
]);

export const coreTemplateQuestionTypeEnum = pgEnum("core_template_question_type", [
  "text",
  "choice",
  "boolean",
]);

export const kbArticleTypeEnum = pgEnum("kb_article_type", [
  "SOP",
  "Policy",
  "Safety",
  "Checklist",
  "Script",
  "FAQ",
  "Training",
  "Maintenance",
]);

export const kbArticleStatusEnum = pgEnum("kb_article_status", [
  "draft",
  "published",
  "archived",
]);

export const kbDepartmentEnum = pgEnum("kb_department", [
  "Front Desk",
  "Cafe",
  "Floor Staff",
  "Cleaning",
  "Maintenance",
  "Birthday / Events",
  "Management",
  "Admin",
]);

export const kbRoleEnum = pgEnum("kb_role", [
  "Reception",
  "Barista",
  "Party Host",
  "Floor Staff",
  "Cleaner",
  "Technician",
  "Supervisor",
  "Manager",
]);

// ============================================
// DIRECTORY CACHE (optional)
// ============================================

export const directoryCache = pgTable(
  "directory_cache",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),
    cacheKey: text("cache_key").notNull(),
    cacheData: jsonb("cache_data").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_directory_cache_tenant").on(t.tenantId),
    index("idx_directory_cache_branch_key").on(t.branchId, t.cacheKey),
  ]
);

export const insertDirectoryCacheSchema = createInsertSchema(directoryCache).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDirectoryCache = z.infer<typeof insertDirectoryCacheSchema>;
export type DirectoryCache = typeof directoryCache.$inferSelect;

// ============================================
// DIRECTORY CLIENTS (a service caller that names its tenant)
// ============================================

// The directory API's HR reads authenticate one shared key
// (HR_DIRECTORY_API_KEY), and a shared key says nothing about whose data the
// caller may touch. The write routes added for the POS seam
// (server/directory/eventRoutes.ts) take one of these instead: a key issued
// to one caller for one tenant, kept here only as its sha256, so a request is
// confined to that tenant by the key it presents rather than by anything it
// writes in the body. `script/directory-client.mjs` issues and revokes them.
export const DIRECTORY_CLIENT_SCOPES = ["events:write"] as const;
export type DirectoryClientScope = (typeof DIRECTORY_CLIENT_SCOPES)[number];

export const directoryClients = pgTable(
  "directory_clients",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    isActive: boolean("is_active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_directory_clients_tenant").on(t.tenantId),
  ]
);

export type DirectoryClient = typeof directoryClients.$inferSelect;

// ============================================
// LOCATIONS (for tagging checklists/tasks)
// ============================================

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    parentId: uuid("parent_id"), // Self-reference for sublocations - added manually below
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    tags: text("tags").array().default([]), // Tags for filtering (e.g., "Birthday", "Workshop")
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_locations_tenant").on(t.tenantId),
    index("idx_locations_parent").on(t.parentId),
  ]
);

// Link locations to specific branches (if empty, available to all branches)
export const locationBranchAccess = pgTable(
  "location_branch_access",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }).notNull(),
    branchId: varchar("branch_id").references(() => branches.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_location_branch_location").on(t.locationId),
    index("idx_location_branch_branch").on(t.branchId),
  ]
);

export const insertLocationSchema = createInsertSchema(locations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertLocationBranchAccessSchema = createInsertSchema(locationBranchAccess).omit({
  id: true,
  createdAt: true,
});
export type InsertLocation = z.infer<typeof insertLocationSchema>;
export type Location = typeof locations.$inferSelect;
export type LocationBranchAccess = typeof locationBranchAccess.$inferSelect;

// ============================================
// CHECKLISTS
// ============================================

export const checklistTemplates = pgTable(
  "checklist_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id),
    branchIds: jsonb("branch_ids").$type<string[]>().default([]), // Multi-branch support
    departmentId: varchar("department_id").references(() => departments.id),
    locationId: uuid("location_id").references(() => locations.id), // Location tag
    name: text("name").notNull(),
    description: text("description"),
    checklistType: checklistTypeEnum("checklist_type").notNull().default("operational"),
    isActive: boolean("is_active").notNull().default(true),
    recurrence: coreTaskRecurrenceEnum("recurrence").default("once"),
    weeklyDays: jsonb("weekly_days").$type<string[]>().default([]),
    monthlyDay: integer("monthly_day"),
    scheduledTime: text("scheduled_time"),
    // Checker scheduling - up to 5 daily rounds
    checkerRounds: integer("checker_rounds").default(2), // Number of rounds per day (1-5)
    scheduleTime1: text("schedule_time_1"), // e.g. "10:30" for round 1
    scheduleTime2: text("schedule_time_2"), // e.g. "15:30" for round 2
    scheduleTime3: text("schedule_time_3"), // e.g. "18:00" for round 3
    scheduleTime4: text("schedule_time_4"), // e.g. "20:00" for round 4
    scheduleTime5: text("schedule_time_5"), // e.g. "22:00" for round 5
    referenceMediaUrls: jsonb("reference_media_urls").$type<string[]>().default([]), // Photos/videos for staff to reference
    requiresPhotoEvidence: boolean("requires_photo_evidence").notNull().default(false), // Photo evidence for entire checklist
    templateVersion: integer("template_version").notNull().default(1), // Incremented on each template update
    // Assignment fields - checklist visible only to assigned entity
    assignedEmployeeId: varchar("assigned_employee_id").references(() => employees.id),
    assignedRoleId: varchar("assigned_role_id"),
    assignedDepartmentId: varchar("assigned_department_id").references(() => departments.id),
    // Checker-specific: allowed roles for execution (JSON array of role names)
    allowedCheckerRoles: jsonb("allowed_checker_roles").$type<string[]>().default([]),
    createdBy: varchar("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_checklist_templates_tenant").on(t.tenantId),
    index("idx_checklist_templates_branch").on(t.branchId),
    index("idx_checklist_templates_location").on(t.locationId),
    index("idx_checklist_templates_type").on(t.checklistType),
  ]
);

export const checklistTemplateItems = pgTable(
  "checklist_template_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    templateId: uuid("template_id")
      .references(() => checklistTemplates.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    referenceMediaUrls: jsonb("reference_media_urls").$type<string[]>().default([]), // Photos/videos showing how item should look
    requiresNote: boolean("requires_note").default(false),
    requiresPhoto: boolean("requires_photo").default(false), // Photo evidence required for this item
    cameraEnabled: boolean("camera_enabled").notNull().default(true),
    galleryEnabled: boolean("gallery_enabled").notNull().default(false),
    isCritical: boolean("is_critical").default(false),
    linkedToFix: boolean("linked_to_fix").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    // Checker-specific fields
    departmentId: varchar("department_id").references(() => departments.id), // Required for CHECKER type items
    zoneLabel: text("zone_label"), // Optional grouping label for visual organization
  },
  (t) => [
    index("idx_checklist_template_items_tenant").on(t.tenantId),
    index("idx_checklist_template_items_template").on(t.templateId),
    index("idx_checklist_template_items_department").on(t.departmentId),
  ]
);

export const checklistRuns = pgTable(
  "checklist_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    templateId: uuid("template_id").references(() => checklistTemplates.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),
    assignedTo: varchar("assigned_to").references(() => users.id),
    status: coreChecklistStatusEnum("status").default("pending"),
    templateVersionApplied: integer("template_version_applied").notNull().default(1), // Version of template when run was created/last synced
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    completedBy: varchar("completed_by").references(() => users.id),
    dueAt: timestamp("due_at"),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end"),
    missedAt: timestamp("missed_at"),
    responsibleStaff: jsonb("responsible_staff").$type<Array<{
      employeeId?: string | null;
      userId?: string | null;
      name: string;
      roleName?: string | null;
    }>>().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_checklist_runs_tenant").on(t.tenantId),
    index("idx_checklist_runs_branch").on(t.branchId),
    index("idx_checklist_runs_assigned").on(t.assignedTo),
    uniqueIndex("uq_checklist_runs_period")
      .on(t.tenantId, t.templateId, t.branchId, t.periodStart)
      .where(sql`${t.periodStart} IS NOT NULL`),
  ]
);

export const checklistRunItems = pgTable(
  "checklist_run_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    runId: uuid("run_id")
      .references(() => checklistRuns.id, { onDelete: "cascade" })
      .notNull(),
    templateItemId: uuid("template_item_id")
      .references(() => checklistTemplateItems.id)
      .notNull(),
    isCompleted: boolean("is_completed").notNull().default(false),
    response: jsonb("response"),
    photoUrl: text("photo_url"), // Legacy single photo field
    photoEvidenceUrls: jsonb("photo_evidence_urls").$type<string[]>().default([]), // Multiple photo evidence
    note: text("note"), // Staff notes for this item
    completedBy: varchar("completed_by").references(() => users.id),
    completedAt: timestamp("completed_at"),
    // Checker-specific fields
    resultStatus: checkerResultStatusEnum("result_status"), // PASS or FAIL for checker items
    failNote: text("fail_note"), // Required when FAIL
    failPhotoUrl: text("fail_photo_url"), // Required when FAIL
    createdTaskId: uuid("created_task_id"), // FK to tasks table (filled when FAIL creates a task)
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_checklist_run_items_tenant").on(t.tenantId),
    index("idx_checklist_run_items_run").on(t.runId),
    index("idx_checklist_run_items_result").on(t.resultStatus),
  ]
);

// Insert schemas
export const insertChecklistTemplateSchema = createInsertSchema(checklistTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertChecklistTemplateItemSchema = createInsertSchema(checklistTemplateItems).omit({ id: true });
export const insertChecklistRunSchema = createInsertSchema(checklistRuns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertChecklistRunItemSchema = createInsertSchema(checklistRunItems).omit({ id: true, createdAt: true });

// Types for checklists
export type InsertChecklistTemplate = z.infer<typeof insertChecklistTemplateSchema>;
export type ChecklistTemplate = typeof checklistTemplates.$inferSelect;
export type InsertChecklistTemplateItem = z.infer<typeof insertChecklistTemplateItemSchema>;
export type ChecklistTemplateItem = typeof checklistTemplateItems.$inferSelect;
export type InsertChecklistRun = z.infer<typeof insertChecklistRunSchema>;
export type ChecklistRun = typeof checklistRuns.$inferSelect;
export type InsertChecklistRunItem = z.infer<typeof insertChecklistRunItemSchema>;
export type ChecklistRunItem = typeof checklistRunItems.$inferSelect;

// ============================================
// CHECKLIST ATTACHMENTS (Media files for checklists)
// ============================================

export const checklistAttachmentTypeEnum = pgEnum("checklist_attachment_type", [
  "image",
  "video",
]);

export const checklistAttachments = pgTable(
  "checklist_attachments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    // Exactly one of these must be non-null (or pending fields for during-creation uploads)
    checklistTemplateId: uuid("checklist_template_id").references(() => checklistTemplates.id, { onDelete: "cascade" }),
    checklistTemplateItemId: uuid("checklist_template_item_id").references(() => checklistTemplateItems.id, { onDelete: "cascade" }),
    // For uploads during checklist creation (before the checklist exists)
    pendingChecklistId: uuid("pending_checklist_id"), // Temporary ID used during creation
    pendingItemIndex: integer("pending_item_index"), // Item index (0-based) for pending item uploads
    // File info
    type: checklistAttachmentTypeEnum("type").notNull(),
    s3Key: text("s3_key").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    originalFilename: text("original_filename"),
    // Dimensions for images/videos
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"), // For videos
    // Metadata
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_checklist_attachments_tenant").on(t.tenantId),
    index("idx_checklist_attachments_template").on(t.checklistTemplateId),
    index("idx_checklist_attachments_item").on(t.checklistTemplateItemId),
    index("idx_checklist_attachments_pending").on(t.pendingChecklistId),
  ]
);

export const insertChecklistAttachmentSchema = createInsertSchema(checklistAttachments).omit({
  id: true,
  createdAt: true,
});
export type InsertChecklistAttachment = z.infer<typeof insertChecklistAttachmentSchema>;
export type ChecklistAttachment = typeof checklistAttachments.$inferSelect;

// ============================================
// TASK TEMPLATES (Studio creates these)
// ============================================

export const taskTemplates = pgTable(
  "task_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    title: text("title").notNull(),
    description: text("description"),

    branchScope: coreBranchScopeEnum("branch_scope").notNull().default("ALL"),
    branchIds: jsonb("branch_ids").$type<string[]>().default([]),
    departmentId: varchar("department_id").references(() => departments.id),

    recurrence: coreTaskRecurrenceEnum("recurrence").notNull().default("once"),
    weeklyDays: jsonb("weekly_days").$type<string[]>().default([]),
    monthlyDay: integer("monthly_day"),
    preferredDueTime: text("preferred_due_time"),

    requiresPhotoEvidence: boolean("requires_photo_evidence").notNull().default(false),
    requiresResponses: boolean("requires_responses").notNull().default(false),

    taskLevel: coreTaskLevelEnum("task_level").notNull().default("line"),

    isActive: boolean("is_active").notNull().default(true),

    createdBy: varchar("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_task_templates_tenant").on(t.tenantId),
    index("idx_task_templates_active").on(t.isActive),
    index("idx_task_templates_level").on(t.taskLevel),
  ]
);

export const taskTemplateQuestions = pgTable(
  "task_template_questions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    templateId: uuid("template_id")
      .references(() => taskTemplates.id, { onDelete: "cascade" })
      .notNull(),
    prompt: text("prompt").notNull(),
    questionType: coreTemplateQuestionTypeEnum("question_type").notNull().default("text"),
    options: text("options").array(),
    isRequired: boolean("is_required").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("idx_task_template_questions_tenant").on(t.tenantId),
    index("idx_task_template_questions_template").on(t.templateId),
  ]
);

export const insertTaskTemplateSchema = createInsertSchema(taskTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTaskTemplate = z.infer<typeof insertTaskTemplateSchema>;
export type TaskTemplate = typeof taskTemplates.$inferSelect;

export const insertTaskTemplateQuestionSchema = createInsertSchema(taskTemplateQuestions).omit({ id: true });
export type InsertTaskTemplateQuestion = z.infer<typeof insertTaskTemplateQuestionSchema>;
export type TaskTemplateQuestion = typeof taskTemplateQuestions.$inferSelect;

// ============================================
// TASKS (MODERN MODEL A) - Instances generated from templates
// ============================================

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    templateId: uuid("template_id").references(() => taskTemplates.id),
    generatedForDate: text("generated_for_date"),
    eventId: uuid("event_id").references(() => coreEvents.id),

    branchId: varchar("branch_id").references(() => branches.id),
    departmentId: varchar("department_id").references(() => departments.id),

    title: text("title").notNull(),
    description: text("description"),

    status: coreTaskStatusEnum("status").notNull().default("pending"),
    priority: coreIssuePriorityEnum("priority").notNull().default("medium"),
    recurrence: coreTaskRecurrenceEnum("recurrence").notNull().default("once"),
    weeklyDays: jsonb("weekly_days").$type<string[]>().default([]),
    monthlyDay: integer("monthly_day"),
    preferredDueTime: text("preferred_due_time"),
    isRecurringDefinition: boolean("is_recurring_definition").notNull().default(false),
    parentTaskId: uuid("parent_task_id"),

    dueAt: timestamp("due_at"),
    startAt: timestamp("start_at"),
    scheduledMode: boolean("scheduled_mode").notNull().default(false),
    progressPercent: integer("progress_percent").notNull().default(0),
    statusManualOverride: boolean("status_manual_override").notNull().default(false),
    blockedReason: text("blocked_reason"),
    completedAt: timestamp("completed_at"),
    assignedTo: varchar("assigned_to").references(() => users.id),
    assignedEmployeeId: varchar("assigned_employee_id").references(() => employees.id),
    assignedRoleId: varchar("assigned_role_id").references(() => roles.id),
    assignedDepartmentId: varchar("assigned_department_id").references(() => departments.id),

    requiresPhotoEvidence: boolean("requires_photo_evidence").notNull().default(false),
    requiresResponses: boolean("requires_responses").notNull().default(false),
    referencePhotoUrl: text("reference_photo_url"),

    taskLevel: coreTaskLevelEnum("task_level").notNull().default("line"),
    escalated: boolean("escalated").notNull().default(false),
    lastMovementAt: timestamp("last_movement_at").defaultNow(),
    ownerUserId: varchar("owner_user_id").references(() => users.id),
    archivedAt: timestamp("archived_at"),

    createdBy: varchar("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_tasks_tenant").on(t.tenantId),
    index("idx_tasks_branch").on(t.branchId),
    index("idx_tasks_assigned").on(t.assignedTo),
    index("idx_tasks_assigned_employee").on(t.assignedEmployeeId),
    index("idx_tasks_due_at").on(t.dueAt),
    index("idx_tasks_start_at").on(t.startAt),
    index("idx_tasks_event").on(t.eventId),
    index("idx_tasks_recurring_def").on(t.isRecurringDefinition),
    index("idx_tasks_parent").on(t.parentTaskId),
    index("idx_tasks_level").on(t.taskLevel),
    index("idx_tasks_escalated").on(t.escalated),
    index("idx_tasks_archived").on(t.archivedAt),
  ]
);

export const taskAssignmentTypeEnum = pgEnum("task_assignment_type", [
  "employee", "advisor", "role", "department", "branch",
]);

export const taskAssignments = pgTable(
  "task_assignments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    assignmentType: taskAssignmentTypeEnum("assignment_type").notNull(),
    assignmentId: varchar("assignment_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_task_assignments_task").on(t.taskId),
    index("idx_task_assignments_type_id").on(t.assignmentType, t.assignmentId),
    index("idx_task_assignments_tenant").on(t.tenantId),
  ]
);

export const insertTaskAssignmentSchema = createInsertSchema(taskAssignments).omit({ id: true, createdAt: true });
export type InsertTaskAssignment = z.infer<typeof insertTaskAssignmentSchema>;
export type TaskAssignment = typeof taskAssignments.$inferSelect;

export const taskQuestions = pgTable(
  "task_questions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    prompt: text("prompt").notNull(),
    questionType: coreQuestionTypeEnum("question_type").default("text"),
    options: text("options").array(),
    isRequired: boolean("is_required").default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("idx_task_questions_tenant").on(t.tenantId),
    index("idx_task_questions_task").on(t.taskId),
  ]
);

export const taskCompletions = pgTable(
  "task_completions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    completedBy: varchar("completed_by").references(() => users.id).notNull(),

    responses: jsonb("responses").$type<Record<string, unknown>>(),
    photoUrls: jsonb("photo_urls").$type<string[]>(),
    note: text("note"),

    completedAt: timestamp("completed_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_task_completions_tenant").on(t.tenantId),
    index("idx_task_completions_task").on(t.taskId),
  ]
);

export const taskActivityTypeEnum = pgEnum("task_activity_type", [
  "created",
  "status_changed",
  "completed",
  "progress_updated",
  "blocked",
  "unblocked",
  "priority_changed",
  "assigned",
  "escalated",
  "de_escalated",
  "edited",
  "comment_added",
  "attachment_added",
  "attachment_removed",
  "checklist_item_added",
  "checklist_item_checked",
  "checklist_item_unchecked",
  "checklist_item_removed",
  "due_date_changed",
  "description_changed",
]);

export const taskActivities = pgTable(
  "task_activities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    branchId: varchar("branch_id").references(() => branches.id),
    activityType: taskActivityTypeEnum("activity_type").notNull(),
    description: text("description").notNull(),
    userId: varchar("user_id").references(() => users.id),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_task_activities_tenant").on(t.tenantId),
    index("idx_task_activities_task").on(t.taskId),
    index("idx_task_activities_branch").on(t.branchId),
    index("idx_task_activities_created").on(t.createdAt),
  ]
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    authorId: varchar("author_id").references(() => users.id).notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_task_comments_tenant").on(t.tenantId),
    index("idx_task_comments_task").on(t.taskId),
    index("idx_task_comments_created").on(t.createdAt),
  ]
);

export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    fileName: text("file_name").notNull(),
    fileUrl: text("file_url").notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: text("mime_type").notNull(),
    uploadedBy: varchar("uploaded_by").references(() => users.id).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_task_attachments_tenant").on(t.tenantId),
    index("idx_task_attachments_task").on(t.taskId),
  ]
);

export const taskChecklistItems = pgTable(
  "task_checklist_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    isChecked: boolean("is_checked").default(false).notNull(),
    dueAt: timestamp("due_at"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_task_checklist_items_tenant").on(t.tenantId),
    index("idx_task_checklist_items_task").on(t.taskId),
  ]
);

export const insertTaskSchema = createInsertSchema(tasks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTaskQuestionSchema = createInsertSchema(taskQuestions).omit({ id: true });
export const insertTaskCompletionSchema = createInsertSchema(taskCompletions).omit({ id: true, completedAt: true });
export const insertTaskActivitySchema = createInsertSchema(taskActivities).omit({ id: true, createdAt: true });
export const insertTaskCommentSchema = createInsertSchema(taskComments).omit({ id: true, createdAt: true });
export const insertTaskAttachmentSchema = createInsertSchema(taskAttachments).omit({ id: true, createdAt: true });
export const insertTaskChecklistItemSchema = createInsertSchema(taskChecklistItems).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;
export type TaskQuestion = typeof taskQuestions.$inferSelect;
export type TaskCompletion = typeof taskCompletions.$inferSelect;
export type TaskActivity = typeof taskActivities.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type InsertTaskComment = z.infer<typeof insertTaskCommentSchema>;
export type TaskAttachment = typeof taskAttachments.$inferSelect;
export type InsertTaskAttachment = z.infer<typeof insertTaskAttachmentSchema>;
export type TaskChecklistItem = typeof taskChecklistItems.$inferSelect;
export type InsertTaskChecklistItem = z.infer<typeof insertTaskChecklistItemSchema>;

// ============================================
// ISSUES & ESCALATIONS
// ============================================

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),
    departmentId: varchar("department_id").references(() => departments.id),

    title: text("title").notNull(),
    description: text("description"),

    status: coreIssueStatusEnum("status").notNull().default("open"),
    priority: coreIssuePriorityEnum("priority").notNull().default("medium"),

    category: text("category"),
    photoUrls: jsonb("photo_urls").$type<string[]>(),

    reportedBy: varchar("reported_by").references(() => users.id),
    assignedTo: varchar("assigned_to").references(() => users.id),
    resolvedBy: varchar("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at"),
    resolutionNotes: text("resolution_notes"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_issues_tenant").on(t.tenantId),
    index("idx_issues_branch").on(t.branchId),
    index("idx_issues_status").on(t.status),
  ]
);

export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }).notNull(),

    escalatedTo: varchar("escalated_to").references(() => users.id).notNull(),
    escalatedBy: varchar("escalated_by").references(() => users.id).notNull(),

    status: coreEscalationStatusEnum("status").notNull().default("pending"),
    reason: text("reason"),
    acknowledgedAt: timestamp("acknowledged_at"),
    resolvedAt: timestamp("resolved_at"),
    notes: text("notes"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_escalations_tenant").on(t.tenantId),
    index("idx_escalations_issue").on(t.issueId),
  ]
);

export const insertIssueSchema = createInsertSchema(issues).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEscalationSchema = createInsertSchema(escalations).omit({ id: true, createdAt: true, updatedAt: true });

// ============================================
// FIX REPORTS (Camera-first quick issue reporting)
// ============================================

export const fixReports = pgTable(
  "fix_reports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),

    reportedBy: varchar("reported_by").references(() => users.id).notNull(),
    reportedByName: text("reported_by_name"),

    // Content
    title: text("title").notNull(),
    description: text("description"),
    media: jsonb("media").$type<string[]>().notNull().default([]),
    note: text("note"),
    
    // Location - references locations table + optional free text note
    locationId: uuid("location_id").references(() => locations.id),
    location: text("location").notNull(), // Legacy free-text field kept for backward compatibility
    locationNote: text("location_note"), // Additional notes like "near slide entrance"
    
    tags: jsonb("tags").$type<string[]>().default([]),
    priority: fixReportPriorityEnum("priority").notNull().default("normal"),

    status: fixReportStatusEnum("status").notNull().default("pending"),
    
    // Scheduling
    scheduledAt: timestamp("scheduled_at"),
    
    // Department assignment (auto-set from fix_department_id setting on creation)
    assignedDepartmentId: varchar("assigned_department_id").references(() => departments.id),
    sourceChecklistRunItemId: uuid("source_checklist_run_item_id")
      .references(() => checklistRunItems.id, { onDelete: "set null" }),

    // Closure
    closedAt: timestamp("closed_at"),
    closedByUserId: varchar("closed_by_user_id").references(() => users.id),
    closedBySupplierTokenId: uuid("closed_by_supplier_token_id"), // Will reference fix_supplier_tokens
    doneNote: text("done_note"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_fix_reports_tenant").on(t.tenantId),
    index("idx_fix_reports_branch").on(t.branchId),
    index("idx_fix_reports_status").on(t.status),
    index("idx_fix_reports_created").on(t.createdAt),
    index("idx_fix_reports_priority").on(t.priority),
    index("idx_fix_reports_scheduled").on(t.scheduledAt),
    index("idx_fix_reports_dept").on(t.assignedDepartmentId),
    index("idx_fix_reports_source_checklist_item").on(t.sourceChecklistRunItemId),
  ]
);

export const insertFixReportSchema = createInsertSchema(fixReports).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFixReport = z.infer<typeof insertFixReportSchema>;
export type FixReport = typeof fixReports.$inferSelect;

// ============================================
// FIX COMMENTS
// ============================================

export const fixComments = pgTable(
  "fix_comments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    fixId: uuid("fix_id").references(() => fixReports.id, { onDelete: "cascade" }).notNull(),
    
    authorType: fixCommentAuthorTypeEnum("author_type").notNull(),
    authorUserId: varchar("author_user_id").references(() => users.id),
    supplierTokenId: uuid("supplier_token_id"), // Will reference fix_supplier_tokens
    
    message: text("message").notNull(),
    
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_fix_comments_fix").on(t.fixId),
    index("idx_fix_comments_created").on(t.createdAt),
  ]
);

export const insertFixCommentSchema = createInsertSchema(fixComments).omit({ id: true, createdAt: true });
export type InsertFixComment = z.infer<typeof insertFixCommentSchema>;
export type FixComment = typeof fixComments.$inferSelect;

// ============================================
// FIX SUPPLIER TOKENS (Magic Link Access)
// ============================================

export const fixSupplierTokens = pgTable(
  "fix_supplier_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    
    name: text("name").notNull(), // e.g. "Maintenance Guy – Phuket"
    tokenHash: text("token_hash").notNull(), // Store hash, not raw token
    
    allowedBranchIds: jsonb("allowed_branch_ids").$type<string[]>().notNull().default([]),
    
    isEnabled: boolean("is_enabled").notNull().default(true),
    expiresAt: timestamp("expires_at"),
    
    createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    index("idx_fix_supplier_tokens_tenant").on(t.tenantId),
    index("idx_fix_supplier_tokens_hash").on(t.tokenHash),
    index("idx_fix_supplier_tokens_enabled").on(t.isEnabled),
  ]
);

export const insertFixSupplierTokenSchema = createInsertSchema(fixSupplierTokens).omit({ id: true, createdAt: true, lastUsedAt: true });
export type InsertFixSupplierToken = z.infer<typeof insertFixSupplierTokenSchema>;
export type FixSupplierToken = typeof fixSupplierTokens.$inferSelect;

// ============================================
// CHECK-INS
// ============================================

export const dropoffCheckins = pgTable(
  "dropoff_checkins",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),

    parentFullName: text("parent_full_name").notNull(),
    whatsappPhone: text("whatsapp_phone").notNull(),
    contactMethod: text("contact_method").$type<"whatsapp" | "telegram">().default("whatsapp"),
    whatsappPhoneE164: text("whatsapp_phone_e164"),
    telegramUsername: text("telegram_username"),
    children: jsonb("children").$type<Array<{ name: string; age: string }>>().notNull(),
    hasAllergiesOrMedical: boolean("has_allergies_or_medical").notNull().default(false),
    allergiesMedicalDetails: text("allergies_medical_details"),
    allowStaffOrderFood: boolean("allow_staff_order_food").notNull().default(false),
    foodNotesRestrictions: text("food_notes_restrictions"),
    photoUrl: text("photo_url").notNull(),
    signatureUrl: text("signature_url"),

    status: text("status").default("in").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),

    pickedUpAt: timestamp("picked_up_at"),
    pickedUpBy: varchar("picked_up_by").references(() => users.id),
    outPhotoUrl: text("out_photo_url"),
    outSignedName: text("out_signed_name"),

    staffNotes: text("staff_notes"),
    editLog: jsonb("edit_log").$type<Array<{timestamp: string; changes: Record<string, {from: string; to: string}>}>>(),
  },
  (t) => [
    index("idx_dropoff_checkins_tenant").on(t.tenantId),
    index("idx_dropoff_checkins_branch").on(t.branchId),
    index("idx_dropoff_checkins_created_at").on(t.createdAt),
    index("idx_dropoff_checkins_status").on(t.status),
  ]
);

export const serviceCheckins = pgTable(
  "service_checkins",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),

    status: text("status").default("registered").notNull(),
    serviceType: text("service_type"),
    
    parentFullName: text("parent_full_name").notNull(),
    contactMethod: text("contact_method").$type<"whatsapp" | "telegram">().default("whatsapp"),
    whatsappPhoneRaw: text("whatsapp_phone_raw").notNull(),
    whatsappPhoneE164: text("whatsapp_phone_e164"),
    telegramUsername: text("telegram_username"),
    childFullName: text("child_full_name").notNull(),
    childAge: integer("child_age"),
    
    allergiesMedicalDetails: text("allergies_medical_details"),
    foodNotesRestrictions: text("food_notes_restrictions"),
    staffNotes: text("staff_notes"),
    photoUrl: text("photo_url"),
    
    requestedDurationMinutes: integer("requested_duration_minutes"),
    requestedEndAt: timestamp("requested_end_at"),
    
    nannyEmployeeId: varchar("nanny_employee_id").references(() => employees.id),
    nannyAssigned: text("nanny_assigned"),
    nannyAssignedByUserId: varchar("nanny_assigned_by_user_id").references(() => users.id),
    nannyAssignedAt: timestamp("nanny_assigned_at"),
    
    consentSigned: boolean("consent_signed").default(false),
    consentSignature: text("consent_signature"),
    consentSignedName: text("consent_signed_name"),
    consentSignedAt: timestamp("consent_signed_at"),
    
    registeredAt: timestamp("registered_at").defaultNow().notNull(),
    checkedInAt: timestamp("checked_in_at"),
    checkedInBy: varchar("checked_in_by").references(() => users.id),
    checkedOutAt: timestamp("checked_out_at"),
    checkedOutBy: varchar("checked_out_by").references(() => users.id),
    
    outPhotoUrl: text("out_photo_url"),
    outSignedName: text("out_signed_name"),
    outSignature: text("out_signature"),
    
    editLog: jsonb("edit_log").$type<Array<{timestamp: string; changes: Record<string, {from: string; to: string}>}>>(),
    
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    notes: text("notes"),
    estimatedDuration: integer("estimated_duration"),
    serviceStartedAt: timestamp("service_started_at"),
    serviceCompletedAt: timestamp("service_completed_at"),
    servedBy: varchar("served_by").references(() => users.id),
  },
  (t) => [
    index("idx_service_checkins_tenant").on(t.tenantId),
    index("idx_service_checkins_branch").on(t.branchId),
    index("idx_service_checkins_status").on(t.status),
    index("idx_service_checkins_registered_at").on(t.registeredAt),
  ]
);

export const insertDropoffCheckinSchema = createInsertSchema(dropoffCheckins).omit({ id: true, createdAt: true });
export const insertServiceCheckinSchema = createInsertSchema(serviceCheckins).omit({ 
  id: true, 
  registeredAt: true,
  checkedInAt: true,
  checkedOutAt: true,
  nannyAssignedAt: true,
});

export type ServiceCheckin = typeof serviceCheckins.$inferSelect;
export type InsertServiceCheckin = z.infer<typeof insertServiceCheckinSchema>;

// ============================================
// NANNY RESERVATIONS
// ============================================

export const nannyReservationStatusEnum = pgEnum("nanny_reservation_status", [
  "reserved",
  "active",
  "completed",
  "cancelled",
]);

export const nannyReservations = pgTable(
  "nanny_reservations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),
    
    nannyEmployeeId: varchar("nanny_employee_id").references(() => employees.id).notNull(),
    nannyFullName: text("nanny_full_name").notNull(),
    
    serviceCheckinId: uuid("service_checkin_id").references(() => serviceCheckins.id),
    childFullName: text("child_full_name"),
    parentFullName: text("parent_full_name"),
    
    reservationDate: text("reservation_date").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    
    status: nannyReservationStatusEnum("status").notNull().default("reserved"),
    
    reservedByUserId: varchar("reserved_by_user_id").references(() => users.id),
    reservedAt: timestamp("reserved_at").defaultNow().notNull(),
    
    activatedAt: timestamp("activated_at"),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    cancellationReason: text("cancellation_reason"),
    
    notes: text("notes"),
  },
  (t) => [
    index("idx_nanny_reservations_tenant").on(t.tenantId),
    index("idx_nanny_reservations_branch").on(t.branchId),
    index("idx_nanny_reservations_nanny").on(t.nannyEmployeeId),
    index("idx_nanny_reservations_date").on(t.reservationDate),
    index("idx_nanny_reservations_status").on(t.status),
  ]
);

export const insertNannyReservationSchema = createInsertSchema(nannyReservations).omit({ 
  id: true, 
  reservedAt: true,
  activatedAt: true,
  completedAt: true,
  cancelledAt: true,
});
export type NannyReservation = typeof nannyReservations.$inferSelect;
export type InsertNannyReservation = z.infer<typeof insertNannyReservationSchema>;

// ============================================
// EMPLOYEE ROLE AVAILABILITY
// ============================================
// Tracks when employees mark themselves unavailable for specific roles on specific days

export const employeeRoleAvailability = pgTable(
  "employee_role_availability",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    employeeId: varchar("employee_id").references(() => employees.id, { onDelete: "cascade" }).notNull(),
    roleId: varchar("role_id").notNull(),
    roleName: text("role_name").notNull(),
    unavailableDate: varchar("unavailable_date", { length: 10 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
  },
  (table) => [
    index("era_tenant_idx").on(table.tenantId),
    index("era_employee_idx").on(table.employeeId),
    index("era_date_idx").on(table.unavailableDate),
    index("era_employee_role_date_idx").on(table.employeeId, table.roleId, table.unavailableDate),
  ]
);

export const insertEmployeeRoleAvailabilitySchema = createInsertSchema(employeeRoleAvailability).omit({ 
  id: true, 
  createdAt: true,
});
export type EmployeeRoleAvailability = typeof employeeRoleAvailability.$inferSelect;
export type InsertEmployeeRoleAvailability = z.infer<typeof insertEmployeeRoleAvailabilitySchema>;

// ============================================
// KNOWLEDGE BASE ARTICLES (formerly SOP ARTICLES)
// ============================================

export const kbArticles = pgTable(
  "kb_articles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    
    title: text("title").notNull(),
    type: kbArticleTypeEnum("type").notNull().default("SOP"),
    content: text("content"),
    quickAnswer: jsonb("quick_answer").$type<string[]>(),
    
    departments: text("departments").array().default(sql`ARRAY[]::text[]`),
    roles: text("roles").array().notNull().default(sql`ARRAY[]::text[]`),
    tags: text("tags").array().default(sql`ARRAY[]::text[]`),
    
    branchScope: coreBranchScopeEnum("branch_scope").notNull().default("ALL"),
    branchIds: jsonb("branch_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    
    status: kbArticleStatusEnum("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    
    ownerId: varchar("owner_id").references(() => users.id),
    ownerName: text("owner_name"),
    
    lastReviewedAt: timestamp("last_reviewed_at"),
    publishedAt: timestamp("published_at"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    
    embeddingStatus: text("embedding_status").default("pending"),
    embeddingUpdatedAt: timestamp("embedding_updated_at"),
  },
  (t) => [
    index("idx_kb_articles_tenant").on(t.tenantId),
    index("idx_kb_articles_status").on(t.status),
    index("idx_kb_articles_type").on(t.type),
    index("idx_kb_articles_branch_scope").on(t.branchScope),
  ]
);

export const insertKbArticleSchema = createInsertSchema(kbArticles).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true 
});
export type InsertKbArticle = z.infer<typeof insertKbArticleSchema>;
export type KbArticle = typeof kbArticles.$inferSelect;

// ============================================
// KNOWLEDGE BASE ARTICLE VERSIONS (History)
// ============================================

export const kbArticleVersions = pgTable(
  "kb_article_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    articleId: uuid("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    
    version: integer("version").notNull(),
    title: text("title").notNull(),
    type: text("type").notNull(),
    content: text("content"),
    quickAnswer: jsonb("quick_answer").$type<string[]>(),
    
    departments: text("departments").array(),
    roles: text("roles").array(),
    tags: text("tags").array(),
    
    branchScope: text("branch_scope").notNull(),
    branchIds: jsonb("branch_ids").$type<string[]>(),
    
    publishedBy: varchar("published_by").references(() => users.id),
    publishedByName: text("published_by_name"),
    publishedAt: timestamp("published_at").defaultNow().notNull(),
    
    changeNotes: text("change_notes"),
  },
  (t) => [
    index("idx_kb_versions_article").on(t.articleId),
    index("idx_kb_versions_tenant").on(t.tenantId),
  ]
);

export const insertKbArticleVersionSchema = createInsertSchema(kbArticleVersions).omit({ 
  id: true,
  publishedAt: true,
});
export type InsertKbArticleVersion = z.infer<typeof insertKbArticleVersionSchema>;
export type KbArticleVersion = typeof kbArticleVersions.$inferSelect;

// Structured step type for SOP articles with per-step images
export interface SopStep {
  stepNumber: number;
  title: string;
  description?: string;
  imageUrl?: string;
  imageFilename?: string; // Auto-generated filename like "SOP_Gate_Step1_Internet.jpg"
}

// Legacy: Keep sopArticles for backward compatibility during migration
export const sopStatusEnum = pgEnum("sop_status", ["draft", "published", "archived"]);

export const sopArticles = pgTable(
  "sop_articles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    title: text("title").notNull(),
    body: text("body"),

    departments: text("departments").array().default(sql`ARRAY['general']::text[]`),
    lastUpdated: timestamp("last_updated").defaultNow(),
    readingTime: integer("reading_time").default(3),

    coverImageUrl: text("cover_image_url"),
    summary: text("summary"),
    // Structured steps with per-step images (new format)
    structuredSteps: jsonb("structured_steps").$type<SopStep[]>(),
    // Legacy steps field for backward compatibility
    steps: jsonb("steps").$type<string[]>(),
    rules: jsonb("rules").$type<string[]>(),
    commonMistakes: jsonb("common_mistakes").$type<string[]>(),
    unsureTips: jsonb("unsure_tips").$type<string[]>(),
    
    scope: text("scope").notNull().default("GLOBAL"),
    branchIds: jsonb("branch_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Status for security filtering (draft SOPs should not appear in ASK OTO)
    status: sopStatusEnum("status").notNull().default("published"),
  },
  (t) => [index("idx_sop_articles_tenant").on(t.tenantId)]
);

export const insertSopArticleSchema = createInsertSchema(sopArticles).omit({ id: true });
export type InsertSopArticle = z.infer<typeof insertSopArticleSchema>;
export type SopArticle = typeof sopArticles.$inferSelect;

// ============================================
// ASK OTO KNOWLEDGE BASE (Files + RAG)
// ============================================

// File types for knowledge base
export const knowledgeFileTypeEnum = pgEnum("knowledge_file_type", ["pdf", "image", "video"]);
export const knowledgeFileStatusEnum = pgEnum("knowledge_file_status", ["pending", "processing", "indexed", "failed"]);

// Knowledge Files - PDFs, images, videos for Ask OTO RAG
export const knowledgeFiles = pgTable(
  "knowledge_files",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    
    filename: text("filename").notNull(),
    fileType: knowledgeFileTypeEnum("file_type").notNull(),
    storageUrl: text("storage_url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    
    // Scoping
    branchId: varchar("branch_id").references(() => branches.id), // null = global
    departmentId: varchar("department_id").references(() => departments.id),
    language: text("language").notNull().default("en"), // en, th, ru, zh
    tags: text("tags").array().default(sql`ARRAY[]::text[]`),
    version: text("version"),
    
    // Status
    isActive: boolean("is_active").notNull().default(true),
    indexStatus: knowledgeFileStatusEnum("index_status").notNull().default("pending"),
    indexError: text("index_error"),
    pageCount: integer("page_count"),
    
    // Metadata
    title: text("title"),
    description: text("description"),
    
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_knowledge_files_tenant").on(t.tenantId),
    index("idx_knowledge_files_branch").on(t.branchId),
    index("idx_knowledge_files_status").on(t.indexStatus),
    index("idx_knowledge_files_active").on(t.isActive),
  ]
);

export const insertKnowledgeFileSchema = createInsertSchema(knowledgeFiles).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true 
});
export type InsertKnowledgeFile = z.infer<typeof insertKnowledgeFileSchema>;
export type KnowledgeFile = typeof knowledgeFiles.$inferSelect;

// Knowledge Chunks - Text chunks from PDFs with embeddings for RAG
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    fileId: uuid("file_id").references(() => knowledgeFiles.id, { onDelete: "cascade" }).notNull(),
    
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    
    // Source location in PDF
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    
    // Embedding vector (1536 dimensions for OpenAI ada-002)
    embedding: jsonb("embedding").$type<number[]>(),
    
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_knowledge_chunks_file").on(t.fileId),
    index("idx_knowledge_chunks_tenant").on(t.tenantId),
  ]
);

export const insertKnowledgeChunkSchema = createInsertSchema(knowledgeChunks).omit({ 
  id: true, 
  createdAt: true 
});
export type InsertKnowledgeChunk = z.infer<typeof insertKnowledgeChunkSchema>;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;

// Ask OTO Threads - Conversation sessions
export const askOtoThreads = pgTable(
  "ask_oto_threads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    userId: varchar("user_id").references(() => users.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id),
    
    status: text("status").notNull().default("active"), // active, completed, abandoned
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_ask_oto_threads_user").on(t.userId),
    index("idx_ask_oto_threads_tenant").on(t.tenantId),
  ]
);

export const insertAskOtoThreadSchema = createInsertSchema(askOtoThreads).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true 
});
export type InsertAskOtoThread = z.infer<typeof insertAskOtoThreadSchema>;
export type AskOtoThread = typeof askOtoThreads.$inferSelect;

// Ask OTO Messages - Individual messages in a thread
export const askOtoMessages = pgTable(
  "ask_oto_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    threadId: uuid("thread_id").references(() => askOtoThreads.id, { onDelete: "cascade" }).notNull(),
    
    role: text("role").notNull(), // user, assistant
    contentText: text("content_text"), // Plain text content
    contentJson: jsonb("content_json"), // Structured response (mode, steps, citations, etc.)
    
    // For troubleshooting flows - track which question was answered
    questionId: text("question_id"),
    answerId: text("answer_id"),
    
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_ask_oto_messages_thread").on(t.threadId),
    index("idx_ask_oto_messages_tenant").on(t.tenantId),
  ]
);

export const insertAskOtoMessageSchema = createInsertSchema(askOtoMessages).omit({ 
  id: true, 
  createdAt: true 
});
export type InsertAskOtoMessage = z.infer<typeof insertAskOtoMessageSchema>;
export type AskOtoMessage = typeof askOtoMessages.$inferSelect;

// ============================================
// TRAINING & QUIZZES
// ============================================

export const trainingModules = pgTable(
  "training_modules",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    branchId: varchar("branch_id").references(() => branches.id),
    departmentId: varchar("department_id").references(() => departments.id),

    title: text("title").notNull(),
    description: text("description"),
    content: text("content"),
    videoUrl: text("video_url"),

    durationMinutes: integer("duration_minutes"),
    passingScore: real("passing_score").default(70),

    isActive: boolean("is_active").notNull().default(true),
    orderIndex: integer("order_index").notNull().default(0),

    createdBy: varchar("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    
    // Franchise-ready scoping
    scope: text("scope").notNull().default("GLOBAL"), // 'GLOBAL' or 'BRANCHES'
    branchIds: jsonb("branch_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    index("idx_training_modules_tenant").on(t.tenantId),
    index("idx_training_modules_branch").on(t.branchId),
  ]
);

export const quizQuestions = pgTable(
  "quiz_questions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    moduleId: uuid("module_id").references(() => trainingModules.id, { onDelete: "cascade" }).notNull(),

    question: text("question").notNull(),
    options: text("options").array().notNull(),
    correctAnswer: integer("correct_answer").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("idx_quiz_questions_tenant").on(t.tenantId),
    index("idx_quiz_questions_module").on(t.moduleId),
  ]
);

export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    moduleId: uuid("module_id").references(() => trainingModules.id, { onDelete: "cascade" }).notNull(),
    userId: varchar("user_id").references(() => users.id).notNull(),

    responses: jsonb("responses").$type<Record<string, unknown>>(),
    score: real("score"),
    passed: boolean("passed"),

    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    index("idx_quiz_attempts_tenant").on(t.tenantId),
    index("idx_quiz_attempts_module").on(t.moduleId),
    index("idx_quiz_attempts_user").on(t.userId),
  ]
);

export const moduleCompletions = pgTable(
  "module_completions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    moduleId: uuid("module_id").references(() => trainingModules.id, { onDelete: "cascade" }).notNull(),
    userId: varchar("user_id").references(() => users.id).notNull(),

    quizAttemptId: uuid("quiz_attempt_id").references(() => quizAttempts.id),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_module_completions_tenant").on(t.tenantId),
    index("idx_module_completions_module").on(t.moduleId),
    index("idx_module_completions_user").on(t.userId),
  ]
);

export const insertTrainingModuleSchema = createInsertSchema(trainingModules).omit({ id: true, createdAt: true, updatedAt: true });
export const insertQuizQuestionSchema = createInsertSchema(quizQuestions).omit({ id: true });
export const insertQuizAttemptSchema = createInsertSchema(quizAttempts).omit({ id: true, startedAt: true });
export const insertModuleCompletionSchema = createInsertSchema(moduleCompletions).omit({ id: true, completedAt: true });

export type InsertTrainingModule = z.infer<typeof insertTrainingModuleSchema>;
export type TrainingModule = typeof trainingModules.$inferSelect;
export type InsertQuizQuestion = z.infer<typeof insertQuizQuestionSchema>;
export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type InsertQuizAttempt = z.infer<typeof insertQuizAttemptSchema>;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
export type InsertModuleCompletion = z.infer<typeof insertModuleCompletionSchema>;
export type ModuleCompletion = typeof moduleCompletions.$inferSelect;

// ============================================
// TROUBLESHOOTING FLOWS
// ============================================

export const troubleshootingFlows = pgTable(
  "troubleshooting_flows",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    branchId: varchar("branch_id").references(() => branches.id),
    departmentId: varchar("department_id").references(() => departments.id),

    title: text("title").notNull(),
    description: text("description"),
    category: text("category"),

    isActive: boolean("is_active").notNull().default(true),
    rootNodeId: uuid("root_node_id"),

    createdBy: varchar("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_troubleshooting_flows_tenant").on(t.tenantId),
    index("idx_troubleshooting_flows_branch").on(t.branchId),
  ]
);

export const troubleshootingNodes = pgTable(
  "troubleshooting_nodes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    flowId: uuid("flow_id").references(() => troubleshootingFlows.id, { onDelete: "cascade" }).notNull(),

    prompt: text("prompt").notNull(),
    isStart: boolean("is_start").default(false),
    isResolution: boolean("is_resolution").default(false),
    isEscalation: boolean("is_escalation").default(false),

    options: jsonb("options").$type<{ label: string; nextNodeId: string | null }[]>(),
  },
  (t) => [
    index("idx_troubleshooting_nodes_tenant").on(t.tenantId),
    index("idx_troubleshooting_nodes_flow").on(t.flowId),
  ]
);

export const insertTroubleshootingFlowSchema = createInsertSchema(troubleshootingFlows).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTroubleshootingNodeSchema = createInsertSchema(troubleshootingNodes).omit({ id: true });

// ============================================
// VOUCHERS (legacy-style templates + assigned vouchers)
// ============================================

export const voucherTemplates = pgTable(
  "voucher_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    // Optional scoping
    branchId: varchar("branch_id").references(() => branches.id),

    name: text("name").notNull(),
    imageUrl: text("image_url").notNull(),
    description: text("description"),

    maxUses: integer("max_uses").notNull().default(1),

    validFrom: timestamp("valid_from"),
    validTo: timestamp("valid_to"),
    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
  },
  (t) => [
    index("idx_voucher_templates_tenant").on(t.tenantId),
    index("idx_voucher_templates_branch").on(t.branchId),
  ]
);

export const userVouchers = pgTable(
  "user_vouchers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    employeeId: varchar("employee_id").references(() => employees.id),
    userId: varchar("user_id").references(() => users.id),
    templateId: uuid("template_id").references(() => voucherTemplates.id),

    token: text("token").notNull().unique(),
    remainingUses: integer("remaining_uses").notNull(),
    status: coreVoucherStatusEnum("status").notNull().default("active"),

    assignedAt: timestamp("assigned_at").defaultNow().notNull(),
    lastRedeemedAt: timestamp("last_redeemed_at"),

    validFromOverride: timestamp("valid_from_override"),
    validToOverride: timestamp("valid_to_override"),

    notes: text("notes"),
    customImageUrl: text("custom_image_url"),
  },
  (t) => [
    index("idx_user_vouchers_tenant").on(t.tenantId),
    index("idx_user_vouchers_employee").on(t.employeeId),
    index("idx_user_vouchers_user").on(t.userId),
  ]
);

export const voucherRedemptions = pgTable(
  "voucher_redemptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    voucherId: uuid("voucher_id").references(() => userVouchers.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id),
    redeemedBy: varchar("redeemed_by").references(() => users.id).notNull(),

    notes: text("notes"),
    redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_voucher_redemptions_tenant").on(t.tenantId),
    index("idx_voucher_redemptions_voucher").on(t.voucherId),
    index("idx_voucher_redemptions_branch").on(t.branchId),
  ]
);

export const insertVoucherTemplateSchema = createInsertSchema(voucherTemplates).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserVoucherSchema = createInsertSchema(userVouchers).omit({ id: true });
export const insertVoucherRedemptionSchema = createInsertSchema(voucherRedemptions).omit({ id: true, redeemedAt: true });

export type VoucherTemplate = typeof voucherTemplates.$inferSelect;
export type InsertVoucherTemplate = z.infer<typeof insertVoucherTemplateSchema>;
export type UserVoucher = typeof userVouchers.$inferSelect;
export type InsertUserVoucher = z.infer<typeof insertUserVoucherSchema>;
export type VoucherRedemption = typeof voucherRedemptions.$inferSelect;
export type InsertVoucherRedemption = z.infer<typeof insertVoucherRedemptionSchema>;

// ============================================
// CORE EVENTS (booking-style events, separate from HR branch_events)
// ============================================

export const coreEvents = pgTable(
  "core_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),

    branchId: varchar("branch_id").notNull().references(() => branches.id),
    locationId: uuid("location_id"),
    locationText: text("location_text"),

    eventType: coreEventTypeEnum("event_type").notNull().default("birthday"),
    color: text("color"), // Custom calendar color for Other Events. Birthday/Camp/Workshop use semantic colors.
    title: text("title").notNull(),
    activities: text("activities"),
    decoration: text("decoration"),

    eventDate: text("event_date").notNull(),
    campEndDate: text("camp_end_date"), // For camp events: last day of the camp (inclusive)
    campDayHosts: jsonb("camp_day_hosts"), // For camp events: { "yyyy-MM-dd": "Host Name" }
    campCancelledDays: jsonb("camp_cancelled_days"), // For camp events: ["yyyy-MM-dd", ...] of cancelled days
    startTime: text("start_time").notNull(),
    endTime: text("end_time"),
    durationMinutes: integer("duration_minutes"),

    childName: text("child_name"),
    bookingName: text("booking_name"),
    parentName: text("parent_name"),

    whatsappPhoneRaw: text("whatsapp_phone_raw"),
    whatsappPhoneE164: text("whatsapp_phone_e164"),
    whatsappParseValid: boolean("whatsapp_parse_valid").default(true),
    whatsappParseError: text("whatsapp_parse_error"),
    kidTurningAge: integer("kid_turning_age"),

    numChildren: integer("num_children"),
    numAdults: integer("num_adults"),

    programName: text("program_name"),
    programDetails: text("program_details"),

    allergiesNotes: text("allergies_notes"),
    cakeNotes: text("cake_notes"),
    specialRequests: text("special_requests"),
    internalStaffNotes: text("internal_staff_notes"),

    totalValue: integer("total_value"),
    prepaymentAmount: integer("prepayment_amount"),
    prepaymentDate: text("prepayment_date"),
    prepaymentMethod: text("prepayment_method"),

    // The flat walk-up entry price of a camp day or a one-off event, as the
    // POS sells it at the till (events-kiosk PLAN s3, "Pass price"): one
    // weekday/weekend pair, whole baht like total_value above, never tiered
    // and never a membership rate. Null means no price has been set; 0 is a
    // free event. Parties do not carry one — their walk-up guests are billed
    // to the party tab instead.
    entryPriceWeekdayThb: integer("entry_price_weekday_thb"),
    entryPriceWeekendThb: integer("entry_price_weekend_thb"),

    status: text("status").notNull().default("upcoming"),

    isArchived: boolean("is_archived").default(false).notNull(),
    archivedAt: timestamp("archived_at"),

    suppressedTimelineSources: text("suppressed_timeline_sources").array().default(sql`'{}'::text[]`),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id),
  },
  (t) => [
    index("idx_core_events_tenant").on(t.tenantId),
    index("idx_core_events_branch").on(t.branchId),
    index("idx_core_events_date").on(t.eventDate),
    index("idx_core_events_archived").on(t.isArchived),
    check(
      "core_events_entry_price_check",
      sql`(${t.entryPriceWeekdayThb} IS NULL OR ${t.entryPriceWeekdayThb} >= 0) AND (${t.entryPriceWeekendThb} IS NULL OR ${t.entryPriceWeekendThb} >= 0)`,
    ),
  ]
);

export const insertCoreEventSchema = createInsertSchema(coreEvents).omit({ id: true, createdAt: true });
export type InsertEvent = z.infer<typeof insertCoreEventSchema>;
export type Event = typeof coreEvents.$inferSelect;

// ============================================
// EVENT STATUSES (dynamic, tenant-scoped)
// ============================================

export const eventStatuses = pgTable(
  "event_statuses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: text("name").notNull(),
    value: text("value").notNull(), // Canonical value stored in events (e.g., "upcoming", "in_progress")
    color: text("color").notNull().default("gray"),
    sortOrder: integer("sort_order").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_event_statuses_tenant").on(t.tenantId),
  ]
);

export const insertEventStatusSchema = createInsertSchema(eventStatuses).omit({ id: true, createdAt: true }).extend({
  value: z.string().optional(), // Value is auto-generated from name if not provided
});
export type InsertEventStatus = z.infer<typeof insertEventStatusSchema>;
export type EventStatus = typeof eventStatuses.$inferSelect;

// ============================================
// STUDIO EVENT STATUS ENUM
// ============================================

export const studioEventStatusEnum = pgEnum("studio_event_status", [
  "draft",
  "published",
  "completed",
  "cancelled",
]);

// ============================================
// STUDIO EVENT DETAILS (extended info for studio_event type)
// ============================================

export const studioEventDetails = pgTable(
  "studio_event_details",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    concept: text("concept"),
    fnbDetails: text("fnb_details"),
    notes: text("notes"),
    description: text("description"),
    location: text("location"),
    maxParticipants: integer("max_participants"),
    customInfo: jsonb("custom_info"),
    studioStatus: studioEventStatusEnum("studio_status").notNull().default("draft"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_studio_event_details_event").on(t.eventId),
  ]
);

export const insertStudioEventDetailsSchema = createInsertSchema(studioEventDetails).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStudioEventDetails = z.infer<typeof insertStudioEventDetailsSchema>;
export type StudioEventDetails = typeof studioEventDetails.$inferSelect;

// ============================================
// STUDIO EVENT TASKS
// ============================================

export const studioEventTaskStatusEnum = pgEnum("studio_event_task_status", [
  "todo",
  "doing",
  "done",
]);

export const studioEventTasks = pgTable(
  "studio_event_tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    dueTime: varchar("due_time", { length: 10 }),
    dueDatetime: timestamp("due_datetime"),
    departmentId: varchar("department_id").references(() => departments.id),
    assignedToUserId: varchar("assigned_to_user_id").references(() => users.id),
    requiresPhotoEvidence: boolean("requires_photo_evidence").notNull().default(false),
    requiresQuestionsAnswered: boolean("requires_questions_answered").notNull().default(false),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completed_at"),
    completedByUserId: varchar("completed_by_user_id").references(() => users.id),
    status: studioEventTaskStatusEnum("status").notNull().default("todo"),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_studio_event_tasks_event").on(t.eventId),
  ]
);

export const insertStudioEventTaskSchema = createInsertSchema(studioEventTasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStudioEventTask = z.infer<typeof insertStudioEventTaskSchema>;
export type StudioEventTask = typeof studioEventTasks.$inferSelect;

// ============================================
// STUDIO EVENT INFO BLOCKS
// ============================================

export const studioEventInfoBlocks = pgTable(
  "studio_event_info_blocks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_studio_event_info_blocks_event").on(t.eventId),
  ]
);

export const insertStudioEventInfoBlockSchema = createInsertSchema(studioEventInfoBlocks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStudioEventInfoBlock = z.infer<typeof insertStudioEventInfoBlockSchema>;
export type StudioEventInfoBlock = typeof studioEventInfoBlocks.$inferSelect;

// ============================================
// STUDIO EVENT BOOKING PAYMENT ENUMS
// ============================================

export const studioBookingPaymentStatusEnum = pgEnum("studio_booking_payment_status", [
  "unpaid",
  "partial",
  "paid",
  "pay_on_arrival",
  "refunded",
]);

export const studioBookingPaymentMethodEnum = pgEnum("studio_booking_payment_method", [
  "qr_online",
  "qr_offline",
  "cash",
  "card",
  "transfer",
  "pos",
  "other",
]);

export const studioBookingSourceChannelEnum = pgEnum("studio_booking_source_channel", [
  "walkin",
  "whatsapp",
  "instagram",
  "facebook",
  "klook",
  "website",
  "phone",
  "other",
]);

// ============================================
// STUDIO EVENT BOOKINGS (group bookings per event)
// ============================================

export const studioEventBookings = pgTable(
  "studio_event_bookings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    bookingName: text("booking_name").notNull(),
    whatsappPhone: text("whatsapp_phone"),
    sourceChannel: studioBookingSourceChannelEnum("source_channel"),
    adultsCount: integer("adults_count").notNull().default(0),
    kidsCount: integer("kids_count").notNull().default(0),
    adultNames: text("adult_names"),
    kidNames: text("kid_names"),
    amountTotal: real("amount_total").notNull().default(0),
    amountPaid: real("amount_paid").notNull().default(0),
    paymentStatus: studioBookingPaymentStatusEnum("payment_status").notNull().default("unpaid"),
    paymentMethod: studioBookingPaymentMethodEnum("payment_method"),
    paymentDate: text("payment_date"),
    posReference: text("pos_reference"),
    internalNotes: text("internal_notes"),
    arrived: boolean("arrived").notNull().default(false),
    arrivedAt: timestamp("arrived_at"),
    customFieldValues: jsonb("custom_field_values"),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_studio_event_bookings_event").on(t.eventId),
  ]
);

export const insertStudioEventBookingSchema = createInsertSchema(studioEventBookings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStudioEventBooking = z.infer<typeof insertStudioEventBookingSchema>;
export type StudioEventBooking = typeof studioEventBookings.$inferSelect;

// ============================================
// STUDIO EVENT FORM SCHEMA (per-event form builder config)
// ============================================

export const studioEventFormSchema = pgTable(
  "studio_event_form_schema",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    schemaJson: jsonb("schema_json").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_studio_event_form_schema_event").on(t.eventId),
  ]
);

export const insertStudioEventFormSchemaSchema = createInsertSchema(studioEventFormSchema).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStudioEventFormSchema = z.infer<typeof insertStudioEventFormSchemaSchema>;
export type StudioEventFormSchema = typeof studioEventFormSchema.$inferSelect;

// Form schema JSON type definition for TypeScript
export type StudioFormFieldType = "text" | "number" | "phone" | "date" | "checkbox" | "select" | "textarea";

export interface StudioFormField {
  id: string;
  key: string;
  label: string;
  type: StudioFormFieldType;
  required: boolean;
  enabled: boolean;
  isDefault: boolean;
  options?: string[];
  displayOrder: number;
}

export interface StudioFormSchemaJson {
  fields: StudioFormField[];
}

// ============================================
// DROPOFF FORM BUILDER (Schema-driven form with versioning + translations)
// ============================================

export const dropoffFormStatusEnum = pgEnum("dropoff_form_status", [
  "draft",
  "published",
]);

export const translationLanguageEnum = pgEnum("translation_language", [
  "en",
  "th",
  "ru",
  "zh",
]);

export const translationJobStatusEnum = pgEnum("translation_job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

// Main form table (singleton or per-branch)
export const dropoffForms = pgTable(
  "dropoff_forms",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id),
    name: text("name").notNull().default("Drop-off Form"),
    status: dropoffFormStatusEnum("status").notNull().default("draft"),
    activePublishedVersionId: uuid("active_published_version_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_dropoff_forms_tenant").on(t.tenantId),
    index("idx_dropoff_forms_branch").on(t.branchId),
  ]
);

// Versioned form schemas
export const dropoffFormVersions = pgTable(
  "dropoff_form_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    formId: uuid("form_id").references(() => dropoffForms.id, { onDelete: "cascade" }).notNull(),
    versionNumber: integer("version_number").notNull(),
    sourceLanguage: text("source_language").notNull().default("en"),
    schemaJson: jsonb("schema_json").notNull(),
    isDraft: boolean("is_draft").notNull().default(true),
    publishedAt: timestamp("published_at"),
    publishedByUserId: varchar("published_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_dropoff_form_versions_form").on(t.formId),
    index("idx_dropoff_form_versions_version").on(t.formId, t.versionNumber),
  ]
);

// Translations table (keyed by version + language + key)
export const i18nTranslations = pgTable(
  "i18n_translations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    namespace: text("namespace").notNull().default("dropoff"),
    versionId: uuid("version_id").references(() => dropoffFormVersions.id, { onDelete: "cascade" }).notNull(),
    lang: translationLanguageEnum("lang").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    isManualOverride: boolean("is_manual_override").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_i18n_translations_version").on(t.versionId),
    index("idx_i18n_translations_lookup").on(t.versionId, t.lang, t.key),
  ]
);

// Translation jobs for debugging
export const translationJobs = pgTable(
  "translation_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    versionId: uuid("version_id").references(() => dropoffFormVersions.id, { onDelete: "cascade" }).notNull(),
    status: translationJobStatusEnum("status").notNull().default("queued"),
    targetLanguages: jsonb("target_languages").$type<string[]>().notNull().default(["th", "ru", "zh"]),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_translation_jobs_version").on(t.versionId),
  ]
);

// Insert schemas
export const insertDropoffFormSchema = createInsertSchema(dropoffForms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertDropoffFormVersionSchema = createInsertSchema(dropoffFormVersions).omit({
  id: true,
  createdAt: true,
});
export const insertI18nTranslationSchema = createInsertSchema(i18nTranslations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTranslationJobSchema = createInsertSchema(translationJobs).omit({
  id: true,
  createdAt: true,
});

// Types
export type DropoffForm = typeof dropoffForms.$inferSelect;
export type InsertDropoffForm = z.infer<typeof insertDropoffFormSchema>;
export type DropoffFormVersion = typeof dropoffFormVersions.$inferSelect;
export type InsertDropoffFormVersion = z.infer<typeof insertDropoffFormVersionSchema>;
export type I18nTranslation = typeof i18nTranslations.$inferSelect;
export type InsertI18nTranslation = z.infer<typeof insertI18nTranslationSchema>;
export type TranslationJob = typeof translationJobs.$inferSelect;
export type InsertTranslationJob = z.infer<typeof insertTranslationJobSchema>;

// Form schema JSON type definition
export type DropoffFormFieldType = "text" | "phone" | "email" | "number" | "date" | "time" | "select" | "checkbox" | "textarea" | "radio" | "photo" | "signature";

export interface DropoffFormFieldOption {
  value: string;
  labelKey: string;
}

export interface DropoffFormFieldValidation {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
}

export interface DropoffFormVisibilityRule {
  fieldId: string;
  operator: "equals" | "not_equals" | "contains" | "not_empty";
  value?: string;
}

export interface DropoffFormField {
  id: string;
  type: DropoffFormFieldType;
  required: boolean;
  labelKey: string;
  placeholderKey?: string;
  helpTextKey?: string;
  validation?: DropoffFormFieldValidation;
  options?: DropoffFormFieldOption[];
  displayOrder: number;
  visibilityRule?: DropoffFormVisibilityRule;
}

export interface DropoffFormSection {
  id: string;
  titleKey: string;
  descriptionKey?: string;
  fields: DropoffFormField[];
  displayOrder: number;
  repeatable?: boolean;
  maxRepeats?: number;
}

export interface DropoffFormSchemaJson {
  titleKey: string;
  descriptionKey?: string;
  sections: DropoffFormSection[];
  submitTextKey: string;
  successMessageKey: string;
  requiresPhoto: boolean;
  requiresSignature: boolean;
}

// ============================================
// BEO (BANQUET EVENT ORDER) MODULE ENUMS
// ============================================

export const beoAssignmentModeEnum = pgEnum("beo_assignment_mode", [
  "INDIVIDUAL",
  "ROLE",
  "DEPARTMENT",
]);

export const beoHostResponsibilityEnum = pgEnum("beo_host_responsibility", [
  "GUEST_COORDINATION",
  "TIMELINE_ADHERENCE",
  "PARENT_COMMUNICATION",
  "ISSUE_ESCALATION",
]);

export const beoEntertainmentTypeEnum = pgEnum("beo_entertainment_type", [
  "MASCOT",
  "FACE_PAINT",
  "GAME_LEADER",
  "EXTERNAL_PERFORMER",
  "OTHER",
]);

export const beoEntertainmentAssignmentModeEnum = pgEnum("beo_entertainment_assignment_mode", [
  "INDIVIDUAL",
  "ROLE",
  "EXTERNAL_VENDOR",
]);

export const beoSetupItemEnum = pgEnum("beo_setup_item", [
  "BALLOONS",
  "BACKDROP",
  "TABLE_LAYOUT",
  "CAKE_TABLE",
  "SIGNAGE",
  "DECORATIONS",
  "PARTY_SUPPLIES",
  "OTHER",
]);

export const beoDietaryTagEnum = pgEnum("beo_dietary_tag", [
  "VEG",
  "VEGAN",
  "HALAL",
  "NO_PORK",
  "NUT_ALLERGY",
  "DAIRY_FREE",
  "GLUTEN_FREE",
  "OTHER",
]);

export const beoCakeModeEnum = pgEnum("beo_cake_mode", [
  "INTERNAL",
  "EXTERNAL",
  "NONE",
]);

export const beoDepositPaymentMethodEnum = pgEnum("beo_deposit_payment_method", [
  "CASH",
  "CARD",
  "TRANSFER",
  "QR_PAYMENT",
  "OTHER",
]);

export const beoTimelineAssignedToTypeEnum = pgEnum("beo_timeline_assigned_to_type", [
  "PARTY_HOST",
  "SETUP_RESPONSIBLE",
  "KITCHEN_RESPONSIBLE",
  "ENTERTAINMENT",
  "SPECIFIC_USER",
]);

// ============================================
// BEO LOCATIONS (event rooms/zones)
// ============================================

export const beoLocations = pgTable(
  "beo_locations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    branchId: varchar("branch_id").references(() => branches.id).notNull(),
    branchIds: text("branch_ids").array().default(sql`'{}'::text[]`),
    name: text("name").notNull(),
    capacity: integer("capacity"),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_locations_tenant").on(t.tenantId),
    index("idx_beo_locations_branch").on(t.branchId),
  ]
);

export const insertBeoLocationSchema = createInsertSchema(beoLocations).omit({
  id: true,
  createdAt: true,
});
export type InsertBeoLocation = z.infer<typeof insertBeoLocationSchema>;
export type BeoLocation = typeof beoLocations.$inferSelect;

// ============================================
// BEO ENTERTAINMENT OPTIONS (configurable)
// ============================================

export const beoEntertainmentOptions = pgTable(
  "beo_entertainment_options",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: text("name").notNull(),
    defaultDurationMinutes: integer("default_duration_minutes"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_entertainment_options_tenant").on(t.tenantId),
  ]
);

export const insertBeoEntertainmentOptionSchema = createInsertSchema(beoEntertainmentOptions).omit({
  id: true,
  createdAt: true,
});
export type InsertBeoEntertainmentOption = z.infer<typeof insertBeoEntertainmentOptionSchema>;
export type BeoEntertainmentOption = typeof beoEntertainmentOptions.$inferSelect;

// ============================================
// BEO SETUP ITEM OPTIONS (configurable)
// ============================================

export const beoSetupItemOptions = pgTable(
  "beo_setup_item_options",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: text("name").notNull(),
    category: text("category"),
    notes: text("notes"),
    defaultCost: integer("default_cost").default(0),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_setup_item_options_tenant").on(t.tenantId),
  ]
);

export const insertBeoSetupItemOptionSchema = createInsertSchema(beoSetupItemOptions).omit({
  id: true,
  createdAt: true,
});
export type InsertBeoSetupItemOption = z.infer<typeof insertBeoSetupItemOptionSchema>;
export type BeoSetupItemOption = typeof beoSetupItemOptions.$inferSelect;

// ============================================
// BEO ASSIGNMENT TARGETS (reusable assignment model)
// ============================================

export const beoAssignmentTargetTypeEnum = pgEnum("beo_assignment_target_type", [
  "DEPARTMENT",
  "ROLE",
  "USER",
]);

export const beoAssignmentTargets = pgTable(
  "beo_assignment_targets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    targetType: beoAssignmentTargetTypeEnum("target_type").notNull(),
    departmentId: varchar("department_id").references(() => departments.id),
    roleId: varchar("role_id").references(() => roles.id),
    userId: varchar("user_id").references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_assignment_targets_tenant").on(t.tenantId),
  ]
);

export const insertBeoAssignmentTargetSchema = createInsertSchema(beoAssignmentTargets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoAssignmentTarget = z.infer<typeof insertBeoAssignmentTargetSchema>;
export type BeoAssignmentTarget = typeof beoAssignmentTargets.$inferSelect;

// ============================================
// BEO SETUP ITEMS (individual setup tasks per event)
// ============================================

export const beoSetupItems = pgTable(
  "beo_setup_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    title: text("title").notNull(),
    category: text("category"),
    assignmentTargetId: uuid("assignment_target_id").references(() => beoAssignmentTargets.id),
    deadlineOffsetMinutes: integer("deadline_offset_minutes"),
    notes: text("notes"),
    priceAmount: integer("price_amount"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_setup_items_event").on(t.eventId),
    index("idx_beo_setup_items_tenant").on(t.tenantId),
  ]
);

export const insertBeoSetupItemSchema = createInsertSchema(beoSetupItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoSetupItem = z.infer<typeof insertBeoSetupItemSchema>;
export type BeoSetupItem = typeof beoSetupItems.$inferSelect;

// ============================================
// BEO ENTERTAINMENT ITEMS (individual entertainment entries per event)
// ============================================

export const beoEntertainmentItems = pgTable(
  "beo_entertainment_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    entertainmentOptionId: uuid("entertainment_option_id").references(() => beoEntertainmentOptions.id),
    customName: text("custom_name"),
    assignmentTargetId: uuid("assignment_target_id").references(() => beoAssignmentTargets.id),
    durationMinutes: integer("duration_minutes"),
    startTime: text("start_time"),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_entertainment_items_event").on(t.eventId),
    index("idx_beo_entertainment_items_tenant").on(t.tenantId),
  ]
);

export const insertBeoEntertainmentItemSchema = createInsertSchema(beoEntertainmentItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoEntertainmentItem = z.infer<typeof insertBeoEntertainmentItemSchema>;
export type BeoEntertainmentItem = typeof beoEntertainmentItems.$inferSelect;

// ============================================
// BEO PARTY HOST ASSIGNMENTS
// ============================================

export const beoPartyHostAssignments = pgTable(
  "beo_party_host_assignments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    assignmentMode: beoAssignmentModeEnum("assignment_mode").notNull().default("INDIVIDUAL"),
    assignedUserId: varchar("assigned_user_id").references(() => users.id),
    assignedRoleId: varchar("assigned_role_id").references(() => roles.id),
    resolvedUserId: varchar("resolved_user_id").references(() => users.id),
    resolvedAt: timestamp("resolved_at"),
    backupUserId: varchar("backup_user_id").references(() => users.id),
    // Employee-based assignments (preferred over user-based)
    assignedEmployeeId: varchar("assigned_employee_id").references(() => employees.id),
    backupEmployeeId: varchar("backup_employee_id").references(() => employees.id),
    responsibilities: text("responsibilities").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_party_host_event").on(t.eventId),
  ]
);

export const insertBeoPartyHostAssignmentSchema = createInsertSchema(beoPartyHostAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoPartyHostAssignment = z.infer<typeof insertBeoPartyHostAssignmentSchema>;
export type BeoPartyHostAssignment = typeof beoPartyHostAssignments.$inferSelect;

// ============================================
// BEO ENTERTAINMENT ASSIGNMENTS
// ============================================

export const beoEntertainmentAssignments = pgTable(
  "beo_entertainment_assignments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    entertainmentRequired: boolean("entertainment_required").notNull().default(false),
    entertainmentType: beoEntertainmentTypeEnum("entertainment_type"),
    assignmentMode: beoEntertainmentAssignmentModeEnum("assignment_mode"),
    assignedUserId: varchar("assigned_user_id").references(() => users.id),
    assignedRoleId: varchar("assigned_role_id").references(() => roles.id),
    vendorName: text("vendor_name"),
    vendorContact: text("vendor_contact"),
    resolvedUserId: varchar("resolved_user_id").references(() => users.id),
    resolvedAt: timestamp("resolved_at"),
    requirementsNotes: text("requirements_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_entertainment_event").on(t.eventId),
  ]
);

export const insertBeoEntertainmentAssignmentSchema = createInsertSchema(beoEntertainmentAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoEntertainmentAssignment = z.infer<typeof insertBeoEntertainmentAssignmentSchema>;
export type BeoEntertainmentAssignment = typeof beoEntertainmentAssignments.$inferSelect;

// ============================================
// BEO SETUP PLANS
// ============================================

export const beoSetupChargeMode = pgEnum("beo_setup_charge_mode", ["included", "per_item", "total"]);

export const beoSetupPlans = pgTable(
  "beo_setup_plans",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    setupRequired: boolean("setup_required").notNull().default(true),
    setupItems: text("setup_items").array(),
    setupNotes: text("setup_notes"),
    setupResponsibleMode: beoAssignmentModeEnum("setup_responsible_mode"),
    setupResponsibleUserId: varchar("setup_responsible_user_id").references(() => users.id),
    setupResponsibleRoleId: varchar("setup_responsible_role_id").references(() => roles.id),
    setupResponsibleDepartmentId: varchar("setup_responsible_department_id").references(() => departments.id),
    setupDeadlineOffsetMinutes: integer("setup_deadline_offset_minutes").notNull().default(30),
    setupResolvedUserId: varchar("setup_resolved_user_id").references(() => users.id),
    setupResolvedAt: timestamp("setup_resolved_at"),
    setupChargeMode: beoSetupChargeMode("setup_charge_mode").default("included"),
    setupTotalPrice: integer("setup_total_price"),
    setupTasks: jsonb("setup_tasks").default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_setup_plans_event").on(t.eventId),
  ]
);

export const insertBeoSetupPlanSchema = createInsertSchema(beoSetupPlans).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoSetupPlan = z.infer<typeof insertBeoSetupPlanSchema>;
export type BeoSetupPlan = typeof beoSetupPlans.$inferSelect;

// ============================================
// BEO KITCHEN PLANS
// ============================================

export const beoKitchenPlans = pgTable(
  "beo_kitchen_plans",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    foodRequired: boolean("food_required").notNull().default(true),
    foodPackageId: text("food_package_id"),
    foodPackageName: text("food_package_name"),
    dietaryTags: text("dietary_tags").array(),
    dietaryNotes: text("dietary_notes"),
    cakeMode: beoCakeModeEnum("cake_mode").default("NONE"),
    cakeQuantity: integer("cake_quantity").notNull().default(1),
    ownCakeCharge: integer("own_cake_charge"),
    cakeTime: text("cake_time"),
    cakeNotes: text("cake_notes"),
    kitchenReadyOffsetMinutes: integer("kitchen_ready_offset_minutes").notNull().default(20),
    kitchenResponsibleType: text("kitchen_responsible_type"),
    kitchenResponsibleId: text("kitchen_responsible_id"),
    kitchenResponsibleMode: beoAssignmentModeEnum("kitchen_responsible_mode"),
    kitchenResponsibleUserId: varchar("kitchen_responsible_user_id").references(() => users.id),
    kitchenResponsibleRoleId: varchar("kitchen_responsible_role_id").references(() => roles.id),
    kitchenResolvedUserId: varchar("kitchen_resolved_user_id").references(() => users.id),
    kitchenResolvedAt: timestamp("kitchen_resolved_at"),
    kitchenNotes: text("kitchen_notes"),
    serviceSchedule: jsonb("service_schedule"),
    menus: jsonb("menus"),
    simplifiedMenus: jsonb("simplified_menus"),
    setMenuEnabled: boolean("set_menu_enabled").notNull().default(false),
    setMenuTemplateId: uuid("set_menu_template_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_kitchen_plans_event").on(t.eventId),
  ]
);

export const insertBeoKitchenPlanSchema = createInsertSchema(beoKitchenPlans).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoKitchenPlan = z.infer<typeof insertBeoKitchenPlanSchema>;
export type BeoKitchenPlan = typeof beoKitchenPlans.$inferSelect;

// ============================================
// BEO BAR PLANS
// ============================================

export const beoBarPlans = pgTable(
  "beo_bar_plans",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    serviceTime: text("service_time"),
    items: jsonb("items"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_bar_plans_event").on(t.eventId),
  ]
);

export const insertBeoBarPlanSchema = createInsertSchema(beoBarPlans).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoBarPlan = z.infer<typeof insertBeoBarPlanSchema>;
export type BeoBarPlan = typeof beoBarPlans.$inferSelect;

// ============================================
// BEO EVENT BILLING
// ============================================

export const beoEventBilling = pgTable(
  "beo_event_billing",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    packagePrice: integer("package_price"),
    addOns: jsonb("add_ons"),
    totalCalculated: integer("total_calculated"),
    depositRequired: boolean("deposit_required").notNull().default(false),
    depositAmount: integer("deposit_amount"),
    depositPaid: boolean("deposit_paid").notNull().default(false),
    depositPaidAmount: integer("deposit_paid_amount"),
    depositPaymentMethod: beoDepositPaymentMethodEnum("deposit_payment_method"),
    depositPaidAt: timestamp("deposit_paid_at"),
    posOrderRef: text("pos_order_ref"),
    billingNotes: text("billing_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_event_billing_event").on(t.eventId),
  ]
);

export const insertBeoEventBillingSchema = createInsertSchema(beoEventBilling).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoEventBilling = z.infer<typeof insertBeoEventBillingSchema>;
export type BeoEventBilling = typeof beoEventBilling.$inferSelect;

// ============================================
// BEO TIMELINE ITEMS
// ============================================

export const beoTimelineItems = pgTable(
  "beo_timeline_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    label: text("label").notNull(),
    offsetFromStartMinutes: integer("offset_from_start_minutes").notNull().default(0),
    assignedToType: beoTimelineAssignedToTypeEnum("assigned_to_type").notNull().default("PARTY_HOST"),
    assignedUserId: varchar("assigned_user_id").references(() => users.id),
    isSystemGenerated: boolean("is_system_generated").notNull().default(false),
    sourceKey: text("source_key"),
    isCompleted: boolean("is_completed").notNull().default(false),
    completedAt: timestamp("completed_at"),
    completedByUserId: varchar("completed_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_timeline_items_event").on(t.eventId),
    index("idx_beo_timeline_items_sort").on(t.eventId, t.sortOrder),
  ]
);

export const insertBeoTimelineItemSchema = createInsertSchema(beoTimelineItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoTimelineItem = z.infer<typeof insertBeoTimelineItemSchema>;
export type BeoTimelineItem = typeof beoTimelineItems.$inferSelect;

// ============================================
// EVENT LINE ITEM TEMPLATES (Reusable catalog in Settings)
// ============================================

export const eventLineItemCategoryEnum = pgEnum("event_line_item_category", [
  "ENTERTAINMENT",
  "FOOD",
  "SERVICE",
  "ADD_ON",
  "PACKAGE",
  "OTHER",
]);

export const eventLineItemTemplates = pgTable(
  "event_line_item_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    defaultUnitPriceIncVat: integer("default_unit_price_inc_vat").notNull().default(0),
    defaultQty: integer("default_qty").notNull().default(1),
    category: eventLineItemCategoryEnum("category").notNull().default("OTHER"),
    isIncludedByDefault: boolean("is_included_by_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    description: text("description"),
    internalNote: text("internal_note"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_event_line_item_templates_tenant").on(t.tenantId),
    index("idx_event_line_item_templates_category").on(t.category),
    index("idx_event_line_item_templates_active").on(t.isActive),
  ]
);

export const insertEventLineItemTemplateSchema = createInsertSchema(eventLineItemTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEventLineItemTemplate = z.infer<typeof insertEventLineItemTemplateSchema>;
export type EventLineItemTemplate = typeof eventLineItemTemplates.$inferSelect;

// ============================================
// EVENT LINE ITEMS (Per-event billing line items)
// ============================================

export const eventLineItemSourceTypeEnum = pgEnum("event_line_item_source_type", ["manual", "setup", "package", "food", "addon", "entertainment", "custom"]);

export const eventLineItems = pgTable(
  "event_line_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    templateId: uuid("template_id").references(() => eventLineItemTemplates.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    category: eventLineItemCategoryEnum("category").notNull().default("OTHER"),
    qty: integer("qty").notNull().default(1),
    unitPriceIncVat: integer("unit_price_inc_vat").notNull().default(0),
    isIncluded: boolean("is_included").notNull().default(false),
    isManual: boolean("is_manual").notNull().default(false),
    autoGenerated: boolean("auto_generated").notNull().default(false),
    sourceType: eventLineItemSourceTypeEnum("source_type").default("manual"),
    sourceId: text("source_id"),
    notes: text("notes"),
    overrideReason: text("override_reason"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_event_line_items_event").on(t.eventId),
    index("idx_event_line_items_template").on(t.templateId),
    index("idx_event_line_items_sort").on(t.eventId, t.sortOrder),
  ]
);

export const insertEventLineItemSchema = createInsertSchema(eventLineItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEventLineItem = z.infer<typeof insertEventLineItemSchema>;
export type EventLineItem = typeof eventLineItems.$inferSelect;

// ============================================
// PARENT EXPERIENCE MODULE
// ============================================

export const parentExperienceLanguageEnum = pgEnum("parent_experience_language", [
  "en", "th", "ru", "zh"
]);

export const rsvpStatusEnum = pgEnum("rsvp_status", [
  "yes", "no", "maybe"
]);

export const rsvpSourceEnum = pgEnum("rsvp_source", [
  "guest_link", "parent_portal"
]);

export const messageChannelEnum = pgEnum("message_channel", [
  "whatsapp", "telegram"
]);

export const messageStatusEnum = pgEnum("message_status", [
  "opened_client", "copied", "failed"
]);

export const invitationThemeEnum = pgEnum("invitation_theme", [
  "enchanted_castle", "space_adventure", "candy_wonderland", "jungle_quest", "ocean_magic"
]);

export const parentPortalTokens = pgTable("parent_portal_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 64 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  revokedAt: timestamp("revoked_at"),
  lastAccessedAt: timestamp("last_accessed_at"),
}, (t) => [
  index("idx_parent_portal_tokens_event").on(t.eventId),
  index("idx_parent_portal_tokens_token").on(t.token),
]);

export const insertParentPortalTokenSchema = createInsertSchema(parentPortalTokens).omit({
  id: true,
  createdAt: true,
});
export type InsertParentPortalToken = z.infer<typeof insertParentPortalTokenSchema>;
export type ParentPortalToken = typeof parentPortalTokens.$inferSelect;

export const guestInviteTokens = pgTable("guest_invite_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 64 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  revokedAt: timestamp("revoked_at"),
  lastAccessedAt: timestamp("last_accessed_at"),
}, (t) => [
  index("idx_guest_invite_tokens_event").on(t.eventId),
  index("idx_guest_invite_tokens_token").on(t.token),
]);

export const insertGuestInviteTokenSchema = createInsertSchema(guestInviteTokens).omit({
  id: true,
  createdAt: true,
});
export type InsertGuestInviteToken = z.infer<typeof insertGuestInviteTokenSchema>;
export type GuestInviteToken = typeof guestInviteTokens.$inferSelect;

export const invitationDesigns = pgTable("invitation_designs", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
  themeId: invitationThemeEnum("theme_id").notNull().default("enchanted_castle"),
  language: parentExperienceLanguageEnum("language").notNull().default("en"),
  childName: varchar("child_name", { length: 100 }).notNull(),
  childAge: varchar("child_age", { length: 10 }),
  message: varchar("message", { length: 280 }),
  eventDate: date("event_date").notNull(),
  startTime: varchar("start_time", { length: 10 }).notNull(),
  endTime: varchar("end_time", { length: 10 }),
  locationName: varchar("location_name", { length: 200 }),
  locationMapUrl: varchar("location_map_url", { length: 500 }),
  photoUrl: text("photo_url"),
  generatedImageUrl: text("generated_image_url"),
  generatedPdfUrl: text("generated_pdf_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("idx_invitation_designs_event").on(t.eventId),
]);

export const insertInvitationDesignSchema = createInsertSchema(invitationDesigns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvitationDesign = z.infer<typeof insertInvitationDesignSchema>;
export type InvitationDesign = typeof invitationDesigns.$inferSelect;

export const rsvpEntries = pgTable("rsvp_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
  guestName: varchar("guest_name", { length: 100 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  attendingStatus: rsvpStatusEnum("attending_status").notNull().default("yes"),
  numberOfKids: integer("number_of_kids").notNull().default(1),
  numberOfAdults: integer("number_of_adults").notNull().default(1),
  notes: varchar("notes", { length: 500 }),
  source: rsvpSourceEnum("source").notNull().default("guest_link"),
  language: parentExperienceLanguageEnum("language").notNull().default("en"),
  guestIdentifier: varchar("guest_identifier", { length: 100 }),
  isDeleted: boolean("is_deleted").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("idx_rsvp_entries_event").on(t.eventId),
  index("idx_rsvp_entries_status").on(t.eventId, t.attendingStatus),
  index("idx_rsvp_entries_guest_identifier").on(t.eventId, t.guestIdentifier),
]);

export const insertRsvpEntrySchema = createInsertSchema(rsvpEntries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  isDeleted: true,
});
export type InsertRsvpEntry = z.infer<typeof insertRsvpEntrySchema>;
export type RsvpEntry = typeof rsvpEntries.$inferSelect;

export const parentMessageLogs = pgTable("parent_message_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
  channel: messageChannelEnum("channel").notNull().default("whatsapp"),
  language: parentExperienceLanguageEnum("language").notNull().default("en"),
  messageTemplateVersion: varchar("message_template_version", { length: 50 }),
  renderedMessageText: text("rendered_message_text").notNull(),
  sentByUserId: varchar("sent_by_user_id").references(() => users.id),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  recipientPhone: varchar("recipient_phone", { length: 50 }),
  status: messageStatusEnum("status").notNull().default("opened_client"),
}, (t) => [
  index("idx_parent_message_logs_event").on(t.eventId),
]);

export const insertParentMessageLogSchema = createInsertSchema(parentMessageLogs).omit({
  id: true,
  sentAt: true,
});
export type InsertParentMessageLog = z.infer<typeof insertParentMessageLogSchema>;
export type ParentMessageLog = typeof parentMessageLogs.$inferSelect;

// ============================================
// ORG CHART MODULE
// ============================================

export const orgChartModeEnum = pgEnum("org_chart_mode", [
  "live",
  "draft",
]);

export const orgChartScopeTypeEnum = pgEnum("org_chart_scope_type", [
  "company",
  "branch",
]);

export const orgChartNodeTypeEnum = pgEnum("org_chart_node_type", [
  "person",
  "vacant_role",
]);

export const hiringStatusEnum = pgEnum("hiring_status", [
  "not_hiring",
  "hiring",
]);

export const employmentTypeEnum = pgEnum("employment_type", [
  "full_time",
  "part_time",
  "casual",
]);

export const orgNodes = pgTable("org_nodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  mode: orgChartModeEnum("mode").notNull().default("live"),
  scopeType: orgChartScopeTypeEnum("scope_type").notNull().default("company"),
  scopeBranchId: varchar("scope_branch_id").references(() => branches.id),
  nodeType: orgChartNodeTypeEnum("node_type").notNull().default("person"),
  personEmployeeId: varchar("person_employee_id").references(() => employees.id),
  title: varchar("title", { length: 255 }),
  nicknameOverride: varchar("nickname_override", { length: 100 }),
  positionTitle: varchar("position_title", { length: 255 }),
  branchId: varchar("branch_id").references(() => branches.id),
  departmentId: varchar("department_id").references(() => departments.id),
  reportsToNodeId: varchar("reports_to_node_id"),
  expectedMonthlySalary: real("expected_monthly_salary"),
  isVacant: boolean("is_vacant").notNull().default(false),
  isAdvisor: boolean("is_advisor").notNull().default(false),
  isDisabled: boolean("is_disabled").notNull().default(false),
  isDeleted: boolean("is_deleted").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  // Hiring & Recruitment fields
  hiringStatus: hiringStatusEnum("hiring_status").default("not_hiring"),
  employmentType: employmentTypeEnum("employment_type"),
  jobDescription: text("job_description"),
  keyResponsibilities: jsonb("key_responsibilities").$type<string[]>(),
  requirements: jsonb("requirements").$type<string[]>(),
  salaryRange: varchar("salary_range", { length: 100 }),
  benefits: jsonb("benefits").$type<string[]>(),
  contactPhone: varchar("contact_phone", { length: 50 }),
  contactLine: varchar("contact_line", { length: 100 }),
  contactEmail: varchar("contact_email", { length: 255 }),
  applyUrl: varchar("apply_url", { length: 500 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdBy: varchar("created_by").references(() => users.id),
  lastEditedBy: varchar("last_edited_by").references(() => users.id),
}, (t) => [
  index("idx_org_nodes_tenant").on(t.tenantId),
  index("idx_org_nodes_mode").on(t.mode),
  index("idx_org_nodes_scope").on(t.scopeType, t.scopeBranchId),
  index("idx_org_nodes_employee").on(t.personEmployeeId),
  index("idx_org_nodes_reports_to").on(t.reportsToNodeId),
  index("idx_org_nodes_department").on(t.departmentId),
]);

export const insertOrgNodeSchema = createInsertSchema(orgNodes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrgNode = z.infer<typeof insertOrgNodeSchema>;
export type OrgNode = typeof orgNodes.$inferSelect;

// ============================================
// HIRING MEDIA ASSETS - Venue photos for hiring posts
// ============================================

export const hiringMediaMoodEnum = pgEnum("hiring_media_mood", [
  "fun",
  "energetic",
  "calm",
  "professional",
]);

export const hiringMediaAssets = pgTable("hiring_media_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  filename: varchar("filename", { length: 255 }).notNull(),
  originalName: varchar("original_name", { length: 255 }),
  fileUrl: varchar("file_url", { length: 500 }).notNull(),
  thumbnailUrl: varchar("thumbnail_url", { length: 500 }),
  mimeType: varchar("mime_type", { length: 100 }),
  fileSize: integer("file_size"),
  branchId: varchar("branch_id").references(() => branches.id),
  departmentId: varchar("department_id").references(() => departments.id),
  mood: hiringMediaMoodEnum("mood"),
  description: text("description"),
  tags: jsonb("tags").$type<string[]>(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  uploadedBy: varchar("uploaded_by").references(() => users.id),
}, (t) => [
  index("idx_hiring_media_tenant").on(t.tenantId),
  index("idx_hiring_media_branch").on(t.branchId),
  index("idx_hiring_media_mood").on(t.mood),
]);

export const insertHiringMediaAssetSchema = createInsertSchema(hiringMediaAssets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertHiringMediaAsset = z.infer<typeof insertHiringMediaAssetSchema>;
export type HiringMediaAsset = typeof hiringMediaAssets.$inferSelect;

// ============================================
// BIRTHDAY PACKAGE TEMPLATES
// ============================================

export const birthdayPackageTemplates = pgTable(
  "birthday_package_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    basePrice: integer("base_price").notNull().default(0),
    pricingMode: text("pricing_mode").default("fixed"),
    includedSummary: text("included_summary"),
    excludedSummary: text("excluded_summary"),
    tags: jsonb("tags").$type<string[]>(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
  },
  (t) => [
    index("idx_birthday_package_templates_tenant").on(t.tenantId),
    index("idx_birthday_package_templates_active").on(t.isActive),
  ]
);

export const insertBirthdayPackageTemplateSchema = createInsertSchema(birthdayPackageTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBirthdayPackageTemplate = z.infer<typeof insertBirthdayPackageTemplateSchema>;
export type BirthdayPackageTemplate = typeof birthdayPackageTemplates.$inferSelect;

// ============================================
// PACKAGE LINE ITEM TEMPLATES
// ============================================

export const packageLineItemTemplates = pgTable(
  "package_line_item_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    packageTemplateId: uuid("package_template_id").references(() => birthdayPackageTemplates.id, { onDelete: "cascade" }).notNull(),
    category: text("category").notNull().default("other"),
    label: text("label").notNull(),
    description: text("description"),
    qtyDefault: integer("qty_default").notNull().default(1),
    qtyEditable: boolean("qty_editable").notNull().default(true),
    unitLabel: text("unit_label"),
    included: boolean("included").notNull().default(true),
    defaultUnitPrice: integer("default_unit_price").notNull().default(0),
    billableByDefault: boolean("billable_by_default").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_package_line_item_templates_package").on(t.packageTemplateId),
  ]
);

export const insertPackageLineItemTemplateSchema = createInsertSchema(packageLineItemTemplates).omit({
  id: true,
  createdAt: true,
});
export type InsertPackageLineItemTemplate = z.infer<typeof insertPackageLineItemTemplateSchema>;
export type PackageLineItemTemplate = typeof packageLineItemTemplates.$inferSelect;

// ============================================
// ENTERTAINMENT PACKAGE TEMPLATES
// ============================================

export const entertainmentPackageTemplates = pgTable(
  "entertainment_package_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes"),
    defaultPrice: integer("default_price").notNull().default(0),
    included: boolean("included").notNull().default(false),
    billableByDefault: boolean("billable_by_default").notNull().default(true),
    category: text("category"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
  },
  (t) => [
    index("idx_entertainment_package_templates_tenant").on(t.tenantId),
    index("idx_entertainment_package_templates_active").on(t.isActive),
  ]
);

export const insertEntertainmentPackageTemplateSchema = createInsertSchema(entertainmentPackageTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEntertainmentPackageTemplate = z.infer<typeof insertEntertainmentPackageTemplateSchema>;
export type EntertainmentPackageTemplate = typeof entertainmentPackageTemplates.$inferSelect;

// ============================================
// BEO PACKAGE SNAPSHOTS (per-event instance of a package)
// ============================================

export const beoPackageSnapshots = pgTable(
  "beo_package_snapshots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    templateId: uuid("template_id").references(() => birthdayPackageTemplates.id, { onDelete: "set null" }),
    templateNameAtApply: text("template_name_at_apply"),
    templateUpdatedAtAtApply: timestamp("template_updated_at_at_apply"),
    appliedAt: timestamp("applied_at").defaultNow().notNull(),
    packageName: text("package_name").notNull(),
    basePrice: integer("base_price").notNull().default(0),
    includedSummary: text("included_summary"),
    excludedSummary: text("excluded_summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_package_snapshots_event").on(t.eventId),
  ]
);

export const insertBeoPackageSnapshotSchema = createInsertSchema(beoPackageSnapshots).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoPackageSnapshot = z.infer<typeof insertBeoPackageSnapshotSchema>;
export type BeoPackageSnapshot = typeof beoPackageSnapshots.$inferSelect;

// ============================================
// BEO PACKAGE SNAPSHOT ITEMS (children of snapshot)
// ============================================

export const beoPackageSnapshotItems = pgTable(
  "beo_package_snapshot_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    snapshotId: uuid("snapshot_id").references(() => beoPackageSnapshots.id, { onDelete: "cascade" }).notNull(),
    sourceTemplateLineItemId: uuid("source_template_line_item_id").references(() => packageLineItemTemplates.id, { onDelete: "set null" }),
    category: text("category").notNull().default("other"),
    label: text("label").notNull(),
    description: text("description"),
    qty: integer("qty").notNull().default(1),
    unitLabel: text("unit_label"),
    included: boolean("included").notNull().default(true),
    unitPrice: integer("unit_price").notNull().default(0),
    billable: boolean("billable").notNull().default(true),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_package_snapshot_items_snapshot").on(t.snapshotId),
  ]
);

export const insertBeoPackageSnapshotItemSchema = createInsertSchema(beoPackageSnapshotItems).omit({
  id: true,
  createdAt: true,
});
export type InsertBeoPackageSnapshotItem = z.infer<typeof insertBeoPackageSnapshotItemSchema>;
export type BeoPackageSnapshotItem = typeof beoPackageSnapshotItems.$inferSelect;

// ============================================
// BEO ENTERTAINMENT SELECTIONS (per-event entertainment picks)
// ============================================

export const beoEntertainmentSelections = pgTable(
  "beo_entertainment_selections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull(),
    templateId: uuid("template_id").references(() => entertainmentPackageTemplates.id, { onDelete: "set null" }),
    templateNameAtApply: text("template_name_at_apply"),
    templateUpdatedAtAtApply: timestamp("template_updated_at_at_apply"),
    name: text("name").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes"),
    price: integer("price").notNull().default(0),
    billable: boolean("billable").notNull().default(true),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_entertainment_selections_event").on(t.eventId),
  ]
);

export const insertBeoEntertainmentSelectionSchema = createInsertSchema(beoEntertainmentSelections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoEntertainmentSelection = z.infer<typeof insertBeoEntertainmentSelectionSchema>;
export type BeoEntertainmentSelection = typeof beoEntertainmentSelections.$inferSelect;

// ============================================
// ANNOUNCEMENTS
// ============================================

export const announcementPriorityEnum = pgEnum("announcement_priority", [
  "info",
  "warning",
  "urgent",
]);

export const announcements = pgTable("announcements", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  priority: announcementPriorityEnum("priority").notNull().default("info"),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  branchIds: text("branch_ids").array(),
  departmentIds: text("department_ids").array(),
  showToEveryone: boolean("show_to_everyone").notNull().default(true),
  createdBy: varchar("created_by").references(() => users.id),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAnnouncementSchema = createInsertSchema(announcements).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAnnouncement = z.infer<typeof insertAnnouncementSchema>;
export type Announcement = typeof announcements.$inferSelect;

// ============================================
// ============================================
// NOTIFICATIONS
// ============================================

export const notificationTypeEnum = pgEnum("notification_type", [
  "task_comment",
  "task_assigned",
  "task_status_changed",
  "task_completed",
  "task_escalated",
  "task_attachment",
  "task_checklist_update",
  "task_mentioned",
  "checklist_assigned",
  "announcement",
  "task_due_date_changed",
  "task_priority_changed",
]);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    recipientUserId: varchar("recipient_user_id").references(() => users.id).notNull(),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    actorUserId: varchar("actor_user_id").references(() => users.id),
    actorName: text("actor_name"),
    isRead: boolean("is_read").default(false).notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_notifications_recipient").on(t.recipientUserId),
    index("idx_notifications_recipient_unread").on(t.recipientUserId, t.isRead),
    index("idx_notifications_created").on(t.createdAt),
    index("idx_notifications_reference").on(t.referenceType, t.referenceId),
  ]
);

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;

// ============================================
// BEO SET MENU TEMPLATES
// ============================================

export const beoSetMenuTemplates = pgTable(
  "beo_set_menu_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    items: jsonb("items").notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_set_menu_templates_tenant").on(t.tenantId),
  ]
);

export const insertBeoSetMenuTemplateSchema = createInsertSchema(beoSetMenuTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoSetMenuTemplate = z.infer<typeof insertBeoSetMenuTemplateSchema>;
export type BeoSetMenuTemplate = typeof beoSetMenuTemplates.$inferSelect;

// ============================================
// BEO SET MENU SELECTIONS (per-event parent selections)
// ============================================

export const beoSetMenuSelections = pgTable(
  "beo_set_menu_selections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => coreEvents.id, { onDelete: "cascade" }).notNull().unique(),
    templateId: uuid("template_id").references(() => beoSetMenuTemplates.id).notNull(),
    token: text("token").notNull().unique(),
    isSubmitted: boolean("is_submitted").notNull().default(false),
    submittedAt: timestamp("submitted_at"),
    selections: jsonb("selections"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_beo_set_menu_selections_event").on(t.eventId),
    index("idx_beo_set_menu_selections_token").on(t.token),
  ]
);

export const insertBeoSetMenuSelectionSchema = createInsertSchema(beoSetMenuSelections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBeoSetMenuSelection = z.infer<typeof insertBeoSetMenuSelectionSchema>;
export type BeoSetMenuSelection = typeof beoSetMenuSelections.$inferSelect;

// CAMP REGISTRATIONS
// ============================================

export const campRegistrations = pgTable(
  "camp_registrations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull(),
    eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
    childFullName: text("child_full_name").notNull(),
    dateOfBirth: text("date_of_birth").notNull(),
    parentGuardianName: text("parent_guardian_name").notNull(),
    emergencyContactNumber: text("emergency_contact_number").notNull(),
    allergiesNotes: text("allergies_notes"),
    allergies: text("allergies"),
    foodRestrictions: text("food_restrictions"),
    behavioralNotes: text("behavioral_notes"),
    specialNotes: text("special_notes"),
    authorizedPickupPersons: text("authorized_pickup_persons"),
    primaryLanguage: text("primary_language"),
    childPhotoUrl: text("child_photo_url"),
    parentPhotoUrl: text("parent_photo_url"),
    pickupPhotoUrl: text("pickup_photo_url"),
    parentContacts: jsonb("parent_contacts").$type<Array<{name: string; phone: string}>>(),
    attendanceDays: jsonb("attendance_days").$type<string[]>().default([]),
    agreedCampRules: boolean("agreed_camp_rules").notNull().default(false),
    agreedChildHealthy: boolean("agreed_child_healthy").notNull().default(false),
    agreedCampRulesDate: timestamp("agreed_camp_rules_date"),
    agreedCampRulesHistory: jsonb("agreed_camp_rules_history").$type<string[]>().default([]),
    parentSignature: text("parent_signature").notNull(),
    signatureDate: text("signature_date").notNull(),
    checkedInAt: timestamp("checked_in_at"),
    checkedInBy: varchar("checked_in_by", { length: 255 }),
    checkedOutAt: timestamp("checked_out_at"),
    checkedOutBy: varchar("checked_out_by", { length: 255 }),
    isOneTime: boolean("is_one_time").notNull().default(false),
    addedByManager: boolean("added_by_manager").notNull().default(false),
    // A parent stays with the child at the camp. The POS prints a parent band
    // beside the kid band at check-in when this is set (events-kiosk PLAN s3,
    // "Bands at check-in").
    parentAttending: boolean("parent_attending").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_camp_registrations_event").on(t.eventId),
    index("idx_camp_registrations_tenant").on(t.tenantId),
  ]
);

export const insertCampRegistrationSchema = createInsertSchema(campRegistrations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampRegistration = z.infer<typeof insertCampRegistrationSchema>;
export type CampRegistration = typeof campRegistrations.$inferSelect;

// ============================================
// CAMP ATTENDANCE (daily per-child records)
// ============================================

export const campAttendanceStatusEnum = pgEnum("camp_attendance_status", [
  "waiting",
  "checked_in",
  "checked_out",
]);

export const campAttendance = pgTable(
  "camp_attendance",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campRegistrationId: uuid("camp_registration_id").notNull().references(() => campRegistrations.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull(),
    eventId: uuid("event_id").notNull(),
    attendanceDate: date("attendance_date").notNull(),
    status: campAttendanceStatusEnum("status").notNull().default("waiting"),
    checkedInAt: timestamp("checked_in_at"),
    checkedInBy: varchar("checked_in_by", { length: 255 }),
    checkedOutAt: timestamp("checked_out_at"),
    checkedOutBy: varchar("checked_out_by", { length: 255 }),
    paymentMethod: varchar("payment_method", { length: 50 }),
    dropOffPerson: text("drop_off_person"),
    pickUpPerson: text("pick_up_person"),
    staffNotes: text("staff_notes"),
    // The id the caller minted for a check-in written through the directory
    // API (`POST /api/directory/events/:id/attendees/:attendeeId/checkins`).
    // A retry carries the same id and is answered from this row instead of
    // being refused as a second check-in. Null for every check-in made in the
    // app itself, and for the "waiting" rows the app seeds ahead of the day.
    checkinRef: uuid("checkin_ref"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_camp_attendance_reg").on(t.campRegistrationId),
    index("idx_camp_attendance_tenant_date").on(t.tenantId, t.attendanceDate),
    unique("uq_camp_attendance_reg_date").on(t.campRegistrationId, t.attendanceDate),
    uniqueIndex("uq_camp_attendance_checkin_ref")
      .on(t.checkinRef)
      .where(sql`${t.checkinRef} IS NOT NULL`),
  ]
);

export const insertCampAttendanceSchema = createInsertSchema(campAttendance).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampAttendance = z.infer<typeof insertCampAttendanceSchema>;
export type CampAttendance = typeof campAttendance.$inferSelect;

// ============================================
// EVENT ATTENDEES (one row per child on a one-off event or a party)
// ============================================

// A camp keeps one `camp_registrations` row per child. A one-off event or a
// party kept only counts and names typed as text (`studio_event_bookings`
// .kids_count / .kid_names, `core_events.num_children`), so there was no row a
// check-in could hang off. This is that row (events-kiosk PLAN Q7). It is
// written by the directory API for walk-ups the POS adds at the door, and is
// read by the POS through the view `otoapp_v.event_attendees`.
//
// `id` has a default, but the directory API inserts the id its caller minted,
// so a retried request finds the row it already made instead of adding a
// second child.
export const EVENT_ATTENDEE_SOURCES = ["otoapp", "pos", "booking", "kiosk"] as const;
export type EventAttendeeSource = (typeof EVENT_ATTENDEE_SOURCES)[number];

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
    // The group booking this child arrived under, when there is one.
    bookingId: uuid("booking_id").references(() => studioEventBookings.id, { onDelete: "set null" }),
    childFullName: text("child_full_name").notNull(),
    dateOfBirth: text("date_of_birth"), // yyyy-MM-dd, like camp_registrations
    ageYears: integer("age_years"),
    primaryLanguage: text("primary_language"),
    allergies: text("allergies"),
    foodRestrictions: text("food_restrictions"),
    parentName: text("parent_name"),
    parentPhone: text("parent_phone"),
    parentAttending: boolean("parent_attending").notNull().default(false),
    notes: text("notes"),
    source: text("source", { enum: EVENT_ATTENDEE_SOURCES }).notNull().default("otoapp"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_event_attendees_event").on(t.eventId),
    index("idx_event_attendees_tenant").on(t.tenantId),
    index("idx_event_attendees_booking").on(t.bookingId),
    check("event_attendees_source_check", sql`${t.source} IN ('otoapp', 'pos', 'booking', 'kiosk')`),
    check("event_attendees_age_check", sql`${t.ageYears} IS NULL OR ${t.ageYears} >= 0`),
  ]
);

export type EventAttendee = typeof eventAttendees.$inferSelect;

// One check-in per attendee per day, the one-off-event twin of
// `camp_attendance`, carrying the same three states and the same
// `checkin_ref`: the id a directory caller minted for the check-in.
export const eventAttendeeCheckins = pgTable(
  "event_attendee_checkins",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    eventId: uuid("event_id").notNull().references(() => coreEvents.id, { onDelete: "cascade" }),
    attendeeId: uuid("attendee_id").notNull().references(() => eventAttendees.id, { onDelete: "cascade" }),
    attendanceDate: date("attendance_date").notNull(),
    status: campAttendanceStatusEnum("status").notNull().default("waiting"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedInBy: varchar("checked_in_by", { length: 255 }),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    checkedOutBy: varchar("checked_out_by", { length: 255 }),
    checkinRef: uuid("checkin_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_event_attendee_checkins_event").on(t.eventId),
    index("idx_event_attendee_checkins_tenant_date").on(t.tenantId, t.attendanceDate),
    unique("uq_event_attendee_checkins_attendee_date").on(t.attendeeId, t.attendanceDate),
    uniqueIndex("uq_event_attendee_checkins_checkin_ref")
      .on(t.checkinRef)
      .where(sql`${t.checkinRef} IS NOT NULL`),
  ]
);

export type EventAttendeeCheckin = typeof eventAttendeeCheckins.$inferSelect;

// BEO EXTENDED EVENT TYPE (combines event with all BEO data)
// ============================================

export type BeoEventWithDetails = Event & {
  partyHost?: BeoPartyHostAssignment | null;
  entertainment?: BeoEntertainmentAssignment | null;
  setupPlan?: BeoSetupPlan | null;
  kitchenPlan?: (BeoKitchenPlan & {
    setMenuSelectionStatus?: {
      isSubmitted: boolean;
      submittedAt: Date | string | null;
      templateId: string;
    } | null;
    setMenuTemplate?: Pick<BeoSetMenuTemplate, "id" | "name" | "items"> | null;
  }) | null;
  billing?: BeoEventBilling | null;
  timeline?: BeoTimelineItem[];
  location?: BeoLocation | null;
  lineItems?: EventLineItem[];
  parentPortalToken?: ParentPortalToken | null;
  guestInviteToken?: GuestInviteToken | null;
  rsvpSummary?: {
    yes: number;
    no: number;
    maybe: number;
    totalKids: number;
    totalAdults: number;
    notesCount: number;
  } | null;
  packageSnapshot?: BeoPackageSnapshot & { items?: BeoPackageSnapshotItem[] } | null;
  entertainmentSelections?: BeoEntertainmentSelection[];
  partyDetails?: { items: any[]; notes: string } | null;
};
