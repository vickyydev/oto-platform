import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, boolean, index, uniqueIndex, time, date, real, uuid, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

// ============================================
// MULTI-TENANT FOUNDATION
// ============================================

// Tenants table (multi-tenant support)
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertTenantSchema = createInsertSchema(tenants).omit({
  id: true,
  createdAt: true,
});

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenants.$inferSelect;

// Default tenant slug constant
export const DEFAULT_TENANT_SLUG = "default";

// ============================================
// OPERATORS (Multi-Operator Support)
// ============================================

// Operator status
export const operatorStatuses = ["active", "archived"] as const;
export type OperatorStatus = typeof operatorStatuses[number];

// Operators table (organization grouping for branches)
export const operators = pgTable("operators", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: operatorStatuses }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_operators_tenant").on(table.tenantId),
  index("idx_operators_status").on(table.status),
]);

export const operatorsRelations = relations(operators, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [operators.tenantId],
    references: [tenants.id],
  }),
  branches: many(branches),
}));

export const insertOperatorSchema = createInsertSchema(operators).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOperator = z.infer<typeof insertOperatorSchema>;
export type Operator = typeof operators.$inferSelect;

// ============================================
// FILES TABLE (Object Storage)
// ============================================

// Files table for object-storage-backed uploads
export const files = pgTable("files", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  source: text("source").notNull(), // e.g. 'core_legacy'
  originalFilename: text("original_filename").notNull(),
  storageKey: text("storage_key").notNull(), // full object key including STORAGE_ENV_PREFIX
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_files_tenant_created").on(table.tenantId, table.createdAt),
]);

export const filesRelations = relations(files, ({ one }) => ({
  tenant: one(tenants, {
    fields: [files.tenantId],
    references: [tenants.id],
  }),
}));

export const insertFileSchema = createInsertSchema(files).omit({
  id: true,
  createdAt: true,
});

export type InsertFile = z.infer<typeof insertFileSchema>;
export type File = typeof files.$inferSelect;

// User roles (multi-level RBAC with operator support)
// global_admin: full platform access across all operators/branches
// operator_admin: access limited to single operator, can manage all branches within operator
// admin: legacy admin role (treated as global_admin for backwards compatibility)
// manager: branch-level manager access
// staff: basic staff access
// advisor: external consultant / shared-device login with no employee record. The raw DB
//   value always stays "advisor" for identity/org-chart purposes; the effective RBAC role
//   (admin/manager/staff) is resolved at runtime from access_policies.accessLevel in
//   storage.ts getUserWithBranchAccess(). Never gate features on the literal "advisor"
//   value elsewhere — always use the resolved role from getUserWithBranchAccess.
export const userRoles = ["global_admin", "operator_admin", "admin", "manager", "staff", "advisor"] as const;
export type UserRole = typeof userRoles[number];

// Branch access scope
export const branchAccessScopes = ["all_branches", "selected_branches"] as const;
export type BranchAccessScope = typeof branchAccessScopes[number];

// Users table with roles
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").unique(), // auto-generated unique username for login
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  fullName: text("full_name").notNull(),
  preferredName: text("preferred_name"),
  role: text("role", { enum: userRoles }).notNull().default("staff"),
  operatorId: uuid("operator_id").references(() => operators.id), // required for operator_admin, null for global_admin
  isActive: boolean("is_active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  permissionReviewRequired: boolean("permission_review_required").notNull().default(false),
  createdBy: varchar("created_by"),
  lastLoginAt: timestamp("last_login_at"),
  // Phone verification fields for SMS OTP password reset
  phoneNumber: text("phone_number"), // user-entered format
  phoneE164: text("phone_e164").unique(), // E.164 normalized format for Twilio
  phoneVerified: boolean("phone_verified").notNull().default(false),
  phoneVerifiedAt: timestamp("phone_verified_at"),
  profilePhotoPath: text("profile_photo_path"),
  // The platform account this user is the same person as. Nullable because
  // every user here predates the platform: the link is made afterwards by the
  // provisioning service, not at creation, and a user who never signs in
  // through the launcher never gets one.
  platformUserId: uuid("platform_user_id").unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_users_operator").on(table.operatorId),
  index("idx_users_username").on(table.username),
]);
export const session = pgTable("session", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire").notNull(),
});

export const usersRelations = relations(users, ({ one }) => ({
  operator: one(operators, {
    fields: [users.operatorId],
    references: [operators.id],
  }),
}));

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  email: true,
  password: true,
  fullName: true,
  role: true,
  operatorId: true,
  isActive: true,
  mustChangePassword: true,
  createdBy: true,
  phoneNumber: true,
  phoneE164: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Extended user type with operator info
export type UserWithOperator = User & {
  operator?: Operator | null;
};

// User branch access table (for role-based branch permissions)
export const userBranchAccess = pgTable("user_branch_access", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id), // NULL when access_scope is all_branches
  accessScope: text("access_scope", { enum: branchAccessScopes }).notNull().default("selected_branches"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_user_branch_access_tenant").on(table.tenantId),
]);

export const userBranchAccessRelations = relations(userBranchAccess, ({ one }) => ({
  user: one(users, {
    fields: [userBranchAccess.userId],
    references: [users.id],
  }),
  branch: one(branches, {
    fields: [userBranchAccess.branchId],
    references: [branches.id],
  }),
}));

export const insertUserBranchAccessSchema = createInsertSchema(userBranchAccess).omit({
  id: true,
  createdAt: true,
});

export type InsertUserBranchAccess = z.infer<typeof insertUserBranchAccessSchema>;
export type UserBranchAccess = typeof userBranchAccess.$inferSelect;

// Extended user type with branch access info
export type UserWithBranchAccess = User & {
  branchAccess: UserBranchAccess[];
  hasAllBranchesAccess: boolean;
  allowedBranchIds: string[];
  tenantId?: string;
  modules?: ModuleAccess;
  linkedEmployeeId?: string;
  linkedEmployeeProfilePhoto?: string | null;
};

// ============================================
// PEOPLE (Identity Anchor Layer)
// ============================================

// Person types - employees vs external advisors
export const personTypes = ["EMPLOYEE", "ADVISOR"] as const;
export type PersonType = typeof personTypes[number];

// People table (identity anchor for employees and advisors)
export const people = pgTable("people", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fullName: text("full_name").notNull(),
  preferredName: text("preferred_name"),
  email: text("email").notNull().unique(),
  personType: text("person_type", { enum: personTypes }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  isProtected: boolean("is_protected").notNull().default(false),
  // Timeclock PIN fields (moved from employees for person-level uniqueness)
  timeclockPinHash: text("timeclock_pin_hash"), // bcrypt/argon2 hash for verification
  timeclockPinFingerprint: text("timeclock_pin_fingerprint").unique(), // HMAC for uniqueness check
  timeclockPinSetAt: timestamp("timeclock_pin_set_at"),
  timeclockPinRequired: boolean("timeclock_pin_required").default(true),
  // Phone verification fields for SMS OTP (for advisors with login access)
  phoneNumber: text("phone_number"), // user-entered format
  phoneE164: text("phone_e164"), // E.164 normalized format for Twilio
  phoneVerified: boolean("phone_verified").notNull().default(false),
  phoneVerifiedAt: timestamp("phone_verified_at"),
  // Department assignment for advisors
  departmentId: varchar("department_id"),
  // Kiosk biometric enrollment belongs to the person for advisors (who have no employee row).
  faceEnrollmentStatus: text("face_enrollment_status", { enum: ["NOT_ENROLLED", "ENROLLED", "SUSPENDED"] }).default("NOT_ENROLLED"),
  faceId: text("face_id"),
  faceEnrolledAt: timestamp("face_enrolled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_people_phone_e164").on(table.phoneE164),
]);

export const peopleRelations = relations(people, ({ one }) => ({
  employee: one(employees, {
    fields: [people.id],
    references: [employees.personId],
  }),
  accessPolicy: one(accessPolicies, {
    fields: [people.id],
    references: [accessPolicies.personId],
  }),
  department: one(departments, {
    fields: [people.departmentId],
    references: [departments.id],
  }),
}));

export const insertPersonSchema = createInsertSchema(people).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPerson = z.infer<typeof insertPersonSchema>;
export type Person = typeof people.$inferSelect;

// ============================================
// ACCESS POLICIES (Source of Truth for Permissions)
// ============================================

// Access levels for people
export const accessLevels = ["STAFF", "MANAGER", "ADMIN"] as const;
export type AccessLevel = typeof accessLevels[number];

// Branch scope types
export const branchScopes = ["ALL", "SELECTED"] as const;
export type BranchScope = typeof branchScopes[number];

// Module access schema
export const moduleAccessSchema = z.object({
  core: z.boolean().default(false),
  hr: z.boolean().default(false),
  studio: z.boolean().default(false),
  events: z.boolean().default(false),
  ops: z.boolean().default(false),
  setup: z.boolean().default(false),
});

export type ModuleAccess = z.infer<typeof moduleAccessSchema>;

// Provisioning status enum
export const provisioningStatuses = ["NOT_STARTED", "SUCCESS", "FAILED"] as const;
export type ProvisioningStatus = typeof provisioningStatuses[number];

// Access policies table
export const accessPolicies = pgTable("access_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  personId: varchar("person_id").references(() => people.id, { onDelete: "cascade" }).notNull().unique(),
  accessLevel: text("access_level", { enum: accessLevels }).notNull(),
  modules: jsonb("modules").$type<ModuleAccess>().notNull(),
  branchScope: text("branch_scope", { enum: branchScopes }).notNull(),
  branchIds: jsonb("branch_ids").$type<string[]>(), // if SELECTED
  // Core account provisioning
  coreAccountEnabled: boolean("core_account_enabled").notNull().default(false),
  coreUserId: varchar("core_user_id"), // returned from Core provisioning API
  coreAccountProvisionedAt: timestamp("core_account_provisioned_at"),
  linkedToExistingCoreAccount: boolean("linked_to_existing_core_account").default(false), // true if linked to pre-existing Core account
  // Provisioning status tracking
  provisioningStatus: text("provisioning_status", { enum: provisioningStatuses }).default("NOT_STARTED"),
  provisioningLastError: text("provisioning_last_error"),
  provisioningLastAttemptAt: timestamp("provisioning_last_attempt_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_access_policies_tenant").on(table.tenantId),
]);

export const accessPoliciesRelations = relations(accessPolicies, ({ one }) => ({
  person: one(people, {
    fields: [accessPolicies.personId],
    references: [people.id],
  }),
}));

export const insertAccessPolicySchema = createInsertSchema(accessPolicies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  coreUserId: true,
  coreAccountProvisionedAt: true,
  linkedToExistingCoreAccount: true,
});

// Update schema includes provisioning fields that can be set by the system
export const updateAccessPolicySchema = createInsertSchema(accessPolicies).omit({
  id: true,
  personId: true,
  createdAt: true,
  updatedAt: true,
}).partial();

export type InsertAccessPolicy = z.infer<typeof insertAccessPolicySchema>;
export type UpdateAccessPolicy = z.infer<typeof updateAccessPolicySchema>;
export type AccessPolicy = typeof accessPolicies.$inferSelect;

// Extended types for people with access
export type PersonWithAccess = Person & {
  accessPolicy?: AccessPolicy;
  employee?: Employee;
};

// ============================================
// USER MODULE OVERRIDES (Granular Permission Overrides)
// ============================================

export const moduleKeyEnum = [
  "today", "tasks", "checklists", "scheduling", "events",
  "hr", "hr_admin", "org_chart", "reports", "settings", "studio",
] as const;

export const branchScopeTypes = ["HOME_ONLY", "ALL", "CUSTOM"] as const;

export const userModuleOverrides = pgTable("user_module_overrides", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  moduleKey: text("module_key", { enum: moduleKeyEnum }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  branchScopeType: text("branch_scope_type", { enum: branchScopeTypes }).notNull().default("HOME_ONLY"),
  branchIds: jsonb("branch_ids").$type<string[]>().default([]),
  notes: text("notes"),
  updatedBy: varchar("updated_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_user_module_overrides_user").on(table.userId),
  index("idx_user_module_overrides_tenant").on(table.tenantId),
]);

export const userModuleOverridesRelations = relations(userModuleOverrides, ({ one }) => ({
  user: one(users, {
    fields: [userModuleOverrides.userId],
    references: [users.id],
  }),
  updater: one(users, {
    fields: [userModuleOverrides.updatedBy],
    references: [users.id],
  }),
}));

export const insertUserModuleOverrideSchema = createInsertSchema(userModuleOverrides).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserModuleOverride = z.infer<typeof insertUserModuleOverrideSchema>;
export type UserModuleOverride = typeof userModuleOverrides.$inferSelect;

// Branches table
export const branches = pgTable("branches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  operatorId: uuid("operator_id").references(() => operators.id), // operator this branch belongs to
  name: text("name").notNull(),
  address: text("address").notNull(),
  logoUrl: text("logo_url"),
  calendarColor: text("calendar_color"),
  googleDriveFolder: text("google_drive_folder"),
  googleDriveFolderName: text("google_drive_folder_name"),
  timezone: text("timezone").default("Asia/Bangkok").notNull(), // IANA timezone identifier
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Core sync fields. Written by the platform (SCRUM-268): core_branch_id is
  // the platform branch id as text; APP_ONLY marks a row that trades nowhere
  // (Head Office) and is deliberately left unmapped.
  coreBranchId: text("core_branch_id"),
  coreSyncStatus: text("core_sync_status").$type<"PENDING" | "SUCCESS" | "FAILED" | "APP_ONLY" | null>(),
  coreSyncedAt: timestamp("core_synced_at"),
  coreSyncError: text("core_sync_error"),
}, (table) => [
  index("idx_branches_tenant").on(table.tenantId),
  index("idx_branches_operator").on(table.operatorId),
  uniqueIndex("branches_tenant_calendar_color_unique")
    .on(table.tenantId, sql`lower(${table.calendarColor})`)
    .where(sql`${table.calendarColor} IS NOT NULL`),
  // One platform branch, at most one row here (SCRUM-319). The platform maps a
  // branch into this table by reading the rows first and writing if it finds
  // none, and a concurrent create reads the same "none" — so two rows could
  // carry one core_branch_id, and which of them a person was seated in came
  // down to which the next reader happened to find first. Partial, because
  // every row that predates the mapping carries null and Head Office always
  // will.
  uniqueIndex("branches_core_branch_id_unique")
    .on(table.coreBranchId)
    .where(sql`${table.coreBranchId} IS NOT NULL`),
]);

export const insertBranchSchema = createInsertSchema(branches).omit({
  id: true,
  createdAt: true,
  coreBranchId: true,
  coreSyncStatus: true,
  coreSyncedAt: true,
  coreSyncError: true,
  calendarColor: true,
});

export type InsertBranch = z.infer<typeof insertBranchSchema>;
export type Branch = typeof branches.$inferSelect;

export const branchesRelations = relations(branches, ({ one }) => ({
  tenant: one(tenants, {
    fields: [branches.tenantId],
    references: [tenants.id],
  }),
  operator: one(operators, {
    fields: [branches.operatorId],
    references: [operators.id],
  }),
}));

// ============================================
// KIOSK SYSTEM (Reception Check-in)
// ============================================

// Kiosk codes - one-time codes for device activation (expires in 120 seconds)
export const kioskCodes = pgTable("kiosk_codes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  codeHash: text("code_hash").notNull(), // SHA-256(code + pepper)
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_kiosk_codes_branch").on(table.branchId),
  index("idx_kiosk_codes_hash").on(table.codeHash),
]);

export const kioskCodesRelations = relations(kioskCodes, ({ one }) => ({
  tenant: one(tenants, {
    fields: [kioskCodes.tenantId],
    references: [tenants.id],
  }),
  branch: one(branches, {
    fields: [kioskCodes.branchId],
    references: [branches.id],
  }),
}));

export const insertKioskCodeSchema = createInsertSchema(kioskCodes).omit({
  id: true,
  createdAt: true,
});

export type InsertKioskCode = z.infer<typeof insertKioskCodeSchema>;
export type KioskCode = typeof kioskCodes.$inferSelect;

// Template statuses
export const templateStatuses = ["active", "archived"] as const;
export type TemplateStatus = typeof templateStatuses[number];

// Template types (document categories for HR lifecycle)
export const templateTypes = ["employment", "promotion", "warning", "resignation", "termination"] as const;
export type TemplateType = typeof templateTypes[number];

// Template type display labels
export const templateTypeLabels: Record<TemplateType, string> = {
  employment: "Employment Agreement",
  promotion: "Promotion Letter",
  warning: "Warning Letter",
  resignation: "Resignation Letter",
  termination: "Termination Letter",
};

// Template type colors for badges
export const templateTypeColors: Record<TemplateType, string> = {
  employment: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  promotion: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  warning: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  resignation: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  termination: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

// Header alignment options
export const headerAlignments = ["left", "center", "right"] as const;
export type HeaderAlignment = typeof headerAlignments[number];

// Templates table with versioning (company-level library)
export const templates = pgTable("templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  htmlBody: text("html_body").notNull(),
  htmlBodyTh: text("html_body_th"),
  version: integer("version").notNull().default(1),
  status: text("status", { enum: templateStatuses }).notNull().default("active"),
  templateType: text("template_type", { enum: templateTypes }).notNull().default("employment"),
  forkedFromTemplateId: varchar("forked_from_template_id"),
  // Header configuration
  headerShowLogo: boolean("header_show_logo").notNull().default(true),
  headerShowAddress: boolean("header_show_address").notNull().default(true),
  headerAlignment: text("header_alignment", { enum: headerAlignments }).notNull().default("left"),
  // Audit trail
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const templatesRelations = relations(templates, ({ one, many }) => ({
  forkedFromTemplate: one(templates, {
    fields: [templates.forkedFromTemplateId],
    references: [templates.id],
    relationName: "fork",
  }),
  createdByUser: one(users, {
    fields: [templates.createdBy],
    references: [users.id],
    relationName: "templateCreator",
  }),
  updatedByUser: one(users, {
    fields: [templates.updatedBy],
    references: [users.id],
    relationName: "templateUpdater",
  }),
  assignments: many(templateAssignments),
}));

export const insertTemplateSchema = createInsertSchema(templates).omit({
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTemplate = z.infer<typeof insertTemplateSchema>;
export type Template = typeof templates.$inferSelect;

// Template assignments table (many-to-many between templates and branches)
export const templateAssignments = pgTable("template_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateId: varchar("template_id").references(() => templates.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  isDefaultForBranch: boolean("is_default_for_branch").notNull().default(false),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: varchar("assigned_by").references(() => users.id),
});

export const templateAssignmentsRelations = relations(templateAssignments, ({ one }) => ({
  template: one(templates, {
    fields: [templateAssignments.templateId],
    references: [templates.id],
  }),
  branch: one(branches, {
    fields: [templateAssignments.branchId],
    references: [branches.id],
  }),
  assignedByUser: one(users, {
    fields: [templateAssignments.assignedBy],
    references: [users.id],
  }),
}));

export const insertTemplateAssignmentSchema = createInsertSchema(templateAssignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertTemplateAssignment = z.infer<typeof insertTemplateAssignmentSchema>;
export type TemplateAssignment = typeof templateAssignments.$inferSelect;

// Custom clause schema for special terms
export const customClauseSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export type CustomClause = z.infer<typeof customClauseSchema>;

// Merge data schema for contract (defined here so it can be used by employees)
// Note: workLocation is derived from employee.branch, not stored in mergeData
export const mergeDataSchema = z.object({
  positionTitle: z.string(),
  salaryThb: z.number(),
  startDate: z.string(),
  workLocation: z.string().optional(), // Legacy: now derived from branch, kept for backward compatibility
  incentiveClause: z.string().optional(),
  customClauses: z.array(customClauseSchema).optional(),
  todayDate: z.string().optional(), // Frozen at finalization time
  // Legacy fields for backward compatibility
  extraClause1Title: z.string().optional(),
  extraClause1Body: z.string().optional(),
  extraClause2Title: z.string().optional(),
  extraClause2Body: z.string().optional(),
});

export type MergeData = z.infer<typeof mergeDataSchema>;

// Employees table
export const employeeStatuses = ["pending", "active", "resigned", "terminated"] as const;
export type EmployeeStatus = typeof employeeStatuses[number];

// Employment state model (improved status tracking)
export const employmentStates = ["ACTIVE", "LEAVING", "LEFT"] as const;
export type EmploymentState = typeof employmentStates[number];

// Face enrollment status for timekeeping
export const faceEnrollmentStatuses = ["NOT_ENROLLED", "ENROLLED", "SUSPENDED"] as const;
export type FaceEnrollmentStatus = typeof faceEnrollmentStatuses[number];

// Employment basis - full-time (monthly salary) vs part-time (daily rate)
export const employmentBasisTypes = ["FULL_TIME", "PART_TIME"] as const;
export type EmploymentBasis = typeof employmentBasisTypes[number];

// Offboarding types (declared here for use in employees table)
export const offboardingTypes = ["RESIGNATION", "TERMINATION"] as const;
export type OffboardingType = typeof offboardingTypes[number];

// End reason is now free-text instead of enum
export type EndReason = string | null;

export const employees = pgTable("employees", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  personId: varchar("person_id").references(() => people.id, { onDelete: "cascade" }).unique(), // nullable for migration, should be NOT NULL after migration
  fullName: text("full_name").notNull(),
  thaiName: text("thai_name"), // Thai language name (optional)
  nickname: text("nickname").notNull(), // Nickname/preferred name (required)
  email: text("email").notNull(),
  phone: text("phone"),
  address: text("address"),
  branchId: varchar("branch_id").references(() => branches.id),
  status: text("status", { enum: employeeStatuses }).notNull().default("pending"),
  employmentState: text("employment_state", { enum: employmentStates }).notNull().default("ACTIVE"),
  offboardingType: text("offboarding_type", { enum: offboardingTypes }),
  noticeDate: timestamp("notice_date"),
  defaultMergeData: jsonb("default_merge_data").$type<Partial<MergeData>>(),
  incentiveClauseText: text("incentive_clause_text"),
  foodAllowancePerDay: integer("food_allowance_per_day"),
  // Employment basis - full-time (monthly salary) vs part-time (daily rate)
  employmentBasis: text("employment_basis", { enum: employmentBasisTypes }).notNull().default("FULL_TIME"),
  dailyRate: integer("daily_rate"), // For part-time employees only (THB per day)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startDate: timestamp("start_date"),
  probationDays: integer("probation_days"), // nullable - if null, use company default
  probationEndDate: timestamp("probation_end_date"),
  probationReviewCompletedAt: timestamp("probation_review_completed_at"),
  endReason: text("end_reason"),
  lastWorkingDay: timestamp("last_working_day"),
  resignationFormPath: text("resignation_form_path"),
  terminationLetterPath: text("termination_letter_path"),
  nationality: text("nationality"),
  isForeignStaff: boolean("is_foreign_staff").default(false),
  visaExpiryDate: timestamp("visa_expiry_date"),
  workPermitExpiryDate: timestamp("work_permit_expiry_date"),
  ssoNumber: text("sso_number"),
  taxIdNumber: text("tax_id_number"),
  // Visa/Work Permit policy fields for foreign employees
  visaWpCompanyHandles: boolean("visa_wp_company_handles"),
  visaWpCompanyPays: boolean("visa_wp_company_pays"),
  visaWpCostThb: integer("visa_wp_cost_thb"),
  visaWpRepaymentIfFailProbation: boolean("visa_wp_repayment_if_fail_probation"),
  visaWpRepaymentIfLeaveBefore1y: boolean("visa_wp_repayment_if_leave_before_1y"),
  visaWpRepaymentTermsText: text("visa_wp_repayment_terms_text"),
  visaWpNotes: text("visa_wp_notes"),
  // Job description (rich text HTML, editable by admin/manager only)
  jobDescription: text("job_description"),
  // Phone number for kiosk fallback identification (E.164 normalized, unique per employee)
  phoneE164: text("phone_e164"),
  // Timekeeping / Face enrollment fields
  faceEnrollmentStatus: text("face_enrollment_status", { enum: faceEnrollmentStatuses }).default("NOT_ENROLLED"),
  faceId: text("face_id"), // AWS Rekognition face ID reference
  faceEnrolledAt: timestamp("face_enrolled_at"),
  timeclockPinHash: text("timeclock_pin_hash"), // bcrypt/argon2 hash (deprecated - kept for migration)
  timeclockPinSetAt: timestamp("timeclock_pin_set_at"),
  timeclockPinRequired: boolean("timeclock_pin_required").default(true),
  // Phone fallback usage tracking for attention rules
  phoneFallbackCount30Day: integer("phone_fallback_count_30day").default(0),
  phoneFallbackCountResetAt: timestamp("phone_fallback_count_reset_at"),
  // PIN usage tracking (deprecated - kept for migration)
  pinUsageCount30Day: integer("pin_usage_count_30day").default(0),
  pinUsageCountResetAt: timestamp("pin_usage_count_reset_at"),
  // Profile photo fields (captured during face enrollment)
  profilePhotoPath: text("profile_photo_path"),
  profilePhotoCapturedAt: timestamp("profile_photo_captured_at"),
  profilePhotoSource: text("profile_photo_source", { enum: ["FACE_ENROLLMENT", "MANUAL_UPLOAD"] }),
  profilePhotoUpdatedBy: varchar("profile_photo_updated_by").references(() => users.id),
  // Org structure for scheduling
  primaryDepartmentId: varchar("primary_department_id"),
  // Display order for sorting in scheduling views
  displayOrder: integer("display_order").notNull().default(0),
  // Weekly fixed days off for scheduling (0=Sunday, 1=Monday, ..., 6=Saturday)
  weeklyOffDays: integer("weekly_off_days").array().default([]),
  // Link to user account for system access (nullable until login is created)
  userId: varchar("user_id").references(() => users.id),
  // Version control for optimistic concurrency
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
}, (table) => [
  index("idx_employees_tenant").on(table.tenantId),
  index("idx_employees_user").on(table.userId),
  index("idx_employees_phone_e164").on(table.phoneE164),
]);

export const employeesRelations = relations(employees, ({ one, many }) => ({
  person: one(people, {
    fields: [employees.personId],
    references: [people.id],
  }),
  branch: one(branches, {
    fields: [employees.branchId],
    references: [branches.id],
  }),
  department: one(departments, {
    fields: [employees.primaryDepartmentId],
    references: [departments.id],
  }),
  employeeRoles: many(employeeRoles),
  user: one(users, {
    fields: [employees.userId],
    references: [users.id],
  }),
}));

export const insertEmployeeSchema = createInsertSchema(employees).omit({
  id: true,
  createdAt: true,
  version: true,
  updatedAt: true,
});

export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employees.$inferSelect;

export type AccessSummary = {
  accessLevel: "STAFF" | "MANAGER" | "ADMIN";
  modules: { core: boolean; hr: boolean; studio: boolean; events: boolean; ops: boolean; setup: boolean };
  branchScope: "ALL" | "SELECTED";
  coreAccountEnabled: boolean;
  coreUserId: string | null;
};

export type EmployeeWithAccess = Employee & {
  accessSummary?: AccessSummary | null;
  hasSignedContract?: boolean;
};

// ============================================
// STAFF COST ALLOCATIONS
// ============================================

export const staffCostAllocations = pgTable("staff_cost_allocations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id, { onDelete: "cascade" }).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  allocationPercent: real("allocation_percent").notNull(), // decimal 0-100, e.g., 70.00
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_staff_cost_allocations_tenant").on(table.tenantId),
  index("idx_staff_cost_allocations_employee").on(table.employeeId),
  index("idx_staff_cost_allocations_branch").on(table.branchId),
]);

export const staffCostAllocationsRelations = relations(staffCostAllocations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [staffCostAllocations.tenantId],
    references: [tenants.id],
  }),
  employee: one(employees, {
    fields: [staffCostAllocations.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [staffCostAllocations.branchId],
    references: [branches.id],
  }),
}));

export const insertStaffCostAllocationSchema = createInsertSchema(staffCostAllocations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertStaffCostAllocation = z.infer<typeof insertStaffCostAllocationSchema>;
export type StaffCostAllocation = typeof staffCostAllocations.$inferSelect;

// ============================================
// CASUAL WORKERS (Lightweight Scheduling-Only)
// ============================================

export const casualWorkerStatuses = ["active", "inactive", "expired"] as const;
export type CasualWorkerStatus = typeof casualWorkerStatuses[number];

export const casualWorkers = pgTable("casual_workers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  fullName: text("full_name").notNull(),
  nickname: text("nickname").notNull(),
  jobTitle: text("job_title"),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  departmentId: varchar("department_id").references(() => departments.id).notNull(),
  roleId: varchar("role_id").references(() => roles.id).notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  dailyRate: integer("daily_rate").notNull(),
  rateType: text("rate_type").notNull().default("daily"),
  status: text("status", { enum: casualWorkerStatuses }).notNull().default("active"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_casual_workers_tenant").on(table.tenantId),
  index("idx_casual_workers_branch").on(table.branchId),
  index("idx_casual_workers_status").on(table.status),
  index("idx_casual_workers_dates").on(table.startDate, table.endDate),
]);

export const casualWorkersRelations = relations(casualWorkers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [casualWorkers.tenantId],
    references: [tenants.id],
  }),
  branch: one(branches, {
    fields: [casualWorkers.branchId],
    references: [branches.id],
  }),
  department: one(departments, {
    fields: [casualWorkers.departmentId],
    references: [departments.id],
  }),
  role: one(roles, {
    fields: [casualWorkers.roleId],
    references: [roles.id],
  }),
  createdByUser: one(users, {
    fields: [casualWorkers.createdBy],
    references: [users.id],
  }),
}));

export const insertCasualWorkerSchema = createInsertSchema(casualWorkers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCasualWorker = z.infer<typeof insertCasualWorkerSchema>;
export type CasualWorker = typeof casualWorkers.$inferSelect;

export type CasualWorkerWithRelations = CasualWorker & {
  branch?: { id: string; name: string } | null;
  department?: { id: string; name: string } | null;
  role?: { id: string; name: string } | null;
};

// Employee change types for tracking term updates
export const employeeChangeTypes = [
  "salary_adjustment",
  "title_change",
  "incentive_change",
  "branch_transfer",
  "resigned",
  "terminated",
  "other",
] as const;
export type EmployeeChangeType = typeof employeeChangeTypes[number];

// Employee changes table for tracking employment term history
export const employeeChanges = pgTable("employee_changes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  changeType: text("change_type", { enum: employeeChangeTypes }).notNull(),
  effectiveDate: timestamp("effective_date").notNull(),
  // Old values (before change)
  oldTitle: text("old_title"),
  oldSalary: integer("old_salary"),
  oldIncentiveClause: text("old_incentive_clause"),
  oldBranchId: varchar("old_branch_id").references(() => branches.id),
  oldDepartmentId: varchar("old_department_id").references(() => departments.id),
  // New values (after change)
  newTitle: text("new_title"),
  newSalary: integer("new_salary"),
  newIncentiveClause: text("new_incentive_clause"),
  newBranchId: varchar("new_branch_id").references(() => branches.id),
  newDepartmentId: varchar("new_department_id").references(() => departments.id),
  // Metadata
  note: text("note"),
  contractGenerated: boolean("contract_generated").default(false),
  contractInstanceId: varchar("contract_instance_id").references(() => contractInstances.id),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const employeeChangesRelations = relations(employeeChanges, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeChanges.employeeId],
    references: [employees.id],
  }),
  oldBranch: one(branches, {
    fields: [employeeChanges.oldBranchId],
    references: [branches.id],
    relationName: "oldBranch",
  }),
  newBranch: one(branches, {
    fields: [employeeChanges.newBranchId],
    references: [branches.id],
    relationName: "newBranch",
  }),
  oldDepartment: one(departments, {
    fields: [employeeChanges.oldDepartmentId],
    references: [departments.id],
    relationName: "oldDepartment",
  }),
  newDepartment: one(departments, {
    fields: [employeeChanges.newDepartmentId],
    references: [departments.id],
    relationName: "newDepartment",
  }),
  createdByUser: one(users, {
    fields: [employeeChanges.createdBy],
    references: [users.id],
  }),
}));

export const insertEmployeeChangeSchema = createInsertSchema(employeeChanges).omit({
  id: true,
  createdAt: true,
});

export type InsertEmployeeChange = z.infer<typeof insertEmployeeChangeSchema>;
export type EmployeeChange = typeof employeeChanges.$inferSelect;

// Policy document statuses
export const policyStatuses = ["draft", "published", "archived"] as const;
export type PolicyStatus = typeof policyStatuses[number];

// Policy documents table (Rules & Regulations)
export const policyDocuments = pgTable("policy_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  contentHtml: text("content_html"),
  pdfFileUrl: text("pdf_file_url"),
  versionInt: integer("version_int").notNull().default(1),
  status: text("status", { enum: policyStatuses }).notNull().default("draft"),
  publishedAt: timestamp("published_at"),
  contentHash: text("content_hash"),
  isCompanyWide: boolean("is_company_wide").notNull().default(true),
  branchId: varchar("branch_id").references(() => branches.id),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const policyDocumentsRelations = relations(policyDocuments, ({ one }) => ({
  branch: one(branches, {
    fields: [policyDocuments.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [policyDocuments.createdBy],
    references: [users.id],
  }),
  updatedByUser: one(users, {
    fields: [policyDocuments.updatedBy],
    references: [users.id],
  }),
}));

export const insertPolicyDocumentSchema = createInsertSchema(policyDocuments).omit({
  id: true,
  versionInt: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPolicyDocument = z.infer<typeof insertPolicyDocumentSchema>;
export type PolicyDocument = typeof policyDocuments.$inferSelect;

// Contract status - includes Active and Superseded for lifecycle management
export const contractStatuses = ["draft", "finalized", "sent", "failed", "active", "superseded", "terminated"] as const;
export type ContractStatus = typeof contractStatuses[number];

// Signing status
export const signingStatuses = ["not_sent", "awaiting_signature", "signed", "expired"] as const;
export type SigningStatus = typeof signingStatuses[number];

// Contract instances table
export const contractInstances = pgTable("contract_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  templateId: varchar("template_id").references(() => templates.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  templateSnapshotHtml: text("template_snapshot_html").notNull(),
  templateSnapshotVersion: integer("template_snapshot_version").notNull(),
  mergeDataJson: jsonb("merge_data_json").$type<MergeData>().notNull(),
  status: text("status", { enum: contractStatuses }).notNull().default("draft"),
  finalizedAt: timestamp("finalized_at"),
  pdfPath: text("pdf_path"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  sentToEmail: text("sent_to_email"),
  sentAt: timestamp("sent_at"),
  emailMessageId: text("email_message_id"),
  // Signing fields
  signingStatus: text("signing_status", { enum: signingStatuses }).notNull().default("not_sent"),
  signingToken: text("signing_token"),
  signingTokenExpiresAt: timestamp("signing_token_expires_at"),
  signedAt: timestamp("signed_at"),
  signatureName: text("signature_name"),
  signatureIp: text("signature_ip"),
  signedPdfPath: text("signed_pdf_path"),
  driveFileId: text("drive_file_id"),
  // Employee signature snapshot
  employeeSignatureImage: text("employee_signature_image"),
  employeeSignedName: text("employee_signed_name"),
  employeeSignedDate: text("employee_signed_date"),
  // Employer (MD) signature snapshot
  employerSignatureImage: text("employer_signature_image"),
  employerSignedName: text("employer_signed_name"),
  employerSignedTitle: text("employer_signed_title"),
  employerSignedDate: text("employer_signed_date"),
  // Policy acknowledgment fields (audit-proof)
  policyDocumentId: varchar("policy_document_id").references(() => policyDocuments.id),
  policyVersionInt: integer("policy_version_int"),
  policyContentHash: text("policy_content_hash"),
  policyTitleSnapshot: text("policy_title_snapshot"),
  policyPublishedAtSnapshot: timestamp("policy_published_at_snapshot"),
  policyAcknowledged: boolean("policy_acknowledged").default(false),
  policyAcknowledgedAt: timestamp("policy_acknowledged_at"),
  // Archive field for signed contracts
  archivedAt: timestamp("archived_at"),
  // Employee data snapshot at time of contract creation (for audit trail)
  employeeSnapshotJson: jsonb("employee_snapshot_json").$type<{
    fullName: string;
    thaiName?: string | null;
    nickname: string;
    email: string;
    phone?: string | null;
    address?: string | null;
    nationality?: string | null;
    isForeignStaff?: boolean;
    branchId?: string | null;
    branchName?: string | null;
    positionTitle?: string;
    salaryThb?: number;
    startDate?: string;
    employmentBasis?: string;
    dailyRate?: number | null;
    version: number;
    snapshotAt: string;
  }>(),
});

export const contractInstancesRelations = relations(contractInstances, ({ one }) => ({
  employee: one(employees, {
    fields: [contractInstances.employeeId],
    references: [employees.id],
  }),
  template: one(templates, {
    fields: [contractInstances.templateId],
    references: [templates.id],
  }),
  branch: one(branches, {
    fields: [contractInstances.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [contractInstances.createdBy],
    references: [users.id],
  }),
  policyDocument: one(policyDocuments, {
    fields: [contractInstances.policyDocumentId],
    references: [policyDocuments.id],
  }),
}));

export const insertContractInstanceSchema = createInsertSchema(contractInstances).omit({
  id: true,
  createdAt: true,
  finalizedAt: true,
  sentAt: true,
  emailMessageId: true,
  signingStatus: true,
  signingToken: true,
  signingTokenExpiresAt: true,
  signedAt: true,
  signatureName: true,
  signatureIp: true,
  signedPdfPath: true,
  driveFileId: true,
  employeeSignatureImage: true,
  employeeSignedName: true,
  employeeSignedDate: true,
  employerSignatureImage: true,
  employerSignedName: true,
  employerSignedTitle: true,
  employerSignedDate: true,
  policyDocumentId: true,
  policyVersionInt: true,
  policyContentHash: true,
  policyTitleSnapshot: true,
  policyPublishedAtSnapshot: true,
  policyAcknowledged: true,
  policyAcknowledgedAt: true,
  archivedAt: true,
});

export type InsertContractInstance = z.infer<typeof insertContractInstanceSchema>;
export type ContractInstance = typeof contractInstances.$inferSelect;

// Settings table for email templates and configuration
// A setting belongs to a park group (S2-17b round 4a, migration 0006): the
// row's `tenant_id`, backfilled to the default park group, which held every
// setting before. Each park group reads its own row for a key and, where it has
// none, the default park group's — what every park group read while there was
// one global set (server/lib/parkGroupSettings.ts).
//
// TWO UNIQUES FOR ONE RELEASE. `settings_key_unique` (the `.unique()` below)
// still stands beside the new (tenant_id, key) index, so the release before
// this one keeps working against the migrated table. While it stands, a key
// can be held by one park group only, so only the default park group saves
// settings; the contraction (round 4b, a release later) drops it and opens
// saving to every park group. `tenant_id` is nullable until then: a row the
// previous release writes during the hand-over has none, and reads as the
// default park group's.
export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  tenantId: uuid("tenant_id").references(() => tenants.id),
}, (table) => [
  // Also the tenant_id index: it leads with it.
  uniqueIndex("settings_tenant_id_key_unique").on(table.tenantId, table.key),
]);

export const insertSettingSchema = createInsertSchema(settings).omit({
  id: true,
  updatedAt: true,
});

export type InsertSetting = z.infer<typeof insertSettingSchema>;
export type Setting = typeof settings.$inferSelect;

// Activity types for the activity log
export const activityTypes = [
  "promotion",
  "salary_change",
  "incentive_change",
  "employment_ended",
  "contract_created",
  "contract_finalized",
  "contract_sent",
  "contract_resent",
  "signing_link_created",
  "contract_signed",
  "employee_created",
  "employee_updated",
  "branch_transfer",
  "contract_activated",
  "contract_superseded",
  "probation_completed",
  "policy_created",
  "policy_published",
  "policy_archived",
  "policy_attached",
  "policy_acknowledged",
  "contract_archived",
  "USER_CREATED",
  "USER_DISABLED",
  "USER_ENABLED",
  "USER_PASSWORD_RESET_BY_ADMIN",
  "USER_PASSWORD_CHANGED",
  "attention_item_created",
  "attention_item_resolved",
  "template_created",
  "template_updated",
  "template_assigned",
  "template_forked",
  "document_uploaded",
  "terms_changed",
  "offboarding_started",
  "offboarding_letter_created",
  "offboarding_letter_signed",
  "offboarding_completed",
  "warning_issued",
  "warning_letter_created",
  "warning_letter_signed",
  "employment_state_changed",
  "asset_assigned",
  "asset_returned",
  "asset_updated",
  "user_permissions_updated",
  "face_enrolled",
  "face_enrollment_reset",
  "face_duplicate_detected",
  "enrollment_session_created",
  "profile_photo_set",
  "camp_attendance_days_updated",
] as const;
export type ActivityType = typeof activityTypes[number];

// Activity log table for dashboard feed
// `tenant_id` (S2-17b round 4a, migration 0006): the park group a row belongs
// to, so a row with no branch — a user created, a policy published, a camp
// edited — shows in its own park group's Activity Logbook rather than in none.
// Backfilled from the branch, then the employee, then the contract's employee,
// then the user who did it, then the default park group; written on the same
// order by `createActivityLog`. Nullable until the contraction (round 4b): a
// row the previous release writes during the hand-over has none, and is shown
// by its branch as before.
export const activityLog = pgTable("activity_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  branchId: varchar("branch_id").references(() => branches.id),
  employeeId: varchar("employee_id").references(() => employees.id),
  contractInstanceId: varchar("contract_instance_id").references(() => contractInstances.id),
  attentionItemId: varchar("attention_item_id"),
  templateId: varchar("template_id"),
  activityType: text("activity_type", { enum: activityTypes }).notNull(),
  summaryText: text("summary_text").notNull(),
  metadataJson: text("metadata_json"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  tenantId: uuid("tenant_id").references(() => tenants.id),
}, (table) => [
  index("idx_activity_log_tenant").on(table.tenantId),
]);

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  branch: one(branches, {
    fields: [activityLog.branchId],
    references: [branches.id],
  }),
  employee: one(employees, {
    fields: [activityLog.employeeId],
    references: [employees.id],
  }),
  contractInstance: one(contractInstances, {
    fields: [activityLog.contractInstanceId],
    references: [contractInstances.id],
  }),
  createdByUser: one(users, {
    fields: [activityLog.createdBy],
    references: [users.id],
  }),
}));

export const insertActivityLogSchema = createInsertSchema(activityLog).omit({
  id: true,
  createdAt: true,
});

export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLog.$inferSelect;

// Attention item types for the rule engine
export const attentionTypes = [
  "CONTRACT_NOT_SENT",
  "CONTRACT_NOT_SIGNED",
  "CHANGE_NO_CONTRACT",
  "UNSIGNED_EMPLOYMENT_CONTRACT",
  "TERMS_CHANGED_REQUIRES_NEW_CONTRACT",
  "PROBATION_REVIEW_DUE_SOON",
  "PROBATION_REVIEW_OVERDUE",
  "MISSING_OFFBOARD_DOC",
  "OFFBOARDING_DATES_INCOMPLETE",
  "OFFBOARDING_LETTER_UNSIGNED",
  "VISA_EXPIRING",
  "WORK_PERMIT_EXPIRING",
  "MISSING_VISA_WP_POLICY",
  "EMPLOYEE_UNSIGNED",
  "COMPANY_PROPERTY_NOT_RETURNED",
  "FACE_ENROLLMENT_REQUIRED",
  "FREQUENT_PIN_USAGE",
  "TIMEKEEPING_ANOMALY_REQUIRES_ACTION",
  "TIMEKEEPING_STUCK_CLOCK_IN",
  "SCHEDULED_NO_SHOW_ALERT",
  "EMPLOYEE_MISSING_DEPARTMENT",
  "EMPLOYEE_MISSING_ROLE",
  "OPEN_SHIFT_SOON",
  "SHIFT_NEEDS_COVERAGE",
  "MISSING_LOGIN_ACCESS",
  "CHECKLIST_AUDIT_FAIL",
  "CHECKLIST_NOTE_FLAGGED",
  "DUPLICATE_FACE_ENROLLMENT",
] as const;
export type AttentionType = typeof attentionTypes[number];

export const severityLevels = ["low", "medium", "high"] as const;
export type SeverityLevel = typeof severityLevels[number];

// Attention item status
export const attentionStatuses = ["open", "resolved"] as const;
export type AttentionStatus = typeof attentionStatuses[number];

// Attention items table for rule-based alerts
export const attentionItems = pgTable("attention_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  branchId: varchar("branch_id").references(() => branches.id),
  employeeId: varchar("employee_id").references(() => employees.id),
  contractInstanceId: varchar("contract_instance_id").references(() => contractInstances.id),
  type: text("type", { enum: attentionTypes }).notNull(),
  severity: text("severity", { enum: severityLevels }).notNull().default("medium"),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: timestamp("due_date"),
  status: text("status", { enum: attentionStatuses }).notNull().default("open"),
  ruleKey: text("rule_key").notNull().default(""),
  entityKey: text("entity_key").notNull().default(""),
  fingerprint: text("fingerprint"),
  suppressUntil: timestamp("suppress_until"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by").references(() => users.id),
  // S2-17b round 4a, migration 0006: the park group an item belongs to,
  // backfilled from the branch, then the employee, then the contract's
  // employee, then the default park group. Attention stays paused
  // (ATTENTION_WRITES_READY) until round 4b writes it and reads by it.
  tenantId: uuid("tenant_id").references(() => tenants.id),
}, (table) => [
  index("idx_attention_items_tenant").on(table.tenantId),
]);

export const attentionItemsRelations = relations(attentionItems, ({ one }) => ({
  branch: one(branches, {
    fields: [attentionItems.branchId],
    references: [branches.id],
  }),
  employee: one(employees, {
    fields: [attentionItems.employeeId],
    references: [employees.id],
  }),
  contractInstance: one(contractInstances, {
    fields: [attentionItems.contractInstanceId],
    references: [contractInstances.id],
  }),
  resolvedByUser: one(users, {
    fields: [attentionItems.resolvedBy],
    references: [users.id],
  }),
}));

export const insertAttentionItemSchema = createInsertSchema(attentionItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  resolvedBy: true,
});

export type InsertAttentionItem = z.infer<typeof insertAttentionItemSchema>;
export type AttentionItem = typeof attentionItems.$inferSelect;

// Document types for employee documents
export const documentTypes = [
  "id_card", 
  "passport", 
  "resignation_form", 
  "termination_letter", 
  "warning_letter", 
  "other"
] as const;
export type DocumentType = typeof documentTypes[number];

// Helper to check if document type is offboarding-related
export const offboardingDocumentTypes = ["resignation_form", "termination_letter"] as const;
export type OffboardingDocumentType = typeof offboardingDocumentTypes[number];

// Employee documents table for ID cards, passports, and offboarding documents
export const employeeDocuments = pgTable("employee_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  documentType: text("document_type", { enum: documentTypes }).notNull(),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
  note: text("note"),
  uploadedBy: varchar("uploaded_by").references(() => users.id),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});

export const employeeDocumentsRelations = relations(employeeDocuments, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeDocuments.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [employeeDocuments.branchId],
    references: [branches.id],
  }),
  uploader: one(users, {
    fields: [employeeDocuments.uploadedBy],
    references: [users.id],
  }),
}));

export const insertEmployeeDocumentSchema = createInsertSchema(employeeDocuments).omit({
  id: true,
  uploadedAt: true,
});

export type InsertEmployeeDocument = z.infer<typeof insertEmployeeDocumentSchema>;
export type EmployeeDocument = typeof employeeDocuments.$inferSelect;

// Common offboarding reasons
export const offboardingReasons = [
  "personal_reasons",
  "better_opportunity",
  "relocation",
  "health_issues",
  "family_reasons",
  "career_change",
  "retirement",
  "performance",
  "misconduct",
  "redundancy",
  "contract_end",
  "mutual_agreement",
  "other",
] as const;
export type OffboardingReason = typeof offboardingReasons[number];

// Employee offboarding table for tracking offboarding details
export const employeeOffboarding = pgTable("employee_offboarding", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  offboardingType: text("offboarding_type", { enum: offboardingTypes }).notNull(),
  reasonCode: text("reason_code", { enum: offboardingReasons }).notNull(),
  reasonText: text("reason_text"),
  noticeDate: timestamp("notice_date"),
  lastWorkingDay: timestamp("last_working_day").notNull(),
  leavePublicHolidaysDays: integer("leave_public_holidays_days"),
  leaveAnnualDays: integer("leave_annual_days"),
  leaveOtherDays: integer("leave_other_days"),
  leaveOtherLabel: text("leave_other_label"),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const employeeOffboardingRelations = relations(employeeOffboarding, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeOffboarding.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [employeeOffboarding.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [employeeOffboarding.createdBy],
    references: [users.id],
  }),
}));

export const insertEmployeeOffboardingSchema = createInsertSchema(employeeOffboarding).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEmployeeOffboarding = z.infer<typeof insertEmployeeOffboardingSchema>;
export type EmployeeOffboarding = typeof employeeOffboarding.$inferSelect;

// Letter types for employee letters (offboarding + disciplinary)
export const letterTypes = ["resignation", "termination", "warning"] as const;
export type LetterType = typeof letterTypes[number];

// Letter statuses
export const letterStatuses = ["draft", "finalized", "signing_link_created", "signed"] as const;
export type LetterStatus = typeof letterStatuses[number];

// Employee letters table for resignation/termination letters
export const employeeLetters = pgTable("employee_letters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  offboardingId: varchar("offboarding_id").references(() => employeeOffboarding.id),
  letterType: text("letter_type", { enum: letterTypes }).notNull(),
  templateId: varchar("template_id").references(() => templates.id),
  status: text("status", { enum: letterStatuses }).notNull().default("draft"),
  finalizedAt: timestamp("finalized_at"),
  signingToken: text("signing_token"),
  signingLinkCreatedAt: timestamp("signing_link_created_at"),
  signedAt: timestamp("signed_at"),
  signatureImageUrl: text("signature_image_url"),
  employeeSignedName: text("employee_signed_name"),
  employeeSignedDate: text("employee_signed_date"),
  renderedHtmlSnapshot: text("rendered_html_snapshot"),
  renderedPdfUrl: text("rendered_pdf_url"),
  signedPdfPath: text("signed_pdf_path"),
  metadataJson: jsonb("metadata_json"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const employeeLettersRelations = relations(employeeLetters, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeLetters.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [employeeLetters.branchId],
    references: [branches.id],
  }),
  offboarding: one(employeeOffboarding, {
    fields: [employeeLetters.offboardingId],
    references: [employeeOffboarding.id],
  }),
  template: one(templates, {
    fields: [employeeLetters.templateId],
    references: [templates.id],
  }),
  createdByUser: one(users, {
    fields: [employeeLetters.createdBy],
    references: [users.id],
  }),
}));

export const insertEmployeeLetterSchema = createInsertSchema(employeeLetters).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  finalizedAt: true,
  signingToken: true,
  signingLinkCreatedAt: true,
  signedAt: true,
  signatureImageUrl: true,
  employeeSignedName: true,
  employeeSignedDate: true,
  renderedPdfUrl: true,
  signedPdfPath: true,
});

export type InsertEmployeeLetter = z.infer<typeof insertEmployeeLetterSchema>;
export type EmployeeLetter = typeof employeeLetters.$inferSelect;

// Asset categories for company property
export const assetCategories = [
  "equipment",
  "uniform",
  "access",
  "technology",
  "vehicle",
  "other",
] as const;
export type AssetCategory = typeof assetCategories[number];

// Asset catalog table for standard company property items
export const assetCatalog = pgTable("asset_catalog", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  category: text("category", { enum: assetCategories }),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAssetCatalogSchema = createInsertSchema(assetCatalog).omit({
  id: true,
  createdAt: true,
});

export type InsertAssetCatalog = z.infer<typeof insertAssetCatalogSchema>;
export type AssetCatalog = typeof assetCatalog.$inferSelect;

// Employee assets table for tracking assigned company property
export const employeeAssets = pgTable("employee_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  assetNameSnapshot: text("asset_name_snapshot").notNull(),
  catalogAssetId: varchar("catalog_asset_id").references(() => assetCatalog.id),
  quantity: integer("quantity").default(1).notNull(),
  serialNumber: text("serial_number"),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: varchar("assigned_by").references(() => users.id).notNull(),
  returnRequired: boolean("return_required").default(true).notNull(),
  expectedReturnBy: timestamp("expected_return_by"),
  returnedAt: timestamp("returned_at"),
  returnedBy: varchar("returned_by").references(() => users.id),
  returnNotes: text("return_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const employeeAssetsRelations = relations(employeeAssets, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeAssets.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [employeeAssets.branchId],
    references: [branches.id],
  }),
  catalogAsset: one(assetCatalog, {
    fields: [employeeAssets.catalogAssetId],
    references: [assetCatalog.id],
  }),
  assignedByUser: one(users, {
    fields: [employeeAssets.assignedBy],
    references: [users.id],
  }),
  returnedByUser: one(users, {
    fields: [employeeAssets.returnedBy],
    references: [users.id],
  }),
}));

export const insertEmployeeAssetSchema = createInsertSchema(employeeAssets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  returnedAt: true,
  returnedBy: true,
  returnNotes: true,
});

export type InsertEmployeeAsset = z.infer<typeof insertEmployeeAssetSchema>;
export type EmployeeAsset = typeof employeeAssets.$inferSelect;

// Offboarding checklist item types
export const offboardingChecklistTypes = [
  "collect_company_assets",
  "resignation_letter",
  "termination_letter",
  "conduct_exit_interview",
  "final_payroll_calculation",
  "remove_system_access",
  "handover_documentation",
  "return_keys_badges",
  "custom",
] as const;
export type OffboardingChecklistType = typeof offboardingChecklistTypes[number];

// Offboarding checklist table
export const offboardingChecklist = pgTable("offboarding_checklist", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  offboardingId: varchar("offboarding_id").references(() => employeeOffboarding.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  checklistType: text("checklist_type", { enum: offboardingChecklistTypes }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  isCompleted: boolean("is_completed").default(false).notNull(),
  completedAt: timestamp("completed_at"),
  completedBy: varchar("completed_by").references(() => users.id),
  dueDate: timestamp("due_date"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const offboardingChecklistRelations = relations(offboardingChecklist, ({ one }) => ({
  offboarding: one(employeeOffboarding, {
    fields: [offboardingChecklist.offboardingId],
    references: [employeeOffboarding.id],
  }),
  employee: one(employees, {
    fields: [offboardingChecklist.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [offboardingChecklist.branchId],
    references: [branches.id],
  }),
  completedByUser: one(users, {
    fields: [offboardingChecklist.completedBy],
    references: [users.id],
  }),
}));

export const insertOffboardingChecklistSchema = createInsertSchema(offboardingChecklist).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  completedBy: true,
});

export type InsertOffboardingChecklist = z.infer<typeof insertOffboardingChecklistSchema>;
export type OffboardingChecklist = typeof offboardingChecklist.$inferSelect;

// ==========================================
// TIMEKEEPING / KIOSK SYSTEM
// ==========================================

// Kiosk devices table (supports both face-recognition kiosks and reception kiosks)
export const kioskDevices = pgTable("kiosk_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  name: text("name"),
  deviceSecretHash: text("device_secret_hash"), // hashed device secret (for face-recognition kiosks)
  kioskType: text("kiosk_type", { enum: ["face_recognition", "reception"] }).default("face_recognition"),
  isActive: boolean("is_active").default(true).notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  lastIp: text("last_ip"),
  lastUserAgent: text("last_user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_kiosk_devices_branch").on(table.branchId),
  index("idx_kiosk_devices_tenant").on(table.tenantId),
]);

export const kioskDevicesRelations = relations(kioskDevices, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [kioskDevices.tenantId],
    references: [tenants.id],
  }),
  branch: one(branches, {
    fields: [kioskDevices.branchId],
    references: [branches.id],
  }),
  sessions: many(kioskSessions),
}));

export const insertKioskDeviceSchema = createInsertSchema(kioskDevices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSeenAt: true,
});

export type InsertKioskDevice = z.infer<typeof insertKioskDeviceSchema>;
export type KioskDevice = typeof kioskDevices.$inferSelect;

// Kiosk types enum
export const kioskTypes = ["face_recognition", "reception"] as const;
export type KioskType = typeof kioskTypes[number];

// Kiosk sessions - session-based auth for reception kiosks (~30 day lifetime)
export const kioskSessions = pgTable("kiosk_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  kioskDeviceId: varchar("kiosk_device_id").references(() => kioskDevices.id).notNull(),
  sessionTokenHash: text("session_token_hash").notNull(), // SHA-256(token + pepper)
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, (table) => [
  index("idx_kiosk_sessions_device").on(table.kioskDeviceId),
  index("idx_kiosk_sessions_token").on(table.sessionTokenHash),
]);

export const kioskSessionsRelations = relations(kioskSessions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [kioskSessions.tenantId],
    references: [tenants.id],
  }),
  device: one(kioskDevices, {
    fields: [kioskSessions.kioskDeviceId],
    references: [kioskDevices.id],
  }),
}));

export const insertKioskSessionSchema = createInsertSchema(kioskSessions).omit({
  id: true,
  createdAt: true,
});

export type InsertKioskSession = z.infer<typeof insertKioskSessionSchema>;
export type KioskSession = typeof kioskSessions.$inferSelect;

// Kiosk permissions constants
export const kioskPermissions = [
  "core.checkin.read",
  "core.checkin.update",
  "core.guest.read_minimal",
] as const;
export type KioskPermission = typeof kioskPermissions[number];

// Enrollment session tokens (QR-based enrollment)
export const enrollmentSessions = pgTable("enrollment_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  tokenHash: text("token_hash").notNull(), // hashed token for verification
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"), // null if not yet used
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const enrollmentSessionsRelations = relations(enrollmentSessions, ({ one }) => ({
  employee: one(employees, {
    fields: [enrollmentSessions.employeeId],
    references: [employees.id],
  }),
  createdByUser: one(users, {
    fields: [enrollmentSessions.createdBy],
    references: [users.id],
  }),
}));

export const insertEnrollmentSessionSchema = createInsertSchema(enrollmentSessions).omit({
  id: true,
  createdAt: true,
  usedAt: true,
});

export type InsertEnrollmentSession = z.infer<typeof insertEnrollmentSessionSchema>;
export type EnrollmentSession = typeof enrollmentSessions.$inferSelect;

// Advisor enrollment is deliberately separate from employee enrollment: advisors are
// people/access-policy identities and must never acquire an employee record to clock time.
export const advisorEnrollmentSessions = pgTable("advisor_enrollment_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: varchar("person_id").references(() => people.id, { onDelete: "cascade" }).notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_advisor_enrollment_token").on(table.tokenHash),
  index("idx_advisor_enrollment_person").on(table.personId),
]);

// Time event types
export const timeEventTypes = ["IN", "OUT"] as const;
export type TimeEventType = typeof timeEventTypes[number];

// Time event auth methods
export const authMethods = ["FACE", "PIN", "PHONE_FALLBACK", "ADMIN_OVERRIDE"] as const;
export type AuthMethod = typeof authMethods[number];

// Force-close reason codes for admin overrides
export const forceCloseReasonCodes = ["NORMAL", "FAMILY_EMERGENCY", "MEDICAL", "OFF_SITE_EVENT", "EQUIPMENT_FAILURE", "EARLY_RELEASE", "OTHER"] as const;
export type ForceCloseReasonCode = typeof forceCloseReasonCodes[number];

// Time events table (clock in/out records)
export const timeEvents = pgTable("time_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(), // kiosk branch where clocked
  eventType: text("event_type", { enum: timeEventTypes }).notNull(),
  eventTime: timestamp("event_time").notNull(),
  authMethod: text("auth_method", { enum: authMethods }).notNull().default("FACE"),
  confidenceScore: integer("confidence_score"), // face match confidence (0-100)
  livenessScore: integer("liveness_score"), // liveness check score (0-100)
  photoEvidenceUrl: text("photo_evidence_url"), // for PIN fallback events
  kioskDeviceId: varchar("kiosk_device_id").references(() => kioskDevices.id),
  notes: text("notes"), // for admin overrides
  reasonCode: text("reason_code"), // optional reason code for admin overrides
  reasonNotes: text("reason_notes"), // optional free-text explanation
  createdBy: varchar("created_by").references(() => users.id), // null for self-service, user for admin overrides
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("idx_time_events_tenant").on(table.tenantId),
  employeeTimeIdx: index("idx_time_events_employee_time").on(table.employeeId, table.eventTime),
  branchTimeIdx: index("idx_time_events_branch_time").on(table.branchId, table.eventTime),
  eventTimeIdx: index("idx_time_events_event_time").on(table.eventTime),
}));

export const timeEventsRelations = relations(timeEvents, ({ one }) => ({
  employee: one(employees, {
    fields: [timeEvents.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [timeEvents.branchId],
    references: [branches.id],
  }),
  kioskDevice: one(kioskDevices, {
    fields: [timeEvents.kioskDeviceId],
    references: [kioskDevices.id],
  }),
  createdByUser: one(users, {
    fields: [timeEvents.createdBy],
    references: [users.id],
  }),
}));

export const insertTimeEventSchema = createInsertSchema(timeEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertTimeEvent = z.infer<typeof insertTimeEventSchema>;
export type TimeEvent = typeof timeEvents.$inferSelect;

// ============================================
// TIME ENTRIES (Paired clock-in/out records for shift management)
// ============================================

export const timeEntryStatuses = ["RAW", "AUTO_FIXED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "LOCKED"] as const;
export type TimeEntryStatus = typeof timeEntryStatuses[number];

export const timeEntrySources = ["FACE_KIOSK", "PIN_KIOSK", "SYSTEM", "MANUAL"] as const;
export type TimeEntrySource = typeof timeEntrySources[number];

export const timeEntries = pgTable("time_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  shiftDate: varchar("shift_date").notNull(), // YYYY-MM-DD
  scheduledStartAt: timestamp("scheduled_start_at"), // from schedule
  scheduledEndAt: timestamp("scheduled_end_at"), // from schedule
  clockInAt: timestamp("clock_in_at"),
  clockOutAt: timestamp("clock_out_at"),
  status: text("status", { enum: timeEntryStatuses }).notNull().default("RAW"),
  sourceIn: text("source_in", { enum: timeEntrySources }),
  sourceOut: text("source_out", { enum: timeEntrySources }),
  createdBy: varchar("created_by").references(() => users.id), // null for system/kiosk
  approvedBy: varchar("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("idx_time_entries_tenant").on(table.tenantId),
  employeeDateIdx: index("idx_time_entries_employee_date").on(table.employeeId, table.shiftDate),
  branchDateIdx: index("idx_time_entries_branch_date").on(table.branchId, table.shiftDate),
  statusIdx: index("idx_time_entries_status").on(table.status),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  employee: one(employees, {
    fields: [timeEntries.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [timeEntries.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [timeEntries.createdBy],
    references: [users.id],
  }),
  approvedByUser: one(users, {
    fields: [timeEntries.approvedBy],
    references: [users.id],
  }),
}));

export const insertTimeEntrySchema = createInsertSchema(timeEntries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type TimeEntry = typeof timeEntries.$inferSelect;

// Schedule-free, explicit advisor attendance lifecycle. A session stays open across
// midnight and retains its check-in local date for reporting.
export const advisorAttendanceSessions = pgTable("advisor_attendance_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  personId: varchar("person_id").references(() => people.id, { onDelete: "cascade" }).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  checkInAt: timestamp("check_in_at").notNull(),
  checkOutAt: timestamp("check_out_at"),
  checkInDate: varchar("check_in_date").notNull(),
  isOvernight: boolean("is_overnight").notNull().default(false),
  durationMinutes: integer("duration_minutes"),
  authMethod: text("auth_method", { enum: authMethods }).notNull(),
  confidenceScore: integer("confidence_score"),
  livenessScore: integer("liveness_score"),
  photoEvidenceUrl: text("photo_evidence_url"),
  kioskDeviceId: varchar("kiosk_device_id").references(() => kioskDevices.id),
  voidedAt: timestamp("voided_at"),
  voidedBy: varchar("voided_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_advisor_attendance_person_open").on(table.personId, table.checkOutAt),
  index("idx_advisor_attendance_branch_date").on(table.branchId, table.checkInDate),
  index("idx_advisor_attendance_tenant").on(table.tenantId),
  uniqueIndex("advisor_attendance_one_open_session")
    .on(table.personId)
    .where(sql`${table.checkOutAt} IS NULL AND ${table.voidedAt} IS NULL`),
]);
export type AdvisorAttendanceSession = typeof advisorAttendanceSessions.$inferSelect;

export const advisorAttendanceCorrections = pgTable("advisor_attendance_corrections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  sessionId: varchar("session_id").references(() => advisorAttendanceSessions.id, { onDelete: "cascade" }).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  action: text("action", { enum: ["CREATE", "EDIT", "VOID"] }).notNull(),
  reason: text("reason").notNull(),
  beforeValues: jsonb("before_values").notNull(),
  afterValues: jsonb("after_values").notNull(),
  changedBy: varchar("changed_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_advisor_attendance_correction_session").on(table.sessionId, table.createdAt),
  index("idx_advisor_attendance_correction_tenant").on(table.tenantId),
]);
export type AdvisorAttendanceCorrection = typeof advisorAttendanceCorrections.$inferSelect;

// ============================================
// TIMEKEEPING ISSUES (Flagged issues for review)
// ============================================

export const timekeepingIssueTypes = ["MISSING_CLOCK_IN", "MISSING_CLOCK_OUT", "LATE_ARRIVAL", "EARLY_DEPARTURE", "LONG_SHIFT", "MULTIPLE_IN", "MULTIPLE_OUT", "UNSCHEDULED_WORK"] as const;
export type TimekeepingIssueType = typeof timekeepingIssueTypes[number];

export const timekeepingIssueStatuses = ["OPEN", "RESOLVED", "REJECTED"] as const;
export type TimekeepingIssueStatus = typeof timekeepingIssueStatuses[number];

export const timekeepingReasonCodes = ["FORGOT_TO_CLOCK_IN", "DEVICE_ISSUE", "MANAGER_INSTRUCTED", "LATE_ARRIVAL", "OTHER", "COVERING_ABSENT_STAFF", "EMERGENCY_TASK", "TRAINING"] as const;
export type TimekeepingReasonCode = typeof timekeepingReasonCodes[number];

export const timekeepingIssues = pgTable("timekeeping_issues", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  issueDate: varchar("issue_date").notNull(), // YYYY-MM-DD
  issueType: text("issue_type", { enum: timekeepingIssueTypes }).notNull(),
  status: text("status", { enum: timekeepingIssueStatuses }).notNull().default("OPEN"),
  linkedTimeEntryId: varchar("linked_time_entry_id").references(() => timeEntries.id),
  suggestedClockInAt: timestamp("suggested_clock_in_at"),
  suggestedClockOutAt: timestamp("suggested_clock_out_at"),
  userProposedClockInAt: timestamp("user_proposed_clock_in_at"),
  userProposedClockOutAt: timestamp("user_proposed_clock_out_at"),
  reasonCode: text("reason_code", { enum: timekeepingReasonCodes }),
  note: text("note"),
  createdBy: varchar("created_by"), // "KIOSK_SYSTEM" or userId
  resolvedBy: varchar("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("idx_timekeeping_issues_tenant").on(table.tenantId),
  employeeDateIdx: index("idx_timekeeping_issues_employee_date").on(table.employeeId, table.issueDate),
  branchDateIdx: index("idx_timekeeping_issues_branch_date").on(table.branchId, table.issueDate),
  statusIdx: index("idx_timekeeping_issues_status").on(table.status),
}));

export const timekeepingIssuesRelations = relations(timekeepingIssues, ({ one }) => ({
  employee: one(employees, {
    fields: [timekeepingIssues.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [timekeepingIssues.branchId],
    references: [branches.id],
  }),
  linkedTimeEntry: one(timeEntries, {
    fields: [timekeepingIssues.linkedTimeEntryId],
    references: [timeEntries.id],
  }),
  resolvedByUser: one(users, {
    fields: [timekeepingIssues.resolvedBy],
    references: [users.id],
  }),
}));

export const insertTimekeepingIssueSchema = createInsertSchema(timekeepingIssues).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTimekeepingIssue = z.infer<typeof insertTimekeepingIssueSchema>;
export type TimekeepingIssue = typeof timekeepingIssues.$inferSelect;

// Kiosk auth attempt outcomes
export const authAttemptOutcomes = ["SUCCESS", "FAIL"] as const;
export type AuthAttemptOutcome = typeof authAttemptOutcomes[number];

// Kiosk authentication attempts (for monitoring + 3-fail rule)
export const kioskAuthAttempts = pgTable("kiosk_auth_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id), // null until identified
  personId: varchar("person_id").references(() => people.id), // advisor identity; never fabricates an employee
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  kioskDeviceId: varchar("kiosk_device_id").references(() => kioskDevices.id),
  attemptTime: timestamp("attempt_time").defaultNow().notNull(),
  method: text("method", { enum: authMethods }).notNull(),
  outcome: text("outcome", { enum: authAttemptOutcomes }).notNull(),
  failReason: text("fail_reason"), // e.g. liveness_fail, no_match, low_confidence
  confidenceScore: integer("confidence_score"),
  livenessScore: integer("liveness_score"),
  photoEvidenceUrl: text("photo_evidence_url"), // captured photo before PIN
  sessionId: text("session_id"), // group attempts in same session
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const kioskAuthAttemptsRelations = relations(kioskAuthAttempts, ({ one }) => ({
  employee: one(employees, {
    fields: [kioskAuthAttempts.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [kioskAuthAttempts.branchId],
    references: [branches.id],
  }),
  kioskDevice: one(kioskDevices, {
    fields: [kioskAuthAttempts.kioskDeviceId],
    references: [kioskDevices.id],
  }),
}));

export const insertKioskAuthAttemptSchema = createInsertSchema(kioskAuthAttempts).omit({
  id: true,
  createdAt: true,
});

export type InsertKioskAuthAttempt = z.infer<typeof insertKioskAuthAttemptSchema>;
export type KioskAuthAttempt = typeof kioskAuthAttempts.$inferSelect;

// ============================================
// AUTH OTP EVENTS (SMS OTP audit trail for password reset)
// ============================================

export const otpEventTypes = ["request", "verify_success", "verify_fail", "password_reset"] as const;
export type OtpEventType = typeof otpEventTypes[number];

export const authOtpEvents = pgTable("auth_otp_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  phoneE164: text("phone_e164").notNull(), // phone number used
  eventType: text("event_type", { enum: otpEventTypes }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  success: boolean("success").notNull().default(false),
  failReason: text("fail_reason"), // e.g., invalid_code, expired, rate_limited
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_auth_otp_events_user").on(table.userId),
  index("idx_auth_otp_events_phone").on(table.phoneE164),
  index("idx_auth_otp_events_created").on(table.createdAt),
]);

export const authOtpEventsRelations = relations(authOtpEvents, ({ one }) => ({
  user: one(users, {
    fields: [authOtpEvents.userId],
    references: [users.id],
  }),
}));

export const insertAuthOtpEventSchema = createInsertSchema(authOtpEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertAuthOtpEvent = z.infer<typeof insertAuthOtpEventSchema>;
export type AuthOtpEvent = typeof authOtpEvents.$inferSelect;

// ============================================
// AUTH RATE LIMITS (sliding window rate limiting)
// ============================================

export const authRateLimits = pgTable("auth_rate_limits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull(), // e.g., "otp:phone:+66123456789" or "otp:ip:1.2.3.4"
  windowStart: timestamp("window_start").notNull(),
  count: integer("count").notNull().default(1),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => [
  index("idx_auth_rate_limits_key").on(table.key),
  index("idx_auth_rate_limits_expires").on(table.expiresAt),
]);

export const insertAuthRateLimitSchema = createInsertSchema(authRateLimits).omit({
  id: true,
});

export type InsertAuthRateLimit = z.infer<typeof insertAuthRateLimitSchema>;
export type AuthRateLimit = typeof authRateLimits.$inferSelect;

// ============================================
// AUTH PASSWORD RESET TOKENS (Database-backed for production safety)
// ============================================

export const authResetTokens = pgTable("auth_reset_tokens", {
  id: varchar("id").primaryKey(), // HMAC-signed token ID
  userId: varchar("user_id").references(() => users.id),
  personId: varchar("person_id").references(() => people.id),
  tokenType: text("token_type").notNull(), // "user_password_reset" or "advisor_password_reset"
  phoneE164: text("phone_e164").notNull(),
  used: boolean("used").notNull().default(false),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_auth_reset_tokens_user").on(table.userId),
  index("idx_auth_reset_tokens_person").on(table.personId),
  index("idx_auth_reset_tokens_expires").on(table.expiresAt),
]);

export const insertAuthResetTokenSchema = createInsertSchema(authResetTokens).omit({
  createdAt: true,
});

export type InsertAuthResetToken = z.infer<typeof insertAuthResetTokenSchema>;
export type AuthResetToken = typeof authResetTokens.$inferSelect;

// ============================================
// BRANCH EVENTS (Company/Branch Events for Scheduling)
// ============================================

export const branchEvents = pgTable("branch_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  isAllDay: boolean("is_all_day").notNull().default(false),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  branchIdx: index("idx_branch_events_branch").on(table.branchId),
  startTimeIdx: index("idx_branch_events_start_time").on(table.startTime),
  branchTimeIdx: index("idx_branch_events_branch_time").on(table.branchId, table.startTime),
}));

export const branchEventsRelations = relations(branchEvents, ({ one }) => ({
  branch: one(branches, {
    fields: [branchEvents.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [branchEvents.createdBy],
    references: [users.id],
  }),
}));

export const insertBranchEventSchema = createInsertSchema(branchEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBranchEvent = z.infer<typeof insertBranchEventSchema>;
export type BranchEvent = typeof branchEvents.$inferSelect;

// ============================================
// DEPARTMENTS & ROLES (Org Structure for Scheduling)
// ============================================

// Departments (company-wide, assigned to branches via departmentBranchAssignments)
export const departments = pgTable("departments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_departments_tenant").on(table.tenantId),
]);

export const departmentsRelations = relations(departments, ({ many }) => ({
  branchAssignments: many(departmentBranchAssignments),
  employees: many(employees),
  roleMappings: many(roleDepartmentMap),
}));

export const insertDepartmentSchema = createInsertSchema(departments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDepartment = z.infer<typeof insertDepartmentSchema>;
export type Department = typeof departments.$inferSelect;

// Department-Branch assignments (many-to-many)
export const departmentBranchAssignments = pgTable("department_branch_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  departmentId: varchar("department_id").references(() => departments.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: varchar("assigned_by").references(() => users.id),
});

export const departmentBranchAssignmentsRelations = relations(departmentBranchAssignments, ({ one }) => ({
  department: one(departments, {
    fields: [departmentBranchAssignments.departmentId],
    references: [departments.id],
  }),
  branch: one(branches, {
    fields: [departmentBranchAssignments.branchId],
    references: [branches.id],
  }),
  assignedByUser: one(users, {
    fields: [departmentBranchAssignments.assignedBy],
    references: [users.id],
  }),
}));

export const insertDepartmentBranchAssignmentSchema = createInsertSchema(departmentBranchAssignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertDepartmentBranchAssignment = z.infer<typeof insertDepartmentBranchAssignmentSchema>;
export type DepartmentBranchAssignment = typeof departmentBranchAssignments.$inferSelect;

// Proficiency levels for employee role assignments
export const proficiencyLevels = ["TRAINEE", "STANDARD", "EXPERT"] as const;
export type ProficiencyLevel = typeof proficiencyLevels[number];

// Roles (company-wide / global)
export const roles = pgTable("roles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_roles_tenant").on(table.tenantId),
]);

export const rolesRelations = relations(roles, ({ many }) => ({
  departmentMappings: many(roleDepartmentMap),
  employeeRoles: many(employeeRoles),
  branchAssignments: many(roleBranchAssignments),
}));

export const insertRoleSchema = createInsertSchema(roles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRole = z.infer<typeof insertRoleSchema>;
export type Role = typeof roles.$inferSelect;

// Role-Department mapping (optional organization for scheduling filters)
export const roleDepartmentMap = pgTable("role_department_map", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roleId: varchar("role_id").references(() => roles.id).notNull(),
  departmentId: varchar("department_id").references(() => departments.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const roleDepartmentMapRelations = relations(roleDepartmentMap, ({ one }) => ({
  role: one(roles, {
    fields: [roleDepartmentMap.roleId],
    references: [roles.id],
  }),
  department: one(departments, {
    fields: [roleDepartmentMap.departmentId],
    references: [departments.id],
  }),
}));

export const insertRoleDepartmentMapSchema = createInsertSchema(roleDepartmentMap).omit({
  id: true,
  createdAt: true,
});

export type InsertRoleDepartmentMap = z.infer<typeof insertRoleDepartmentMapSchema>;
export type RoleDepartmentMap = typeof roleDepartmentMap.$inferSelect;

// Role-Branch assignments (many-to-many)
export const roleBranchAssignments = pgTable("role_branch_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roleId: varchar("role_id").references(() => roles.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: varchar("assigned_by").references(() => users.id),
});

export const roleBranchAssignmentsRelations = relations(roleBranchAssignments, ({ one }) => ({
  role: one(roles, {
    fields: [roleBranchAssignments.roleId],
    references: [roles.id],
  }),
  branch: one(branches, {
    fields: [roleBranchAssignments.branchId],
    references: [branches.id],
  }),
  assignedByUser: one(users, {
    fields: [roleBranchAssignments.assignedBy],
    references: [users.id],
  }),
}));

export const insertRoleBranchAssignmentSchema = createInsertSchema(roleBranchAssignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertRoleBranchAssignment = z.infer<typeof insertRoleBranchAssignmentSchema>;
export type RoleBranchAssignment = typeof roleBranchAssignments.$inferSelect;

// Employee Roles (many-to-many: employee can have multiple roles)
export const employeeRoles = pgTable("employee_roles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  roleId: varchar("role_id").references(() => roles.id).notNull(),
  proficiencyLevel: text("proficiency_level", { enum: proficiencyLevels }),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const employeeRolesRelations = relations(employeeRoles, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeRoles.employeeId],
    references: [employees.id],
  }),
  role: one(roles, {
    fields: [employeeRoles.roleId],
    references: [roles.id],
  }),
}));

export const insertEmployeeRoleSchema = createInsertSchema(employeeRoles).omit({
  id: true,
  createdAt: true,
});

export type InsertEmployeeRole = z.infer<typeof insertEmployeeRoleSchema>;
export type EmployeeRole = typeof employeeRoles.$inferSelect;

// Extended types for UI
export type DepartmentWithBranches = Department & {
  branches?: Branch[];
  employeeCount?: number;
};

export type RoleWithDepartments = Role & {
  departments?: Department[];
  employeeCount?: number;
};

export type RoleWithBranches = Role & {
  branches?: Branch[];
  employeeCount?: number;
};

export type EmployeeWithRoles = Employee & {
  department?: Department;
  roles?: (EmployeeRole & { role: Role })[];
};

// ============================================
// SCHEDULING MODULE (V1)
// ============================================

// Shift statuses
export const shiftStatuses = ["OPEN", "ASSIGNED"] as const;
export type ShiftStatus = typeof shiftStatuses[number];

// Shifts table (branch-scoped)
export const shifts = pgTable("shifts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  departmentId: varchar("department_id").references(() => departments.id).notNull(),
  startAt: timestamp("start_at").notNull(),
  endAt: timestamp("end_at").notNull(),
  employeeId: varchar("employee_id").references(() => employees.id), // null = open shift
  status: text("status", { enum: shiftStatuses }).notNull().default("OPEN"),
  notes: text("notes"),
  needsCoverage: boolean("needs_coverage").notNull().default(false), // flagged when sick leave unassigns
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_shifts_tenant").on(table.tenantId),
  index("idx_shifts_branch_date").on(table.branchId, table.startAt),
  index("idx_shifts_employee_date").on(table.employeeId, table.startAt),
]);

export const shiftsRelations = relations(shifts, ({ one, many }) => ({
  branch: one(branches, {
    fields: [shifts.branchId],
    references: [branches.id],
  }),
  department: one(departments, {
    fields: [shifts.departmentId],
    references: [departments.id],
  }),
  employee: one(employees, {
    fields: [shifts.employeeId],
    references: [employees.id],
  }),
  createdByUser: one(users, {
    fields: [shifts.createdBy],
    references: [users.id],
  }),
  requiredRoles: many(shiftRequiredRoles),
}));

export const insertShiftSchema = createInsertSchema(shifts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShift = z.infer<typeof insertShiftSchema>;
export type Shift = typeof shifts.$inferSelect;

// Shift required roles (many-to-many)
export const shiftRequiredRoles = pgTable("shift_required_roles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  shiftId: varchar("shift_id").references(() => shifts.id, { onDelete: "cascade" }).notNull(),
  roleId: varchar("role_id").references(() => roles.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_shift_required_roles_tenant").on(table.tenantId),
]);

export const shiftRequiredRolesRelations = relations(shiftRequiredRoles, ({ one }) => ({
  shift: one(shifts, {
    fields: [shiftRequiredRoles.shiftId],
    references: [shifts.id],
  }),
  role: one(roles, {
    fields: [shiftRequiredRoles.roleId],
    references: [roles.id],
  }),
}));

export const insertShiftRequiredRoleSchema = createInsertSchema(shiftRequiredRoles).omit({
  id: true,
  createdAt: true,
});

export type InsertShiftRequiredRole = z.infer<typeof insertShiftRequiredRoleSchema>;
export type ShiftRequiredRole = typeof shiftRequiredRoles.$inferSelect;

// Time off types
export const timeOffTypes = ["SICK", "ANNUAL", "BUSINESS", "UNPAID", "TRAINING", "OTHER", "CHANGE_DAY_OFF"] as const;
export type TimeOffType = typeof timeOffTypes[number];

// Employee time off table
export const halfDayPeriods = ["AM", "PM"] as const;
export type HalfDayPeriod = typeof halfDayPeriods[number];

export const employeeTimeOff = pgTable("employee_time_off", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  type: text("type", { enum: timeOffTypes }).notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  isHalfDay: boolean("is_half_day").notNull().default(false),
  halfDayPeriod: text("half_day_period", { enum: halfDayPeriods }), // AM or PM; null = full day
  note: text("note"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_time_off_tenant").on(table.tenantId),
  index("idx_time_off_employee_dates").on(table.employeeId, table.startDate, table.endDate),
  index("idx_time_off_branch_dates").on(table.branchId, table.startDate, table.endDate),
]);

export const employeeTimeOffRelations = relations(employeeTimeOff, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeTimeOff.employeeId],
    references: [employees.id],
  }),
  branch: one(branches, {
    fields: [employeeTimeOff.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [employeeTimeOff.createdBy],
    references: [users.id],
  }),
}));

export const insertEmployeeTimeOffSchema = createInsertSchema(employeeTimeOff).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEmployeeTimeOff = z.infer<typeof insertEmployeeTimeOffSchema>;
export type EmployeeTimeOff = typeof employeeTimeOff.$inferSelect;

// Coverage rule day types (for V2 auto-scheduling)
export const coverageDayTypes = ["WEEKDAY", "WEEKEND"] as const;
export type CoverageDayType = typeof coverageDayTypes[number];

// Coverage rules table (store for V2, not enforced in V1)
export const coverageRules = pgTable("coverage_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  departmentId: varchar("department_id").references(() => departments.id),
  dayType: text("day_type", { enum: coverageDayTypes }).notNull(),
  minStaff: integer("min_staff").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const coverageRulesRelations = relations(coverageRules, ({ one }) => ({
  branch: one(branches, {
    fields: [coverageRules.branchId],
    references: [branches.id],
  }),
  department: one(departments, {
    fields: [coverageRules.departmentId],
    references: [departments.id],
  }),
}));

export const insertCoverageRuleSchema = createInsertSchema(coverageRules).omit({
  id: true,
  createdAt: true,
});

export type InsertCoverageRule = z.infer<typeof insertCoverageRuleSchema>;
export type CoverageRule = typeof coverageRules.$inferSelect;

// Extended types for scheduling UI
export type ShiftWithDetails = Shift & {
  employee?: Employee;
  department?: Department;
  requiredRoles?: (ShiftRequiredRole & { role: Role })[];
};

export type EmployeeTimeOffWithDetails = EmployeeTimeOff & {
  employee?: Employee;
};

// Time off type display labels
export const timeOffTypeLabels: Record<TimeOffType, string> = {
  SICK: "Sick Leave",
  ANNUAL: "Annual Leave",
  BUSINESS: "Business Days",
  UNPAID: "Unpaid Leave",
  TRAINING: "Training",
  OTHER: "Other",
  CHANGE_DAY_OFF: "Change Day Off",
};

// Time off type colors for badges
export const timeOffTypeColors: Record<TimeOffType, string> = {
  SICK: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  ANNUAL: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  BUSINESS: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  UNPAID: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  TRAINING: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  OTHER: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  CHANGE_DAY_OFF: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
};

// ============================================
// LEAVE POLICIES (Days Off Balance System)
// ============================================

export const leavePolicies = pgTable("leave_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  branchId: varchar("branch_id").references(() => branches.id),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  daysWorkedRequired: integer("days_worked_required").notNull().default(5),
  daysOffEarned: integer("days_off_earned").notNull().default(2),
  effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const leavePoliciesRelations = relations(leavePolicies, ({ one }) => ({
  branch: one(branches, {
    fields: [leavePolicies.branchId],
    references: [branches.id],
  }),
}));

export const insertLeavePolicySchema = createInsertSchema(leavePolicies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLeavePolicy = z.infer<typeof insertLeavePolicySchema>;
export type LeavePolicy = typeof leavePolicies.$inferSelect;

// Leave balance type (computed, not stored)
export type LeaveBalance = {
  employeeId: string;
  daysWorked: number;
  daysEarned: number;
  daysUsed: number;
  balance: number;
  policyName: string | null;
};

// ============================================
// SICK LEAVE POLICY
// ============================================

export const sickLeavePolicies = pgTable("sick_leave_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  annualSickLeaveDays: integer("annual_sick_leave_days").notNull().default(30),
  proRateByStartDate: boolean("pro_rate_by_start_date").notNull().default(true),
  yearStartMonth: integer("year_start_month").notNull().default(1), // 1 = January (calendar year)
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_sick_leave_policies_tenant").on(table.tenantId),
  index("idx_sick_leave_policies_branch").on(table.branchId),
]);

export const sickLeavePoliciesRelations = relations(sickLeavePolicies, ({ one }) => ({
  branch: one(branches, {
    fields: [sickLeavePolicies.branchId],
    references: [branches.id],
  }),
}));

export const insertSickLeavePolicySchema = createInsertSchema(sickLeavePolicies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSickLeavePolicy = z.infer<typeof insertSickLeavePolicySchema>;
export type SickLeavePolicy = typeof sickLeavePolicies.$inferSelect;

// ============================================
// PUBLIC HOLIDAYS
// ============================================

export const publicHolidays = pgTable("public_holidays", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  date: date("date").notNull(),
  year: integer("year").notNull(), // For easier querying by year
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_public_holidays_tenant").on(table.tenantId),
  index("idx_public_holidays_year").on(table.year),
  index("idx_public_holidays_date").on(table.date),
]);

export const publicHolidaysRelations = relations(publicHolidays, ({ one }) => ({
  tenant: one(tenants, {
    fields: [publicHolidays.tenantId],
    references: [tenants.id],
  }),
}));

export const insertPublicHolidaySchema = createInsertSchema(publicHolidays).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPublicHoliday = z.infer<typeof insertPublicHolidaySchema>;
export type PublicHoliday = typeof publicHolidays.$inferSelect;

// Sick leave balance type (computed, not stored)
export type SickLeaveBalance = {
  employeeId: string;
  employeeName: string;
  year: number;
  annualEntitlement: number; // Full year entitlement (e.g., 30)
  proRatedEntitlement: number; // Adjusted for start date
  daysUsed: number;
  daysRemaining: number;
  startDate: Date | null; // Employee start date
  monthsInYear: number; // Months employee will work in this calendar year
};

// ============================================
// EMPLOYEE PRESENCE (Directory API - Clock in/out state)
// ============================================

export const employeePresence = pgTable("employee_presence", {
  employeeId: varchar("employee_id").primaryKey().references(() => employees.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  isClockedIn: boolean("is_clocked_in").notNull().default(false),
  currentWorkBranchId: varchar("current_work_branch_id").references(() => branches.id),
  lastInAt: timestamp("last_in_at"),
  lastOutAt: timestamp("last_out_at"),
  lastEventAt: timestamp("last_event_at"),
  lastEventType: varchar("last_event_type", { length: 10 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_employee_presence_tenant").on(table.tenantId),
]);

export const employeePresenceRelations = relations(employeePresence, ({ one }) => ({
  employee: one(employees, {
    fields: [employeePresence.employeeId],
    references: [employees.id],
  }),
  currentWorkBranch: one(branches, {
    fields: [employeePresence.currentWorkBranchId],
    references: [branches.id],
  }),
}));

export const insertEmployeePresenceSchema = createInsertSchema(employeePresence).omit({
  updatedAt: true,
});

export type InsertEmployeePresence = z.infer<typeof insertEmployeePresenceSchema>;
export type EmployeePresence = typeof employeePresence.$inferSelect;

// Directory API response types
export type DirectoryEmployeeResponse = {
  employee_id: string;
  full_name: string;
  preferred_name: string | null;
  status: EmploymentState;
  home_branch: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  roles: { id: string; name: string }[];
  presence: {
    is_clocked_in: boolean;
    current_work_branch: { id: string; name: string } | null;
    last_update_at: string | null;
  };
};

export type DirectorySearchResult = {
  employee_id: string;
  full_name: string;
  preferred_name: string | null;
  email: string | null;
  branch_name: string | null;
  status: EmploymentState;
};

export type DirectoryBranchRosterEmployee = {
  employee_id: string;
  name: string;
  department: { id: string; name: string } | null;
  roles: { id: string; name: string }[];
  status: EmploymentState;
  is_clocked_in: boolean;
};

// ============================================
// SCHEDULING MODULE
// ============================================

// Schedule Week Plans - container for a week's schedule at a branch
export const scheduleWeekPlans = pgTable("schedule_week_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id, { onDelete: "cascade" }).notNull(),
  weekStartDate: date("week_start_date").notNull(), // Monday of the week
  name: text("name"), // optional label
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_schedule_week_plans_tenant").on(table.tenantId),
  index("idx_week_plans_branch_week").on(table.branchId, table.weekStartDate),
]);

export const scheduleWeekPlansRelations = relations(scheduleWeekPlans, ({ one, many }) => ({
  branch: one(branches, {
    fields: [scheduleWeekPlans.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [scheduleWeekPlans.createdBy],
    references: [users.id],
  }),
  shiftRows: many(scheduleShiftRows),
}));

export const insertScheduleWeekPlanSchema = createInsertSchema(scheduleWeekPlans).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertScheduleWeekPlan = z.infer<typeof insertScheduleWeekPlanSchema>;
export type ScheduleWeekPlan = typeof scheduleWeekPlans.$inferSelect;

// Shift Groups - manual grouping containers for shifts in Shift View
export const shiftGroups = pgTable("shift_groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_shift_groups_tenant").on(table.tenantId),
  index("idx_shift_groups_branch").on(table.branchId),
]);

export const shiftGroupsRelations = relations(shiftGroups, ({ one, many }) => ({
  branch: one(branches, {
    fields: [shiftGroups.branchId],
    references: [branches.id],
  }),
  createdByUser: one(users, {
    fields: [shiftGroups.createdBy],
    references: [users.id],
  }),
  shiftRows: many(scheduleShiftRows),
}));

export const insertShiftGroupSchema = createInsertSchema(shiftGroups).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShiftGroup = z.infer<typeof insertShiftGroupSchema>;
export type ShiftGroup = typeof shiftGroups.$inferSelect;

// Schedule Shift Rows - a row within a week plan for a department
export const scheduleShiftRows = pgTable("schedule_shift_rows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id, { onDelete: "cascade" }).notNull(),
  departmentId: varchar("department_id").references(() => departments.id, { onDelete: "cascade" }),
  shiftGroupId: varchar("shift_group_id").references(() => shiftGroups.id, { onDelete: "restrict" }).notNull(),
  sortOrderWithinGroup: integer("sort_order_within_group").default(0),
  weekPlanId: varchar("week_plan_id").references(() => scheduleWeekPlans.id, { onDelete: "set null" }),
  rowOrder: integer("row_order").notNull().default(0),
  label: text("label"), // optional "Morning", "Evening", etc.
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  note: text("note"),
  staffRequired: integer("staff_required").notNull().default(1), // default staff needed per day
  staffRequiredByDay: jsonb("staff_required_by_day").$type<Record<string, number>>(), // per-day overrides {"mon": 2, "tue": 1, ...}
  colorIndex: integer("color_index"), // persistent color index for consistent colors across weeks
  breakEnabled: boolean("break_enabled").notNull().default(true),
  breakDurationMinutes: integer("break_duration_minutes").notNull().default(60),
  breakBaseOffsetMinutes: integer("break_base_offset_minutes").notNull().default(150),
  breakStaggerMinutes: integer("break_stagger_minutes").notNull().default(30),
  activeFromDate: date("active_from_date"), // shift row available from this date (null = always available)
  activeUntilDate: date("active_until_date"), // shift row available until this date (null = forever)
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_schedule_shift_rows_tenant").on(table.tenantId),
  index("idx_shift_rows_week_plan").on(table.weekPlanId, table.departmentId),
  index("idx_shift_rows_branch_active").on(table.branchId, table.activeFromDate, table.activeUntilDate),
]);

export const scheduleShiftRowsRelations = relations(scheduleShiftRows, ({ one, many }) => ({
  branch: one(branches, {
    fields: [scheduleShiftRows.branchId],
    references: [branches.id],
  }),
  department: one(departments, {
    fields: [scheduleShiftRows.departmentId],
    references: [departments.id],
  }),
  weekPlan: one(scheduleWeekPlans, {
    fields: [scheduleShiftRows.weekPlanId],
    references: [scheduleWeekPlans.id],
  }),
  shiftGroup: one(shiftGroups, {
    fields: [scheduleShiftRows.shiftGroupId],
    references: [shiftGroups.id],
  }),
  createdByUser: one(users, {
    fields: [scheduleShiftRows.createdBy],
    references: [users.id],
  }),
  roles: many(scheduleShiftRowRoles),
  assignments: many(scheduleAssignments),
  breaks: many(scheduleShiftBreaks),
}));

export const insertScheduleShiftRowSchema = createInsertSchema(scheduleShiftRows).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertScheduleShiftRow = z.infer<typeof insertScheduleShiftRowSchema>;
export type ScheduleShiftRow = typeof scheduleShiftRows.$inferSelect;

// Schedule Shift Row Roles - required roles for a shift row
export const scheduleShiftRowRoles = pgTable("schedule_shift_row_roles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  shiftRowId: varchar("shift_row_id").references(() => scheduleShiftRows.id, { onDelete: "cascade" }).notNull(),
  roleId: varchar("role_id").references(() => roles.id, { onDelete: "cascade" }).notNull(),
}, (table) => [
  index("idx_schedule_shift_row_roles_tenant").on(table.tenantId),
  index("idx_shift_row_roles_shift").on(table.shiftRowId),
]);

export const scheduleShiftRowRolesRelations = relations(scheduleShiftRowRoles, ({ one }) => ({
  shiftRow: one(scheduleShiftRows, {
    fields: [scheduleShiftRowRoles.shiftRowId],
    references: [scheduleShiftRows.id],
  }),
  role: one(roles, {
    fields: [scheduleShiftRowRoles.roleId],
    references: [roles.id],
  }),
}));

export const insertScheduleShiftRowRoleSchema = createInsertSchema(scheduleShiftRowRoles).omit({
  id: true,
});

export type InsertScheduleShiftRowRole = z.infer<typeof insertScheduleShiftRowRoleSchema>;
export type ScheduleShiftRowRole = typeof scheduleShiftRowRoles.$inferSelect;

// Schedule Assignment Types - employee or casual worker
export const scheduleAssigneeTypes = ["employee", "casual"] as const;
export type ScheduleAssigneeType = typeof scheduleAssigneeTypes[number];

// Schedule Assignments - employee or casual worker assigned to a shift row on a specific date
export const scheduleAssignments = pgTable("schedule_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  weekPlanId: varchar("week_plan_id").references(() => scheduleWeekPlans.id, { onDelete: "cascade" }).notNull(),
  shiftRowId: varchar("shift_row_id").references(() => scheduleShiftRows.id, { onDelete: "cascade" }).notNull(),
  shiftDate: date("shift_date").notNull(), // actual date within the week
  assigneeType: text("assignee_type", { enum: scheduleAssigneeTypes }).notNull().default("employee"),
  employeeId: varchar("employee_id").references(() => employees.id, { onDelete: "cascade" }), // nullable for casual workers
  casualWorkerId: varchar("casual_worker_id").references(() => casualWorkers.id, { onDelete: "cascade" }), // for casual worker assignments
  dailyRateSnapshot: integer("daily_rate_snapshot"), // snapshot of casual worker's daily rate at assignment time
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: varchar("assigned_by").references(() => users.id),
  isBorrowed: boolean("is_borrowed").default(false).notNull(),
  borrowedFromBranchId: varchar("borrowed_from_branch_id").references(() => branches.id, { onDelete: "set null" }),
  roleId: varchar("role_id").references(() => roles.id, { onDelete: "set null" }),
}, (table) => [
  index("idx_schedule_assignments_tenant").on(table.tenantId),
  index("idx_assignments_shift_date").on(table.shiftRowId, table.shiftDate),
  index("idx_assignments_employee_date").on(table.employeeId, table.shiftDate),
  index("idx_assignments_casual_worker").on(table.casualWorkerId, table.shiftDate),
  index("idx_assignments_week_plan").on(table.weekPlanId),
  index("idx_assignments_borrowed").on(table.isBorrowed),
  index("idx_assignments_type").on(table.assigneeType),
  index("idx_assignments_role").on(table.roleId),
]);

export const scheduleAssignmentsRelations = relations(scheduleAssignments, ({ one }) => ({
  weekPlan: one(scheduleWeekPlans, {
    fields: [scheduleAssignments.weekPlanId],
    references: [scheduleWeekPlans.id],
  }),
  shiftRow: one(scheduleShiftRows, {
    fields: [scheduleAssignments.shiftRowId],
    references: [scheduleShiftRows.id],
  }),
  employee: one(employees, {
    fields: [scheduleAssignments.employeeId],
    references: [employees.id],
  }),
  casualWorker: one(casualWorkers, {
    fields: [scheduleAssignments.casualWorkerId],
    references: [casualWorkers.id],
  }),
  assignedByUser: one(users, {
    fields: [scheduleAssignments.assignedBy],
    references: [users.id],
  }),
  borrowedFromBranch: one(branches, {
    fields: [scheduleAssignments.borrowedFromBranchId],
    references: [branches.id],
  }),
  role: one(roles, {
    fields: [scheduleAssignments.roleId],
    references: [roles.id],
  }),
}));

export const insertScheduleAssignmentSchema = createInsertSchema(scheduleAssignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertScheduleAssignment = z.infer<typeof insertScheduleAssignmentSchema>;
export type ScheduleAssignment = typeof scheduleAssignments.$inferSelect;

// Schedule Shift Breaks - persisted lunch/break records per employee per shift instance
export const breakSourceTypes = ["auto_rule", "manual_override"] as const;
export type BreakSourceType = typeof breakSourceTypes[number];

export const scheduleShiftBreaks = pgTable("schedule_shift_breaks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id, { onDelete: "cascade" }).notNull(),
  shiftRowId: varchar("shift_row_id").references(() => scheduleShiftRows.id, { onDelete: "cascade" }).notNull(),
  shiftDate: date("shift_date").notNull(),
  employeeId: varchar("employee_id").references(() => employees.id, { onDelete: "cascade" }),
  casualWorkerId: varchar("casual_worker_id").references(() => casualWorkers.id, { onDelete: "cascade" }),
  assignmentId: varchar("assignment_id").references(() => scheduleAssignments.id, { onDelete: "cascade" }).notNull(),
  breakStartTime: time("break_start_time").notNull(),
  breakEndTime: time("break_end_time").notNull(),
  breakDurationMinutes: integer("break_duration_minutes").notNull().default(60),
  source: text("source", { enum: breakSourceTypes }).notNull().default("auto_rule"),
  hasConflict: boolean("has_conflict").notNull().default(false),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_shift_breaks_tenant").on(table.tenantId),
  index("idx_shift_breaks_shift_date").on(table.shiftRowId, table.shiftDate),
  index("idx_shift_breaks_assignment").on(table.assignmentId),
  index("idx_shift_breaks_employee_date").on(table.employeeId, table.shiftDate),
]);

export const scheduleShiftBreaksRelations = relations(scheduleShiftBreaks, ({ one }) => ({
  shiftRow: one(scheduleShiftRows, {
    fields: [scheduleShiftBreaks.shiftRowId],
    references: [scheduleShiftRows.id],
  }),
  employee: one(employees, {
    fields: [scheduleShiftBreaks.employeeId],
    references: [employees.id],
  }),
  assignment: one(scheduleAssignments, {
    fields: [scheduleShiftBreaks.assignmentId],
    references: [scheduleAssignments.id],
  }),
}));

export const insertScheduleShiftBreakSchema = createInsertSchema(scheduleShiftBreaks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertScheduleShiftBreak = z.infer<typeof insertScheduleShiftBreakSchema>;
export type ScheduleShiftBreak = typeof scheduleShiftBreaks.$inferSelect;

// Schedule Templates - reusable weekly schedule templates (department-scoped)
export const scheduleTemplates = pgTable("schedule_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id, { onDelete: "cascade" }).notNull(),
  departmentId: varchar("department_id").references(() => departments.id, { onDelete: "cascade" }),
  shiftGroupId: varchar("shift_group_id").references(() => shiftGroups.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  sourceWeekPlanId: varchar("source_week_plan_id").references(() => scheduleWeekPlans.id, { onDelete: "set null" }),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_schedule_templates_tenant").on(table.tenantId),
  index("idx_templates_branch").on(table.branchId),
  index("idx_templates_shift_group").on(table.shiftGroupId),
]);

export const scheduleTemplatesRelations = relations(scheduleTemplates, ({ one, many }) => ({
  branch: one(branches, {
    fields: [scheduleTemplates.branchId],
    references: [branches.id],
  }),
  department: one(departments, {
    fields: [scheduleTemplates.departmentId],
    references: [departments.id],
  }),
  shiftGroup: one(shiftGroups, {
    fields: [scheduleTemplates.shiftGroupId],
    references: [shiftGroups.id],
  }),
  sourceWeekPlan: one(scheduleWeekPlans, {
    fields: [scheduleTemplates.sourceWeekPlanId],
    references: [scheduleWeekPlans.id],
  }),
  createdByUser: one(users, {
    fields: [scheduleTemplates.createdBy],
    references: [users.id],
  }),
  rows: many(scheduleTemplateRows),
  timeOff: many(scheduleTemplateTimeOff),
}));

export const insertScheduleTemplateSchema = createInsertSchema(scheduleTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertScheduleTemplate = z.infer<typeof insertScheduleTemplateSchema>;
export type ScheduleTemplate = typeof scheduleTemplates.$inferSelect;

// Schedule Template Rows - shift row definitions within a template
export const scheduleTemplateRows = pgTable("schedule_template_rows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  templateId: varchar("template_id").references(() => scheduleTemplates.id, { onDelete: "cascade" }).notNull(),
  departmentId: varchar("department_id").references(() => departments.id, { onDelete: "cascade" }),
  shiftGroupId: varchar("shift_group_id").references(() => shiftGroups.id, { onDelete: "set null" }),
  rowOrder: integer("row_order").notNull().default(0),
  label: text("label"),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  staffRequired: integer("staff_required").notNull().default(1),
  staffRequiredByDay: jsonb("staff_required_by_day").$type<Record<string, number>>(),
  colorIndex: integer("color_index"),
  breakEnabled: boolean("break_enabled").notNull().default(true),
  breakDurationMinutes: integer("break_duration_minutes").notNull().default(60),
  breakBaseOffsetMinutes: integer("break_base_offset_minutes").notNull().default(150),
  breakStaggerMinutes: integer("break_stagger_minutes").notNull().default(30),
}, (table) => [
  index("idx_schedule_template_rows_tenant").on(table.tenantId),
  index("idx_template_rows_template").on(table.templateId),
]);

export const scheduleTemplateRowsRelations = relations(scheduleTemplateRows, ({ one, many }) => ({
  template: one(scheduleTemplates, {
    fields: [scheduleTemplateRows.templateId],
    references: [scheduleTemplates.id],
  }),
  department: one(departments, {
    fields: [scheduleTemplateRows.departmentId],
    references: [departments.id],
  }),
  roles: many(scheduleTemplateRowRoles),
  assignments: many(scheduleTemplateAssignments),
}));

export const insertScheduleTemplateRowSchema = createInsertSchema(scheduleTemplateRows).omit({
  id: true,
});

export type InsertScheduleTemplateRow = z.infer<typeof insertScheduleTemplateRowSchema>;
export type ScheduleTemplateRow = typeof scheduleTemplateRows.$inferSelect;

// Schedule Template Row Roles - required roles for a template row
export const scheduleTemplateRowRoles = pgTable("schedule_template_row_roles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  templateRowId: varchar("template_row_id").references(() => scheduleTemplateRows.id, { onDelete: "cascade" }).notNull(),
  roleId: varchar("role_id").references(() => roles.id, { onDelete: "cascade" }).notNull(),
}, (table) => [
  index("idx_schedule_template_row_roles_tenant").on(table.tenantId),
  index("idx_template_row_roles_row").on(table.templateRowId),
]);

export const scheduleTemplateRowRolesRelations = relations(scheduleTemplateRowRoles, ({ one }) => ({
  templateRow: one(scheduleTemplateRows, {
    fields: [scheduleTemplateRowRoles.templateRowId],
    references: [scheduleTemplateRows.id],
  }),
  role: one(roles, {
    fields: [scheduleTemplateRowRoles.roleId],
    references: [roles.id],
  }),
}));

export const insertScheduleTemplateRowRoleSchema = createInsertSchema(scheduleTemplateRowRoles).omit({
  id: true,
});

export type InsertScheduleTemplateRowRole = z.infer<typeof insertScheduleTemplateRowRoleSchema>;
export type ScheduleTemplateRowRole = typeof scheduleTemplateRowRoles.$inferSelect;

// Schedule Template Assignments - default employee assignments in a template
export const scheduleTemplateAssignments = pgTable("schedule_template_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateRowId: varchar("template_row_id").references(() => scheduleTemplateRows.id, { onDelete: "cascade" }).notNull(),
  dayOfWeek: integer("day_of_week").notNull(), // 0=Mon, 1=Tue, ..., 6=Sun
  employeeId: varchar("employee_id").references(() => employees.id, { onDelete: "cascade" }).notNull(),
}, (table) => [
  index("idx_template_assignments_row").on(table.templateRowId),
]);

export const scheduleTemplateAssignmentsRelations = relations(scheduleTemplateAssignments, ({ one }) => ({
  templateRow: one(scheduleTemplateRows, {
    fields: [scheduleTemplateAssignments.templateRowId],
    references: [scheduleTemplateRows.id],
  }),
  employee: one(employees, {
    fields: [scheduleTemplateAssignments.employeeId],
    references: [employees.id],
  }),
}));

export const insertScheduleTemplateAssignmentSchema = createInsertSchema(scheduleTemplateAssignments).omit({
  id: true,
});

export type InsertScheduleTemplateAssignment = z.infer<typeof insertScheduleTemplateAssignmentSchema>;
export type ScheduleTemplateAssignment = typeof scheduleTemplateAssignments.$inferSelect;

// Schedule Template Time Off - day-off entries stored in a template
export const scheduleTemplateTimeOff = pgTable("schedule_template_time_off", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  templateId: varchar("template_id").references(() => scheduleTemplates.id, { onDelete: "cascade" }).notNull(),
  dayOfWeek: integer("day_of_week").notNull(), // 0=Mon, 1=Tue, ..., 6=Sun
  employeeId: varchar("employee_id").references(() => employees.id, { onDelete: "cascade" }).notNull(),
  type: text("type").notNull().default("CHANGE_DAY_OFF"), // ANNUAL, SICK, CHANGE_DAY_OFF, etc.
}, (table) => [
  index("idx_template_time_off_template").on(table.templateId),
  index("idx_template_time_off_tenant").on(table.tenantId),
]);

export const scheduleTemplateTimeOffRelations = relations(scheduleTemplateTimeOff, ({ one }) => ({
  template: one(scheduleTemplates, {
    fields: [scheduleTemplateTimeOff.templateId],
    references: [scheduleTemplates.id],
  }),
  employee: one(employees, {
    fields: [scheduleTemplateTimeOff.employeeId],
    references: [employees.id],
  }),
}));

export const insertScheduleTemplateTimeOffSchema = createInsertSchema(scheduleTemplateTimeOff).omit({
  id: true,
});

export type InsertScheduleTemplateTimeOff = z.infer<typeof insertScheduleTemplateTimeOffSchema>;
export type ScheduleTemplateTimeOff = typeof scheduleTemplateTimeOff.$inferSelect;

// Schedule Template Duty Blocks - duty blocks stored in a template
// Each row mirrors one duty_block attached to a template assignment.
export const scheduleTemplateDutyBlocks = pgTable("schedule_template_duty_blocks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateAssignmentId: varchar("template_assignment_id").references(() => scheduleTemplateAssignments.id, { onDelete: "cascade" }).notNull(),
  dutyTypeId: varchar("duty_type_id").references(() => dutyTypes.id, { onDelete: "cascade" }),
  dutyName: text("duty_name"),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  notes: text("notes"),
}, (table) => [
  index("idx_tmpl_duty_blocks_assignment").on(table.templateAssignmentId),
]);

export const scheduleTemplateDutyBlocksRelations = relations(scheduleTemplateDutyBlocks, ({ one }) => ({
  templateAssignment: one(scheduleTemplateAssignments, {
    fields: [scheduleTemplateDutyBlocks.templateAssignmentId],
    references: [scheduleTemplateAssignments.id],
  }),
  dutyType: one(dutyTypes, {
    fields: [scheduleTemplateDutyBlocks.dutyTypeId],
    references: [dutyTypes.id],
  }),
}));

export const insertScheduleTemplateDutyBlockSchema = createInsertSchema(scheduleTemplateDutyBlocks).omit({
  id: true,
});

export type InsertScheduleTemplateDutyBlock = z.infer<typeof insertScheduleTemplateDutyBlockSchema>;
export type ScheduleTemplateDutyBlock = typeof scheduleTemplateDutyBlocks.$inferSelect;

// Schedule Audit Log - tracks all destructive schedule operations
export const scheduleAuditLog = pgTable("schedule_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  weekPlanId: varchar("week_plan_id"),
  branchId: varchar("branch_id"),
  departmentId: varchar("department_id").references(() => departments.id),
  weekStartDate: date("week_start_date"),
  action: varchar("action", { length: 50 }).notNull(), // 'apply_template', 'clear_week', 'delete_shift_row', 'overwrite_department'
  description: text("description"),
  performedBy: varchar("performed_by").references(() => users.id),
  snapshotData: jsonb("snapshot_data"), // JSON snapshot of affected data before the action
  summaryData: jsonb("summary_data"), // Structured counts: { shiftRows, assignments, breaks }
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_schedule_audit_tenant").on(table.tenantId),
  index("idx_schedule_audit_week_plan").on(table.weekPlanId),
  index("idx_schedule_audit_created").on(table.createdAt),
]);

export type ScheduleAuditLog = typeof scheduleAuditLog.$inferSelect;

// Extended types for API responses
export type ScheduleShiftRowWithDetails = ScheduleShiftRow & {
  department?: Department;
  shiftGroup?: ShiftGroup;
  roles: (ScheduleShiftRowRole & { role?: Role })[];
  assignments: (ScheduleAssignment & { employee?: Employee })[];
  breaks?: ScheduleShiftBreak[];
};

export type ScheduleWeekPlanWithDetails = Partial<ScheduleWeekPlan> & {
  branch?: Branch;
  shiftRows: ScheduleShiftRowWithDetails[];
  shiftGroups?: ShiftGroup[];
};

export type ScheduleTemplateWithDetails = ScheduleTemplate & {
  branch?: Branch;
  department?: Department;
  shiftGroup?: ShiftGroup;
  rows: (ScheduleTemplateRow & {
    department?: Department;
    roles: (ScheduleTemplateRowRole & { role?: Role })[];
  })[];
};

// ============================================
// PAYROLL MODULE SCHEMA
// ============================================

// Payroll Period Types
export const payrollPeriodTypes = ["MONTHLY", "BIWEEKLY", "WEEKLY"] as const;
export type PayrollPeriodType = typeof payrollPeriodTypes[number];

// Payroll Period Statuses
export const payrollPeriodStatuses = ["DRAFT", "CALCULATING", "AWAITING_APPROVALS", "READY_TO_FINALIZE", "FINALIZED", "VOIDED"] as const;
export type PayrollPeriodStatus = typeof payrollPeriodStatuses[number];

// Payroll Run Statuses
export const payrollRunStatuses = ["DRAFT", "LOCKED_FOR_REVIEW", "FINALIZED", "VOIDED"] as const;
export type PayrollRunStatus = typeof payrollRunStatuses[number];

// Employment Types
export const employmentTypes = ["MONTHLY", "HOURLY"] as const;
export type EmploymentType = typeof employmentTypes[number];

// Time Adjustment Types
export const timeAdjustmentTypes = ["ADD_PUNCH", "REMOVE_PUNCH", "EDIT_PUNCH", "MANUAL_HOURS", "BREAK_ADJUST"] as const;
export type TimeAdjustmentType = typeof timeAdjustmentTypes[number];

// Approval Statuses
export const approvalStatuses = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ApprovalStatus = typeof approvalStatuses[number];

// Exception Types
export const payrollExceptionTypes = [
  "MISSING_PUNCH",
  "NEGATIVE_HOURS",
  "EDITED_AFTER_CUTOFF",
  "VARIANCE_OVER_THRESHOLD",
  "OT_REQUIRES_APPROVAL",
  "HOLIDAY_RULE_CONFLICT",
  "ADVANCE_DEDUCTION_OVER_LIMIT",
  "STATUTORY_DATA_MISSING",
  "MANUAL_OVERRIDE_REQUIRED"
] as const;
export type PayrollExceptionType = typeof payrollExceptionTypes[number];

// Exception Severity
export const exceptionSeverities = ["INFO", "WARNING", "BLOCKER"] as const;
export type ExceptionSeverity = typeof exceptionSeverities[number];

// Exception Statuses
export const exceptionStatuses = ["OPEN", "APPROVED", "REJECTED", "RESOLVED", "WAIVED"] as const;
export type ExceptionStatus = typeof exceptionStatuses[number];

// Required Approver Roles
export const requiredApproverRoles = ["MANAGER", "PAYROLL_ADMIN"] as const;
export type RequiredApproverRole = typeof requiredApproverRoles[number];

// Line Item Types
export const lineItemTypes = ["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION"] as const;
export type LineItemType = typeof lineItemTypes[number];

// Employee Summary Statuses
export const employeeSummaryStatuses = ["DRAFT", "READY", "FINALIZED"] as const;
export type EmployeeSummaryStatus = typeof employeeSummaryStatuses[number];

// Salary Advance Repayment Types
export const repaymentTypes = ["FIXED_AMOUNT", "FIXED_MONTHS", "PERCENT_OF_NET"] as const;
export type RepaymentType = typeof repaymentTypes[number];

// Salary Advance Statuses
export const advanceStatuses = ["ACTIVE", "PAUSED", "CLOSED"] as const;
export type AdvanceStatus = typeof advanceStatuses[number];

// Rounding Rules
export const roundingRules = ["NONE", "NEAREST_5", "NEAREST_10", "NEAREST_15"] as const;
export type RoundingRule = typeof roundingRules[number];

// ============================================
// PAYROLL PERIODS
// ============================================

export const payrollPeriods = pgTable("payroll_periods", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  operatorId: uuid("operator_id").references(() => operators.id).notNull(),
  countryCode: text("country_code").notNull().default("TH"),
  periodType: text("period_type", { enum: payrollPeriodTypes }).notNull().default("MONTHLY"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true }),
  status: text("status", { enum: payrollPeriodStatuses }).notNull().default("DRAFT"),
  createdBy: varchar("created_by").references(() => users.id),
  finalizedBy: varchar("finalized_by").references(() => users.id),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_periods_tenant").on(table.tenantId),
  index("idx_payroll_periods_operator").on(table.operatorId),
  index("idx_payroll_periods_dates").on(table.startDate, table.endDate),
]);

export const payrollPeriodsRelations = relations(payrollPeriods, ({ one, many }) => ({
  tenant: one(tenants, { fields: [payrollPeriods.tenantId], references: [tenants.id] }),
  operator: one(operators, { fields: [payrollPeriods.operatorId], references: [operators.id] }),
  createdByUser: one(users, { fields: [payrollPeriods.createdBy], references: [users.id] }),
  finalizedByUser: one(users, { fields: [payrollPeriods.finalizedBy], references: [users.id] }),
  runs: many(payrollRuns),
}));

export const insertPayrollPeriodSchema = createInsertSchema(payrollPeriods).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  finalizedBy: true,
  finalizedAt: true,
});

export type InsertPayrollPeriod = z.infer<typeof insertPayrollPeriodSchema>;
export type PayrollPeriod = typeof payrollPeriods.$inferSelect;

// ============================================
// PAYROLL RUNS (Calculation Snapshots)
// ============================================

export const payrollRuns = pgTable("payroll_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollPeriodId: uuid("payroll_period_id").references(() => payrollPeriods.id).notNull(),
  runNumber: integer("run_number").notNull().default(1),
  status: text("status", { enum: payrollRunStatuses }).notNull().default("DRAFT"),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_runs_period").on(table.payrollPeriodId),
]);

export const payrollRunsRelations = relations(payrollRuns, ({ one, many }) => ({
  period: one(payrollPeriods, { fields: [payrollRuns.payrollPeriodId], references: [payrollPeriods.id] }),
  createdByUser: one(users, { fields: [payrollRuns.createdBy], references: [users.id] }),
  reconciliations: many(payrollDayReconciliations),
  exceptions: many(payrollExceptions),
  lineItems: many(payrollLineItems),
  summaries: many(payrollEmployeeSummaries),
  payslips: many(payslips),
}));

export const insertPayrollRunSchema = createInsertSchema(payrollRuns).omit({
  id: true,
  createdAt: true,
  finalizedAt: true,
});

export type InsertPayrollRun = z.infer<typeof insertPayrollRunSchema>;
export type PayrollRun = typeof payrollRuns.$inferSelect;

// ============================================
// EMPLOYEE PAYROLL PROFILES
// ============================================

export const employeePayrollProfiles = pgTable("employee_payroll_profiles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  operatorId: uuid("operator_id").references(() => operators.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull().unique(),
  employmentType: text("employment_type", { enum: employmentTypes }).notNull().default("MONTHLY"),
  baseSalaryMonthly: numeric("base_salary_monthly", { precision: 12, scale: 2 }),
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }),
  defaultCostCenterId: varchar("default_cost_center_id"),
  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankName: text("bank_name"),
  taxId: text("tax_id"),
  socialSecurityNumber: text("social_security_number"),
  socialSecurityEnabled: boolean("social_security_enabled").notNull().default(true),
  taxWithholdingEnabled: boolean("tax_withholding_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_employee_payroll_profiles_tenant").on(table.tenantId),
  index("idx_employee_payroll_profiles_operator").on(table.operatorId),
  index("idx_employee_payroll_profiles_employee").on(table.employeeId),
]);

export const employeePayrollProfilesRelations = relations(employeePayrollProfiles, ({ one }) => ({
  tenant: one(tenants, { fields: [employeePayrollProfiles.tenantId], references: [tenants.id] }),
  operator: one(operators, { fields: [employeePayrollProfiles.operatorId], references: [operators.id] }),
  employee: one(employees, { fields: [employeePayrollProfiles.employeeId], references: [employees.id] }),
}));

export const insertEmployeePayrollProfileSchema = createInsertSchema(employeePayrollProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEmployeePayrollProfile = z.infer<typeof insertEmployeePayrollProfileSchema>;
export type EmployeePayrollProfile = typeof employeePayrollProfiles.$inferSelect;

// ============================================
// TIME ADJUSTMENTS
// ============================================

export const timeAdjustments = pgTable("time_adjustments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  operatorId: uuid("operator_id").references(() => operators.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  workDate: date("work_date").notNull(),
  adjustmentType: text("adjustment_type", { enum: timeAdjustmentTypes }).notNull(),
  beforePayload: jsonb("before_payload"),
  afterPayload: jsonb("after_payload"),
  reason: text("reason"),
  requestedBy: varchar("requested_by").references(() => users.id).notNull(),
  approvedBy: varchar("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvalStatus: text("approval_status", { enum: approvalStatuses }).notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_time_adjustments_tenant").on(table.tenantId),
  index("idx_time_adjustments_employee").on(table.employeeId),
  index("idx_time_adjustments_date").on(table.workDate),
]);

export const timeAdjustmentsRelations = relations(timeAdjustments, ({ one }) => ({
  tenant: one(tenants, { fields: [timeAdjustments.tenantId], references: [tenants.id] }),
  operator: one(operators, { fields: [timeAdjustments.operatorId], references: [operators.id] }),
  employee: one(employees, { fields: [timeAdjustments.employeeId], references: [employees.id] }),
  branch: one(branches, { fields: [timeAdjustments.branchId], references: [branches.id] }),
  requestedByUser: one(users, { fields: [timeAdjustments.requestedBy], references: [users.id] }),
  approvedByUser: one(users, { fields: [timeAdjustments.approvedBy], references: [users.id] }),
}));

export const insertTimeAdjustmentSchema = createInsertSchema(timeAdjustments).omit({
  id: true,
  createdAt: true,
  approvedBy: true,
  approvedAt: true,
});

export type InsertTimeAdjustment = z.infer<typeof insertTimeAdjustmentSchema>;
export type TimeAdjustment = typeof timeAdjustments.$inferSelect;

// ============================================
// PAYROLL DAY RECONCILIATIONS
// ============================================

export const payrollDayReconciliations = pgTable("payroll_day_reconciliations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollRunId: uuid("payroll_run_id").references(() => payrollRuns.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id).notNull(),
  workDate: date("work_date").notNull(),
  scheduledMinutes: integer("scheduled_minutes").notNull().default(0),
  actualMinutes: integer("actual_minutes").notNull().default(0),
  scheduledPay: numeric("scheduled_pay", { precision: 12, scale: 2 }).notNull().default("0"),
  actualPay: numeric("actual_pay", { precision: 12, scale: 2 }).notNull().default("0"),
  overtimeMinutes: integer("overtime_minutes").notNull().default(0),
  varianceMinutes: integer("variance_minutes").notNull().default(0),
  varianceAmount: numeric("variance_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  flags: jsonb("flags"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_reconciliations_run").on(table.payrollRunId),
  index("idx_payroll_reconciliations_employee").on(table.employeeId),
  index("idx_payroll_reconciliations_date").on(table.workDate),
]);

export const payrollDayReconciliationsRelations = relations(payrollDayReconciliations, ({ one }) => ({
  run: one(payrollRuns, { fields: [payrollDayReconciliations.payrollRunId], references: [payrollRuns.id] }),
  employee: one(employees, { fields: [payrollDayReconciliations.employeeId], references: [employees.id] }),
  branch: one(branches, { fields: [payrollDayReconciliations.branchId], references: [branches.id] }),
}));

export const insertPayrollDayReconciliationSchema = createInsertSchema(payrollDayReconciliations).omit({
  id: true,
  createdAt: true,
});

export type InsertPayrollDayReconciliation = z.infer<typeof insertPayrollDayReconciliationSchema>;
export type PayrollDayReconciliation = typeof payrollDayReconciliations.$inferSelect;

// ============================================
// PAYROLL EXCEPTIONS
// ============================================

export const payrollExceptions = pgTable("payroll_exceptions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollRunId: uuid("payroll_run_id").references(() => payrollRuns.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id),
  workDate: date("work_date"),
  exceptionType: text("exception_type", { enum: payrollExceptionTypes }).notNull(),
  severity: text("severity", { enum: exceptionSeverities }).notNull(),
  message: text("message").notNull(),
  details: jsonb("details"),
  status: text("status", { enum: exceptionStatuses }).notNull().default("OPEN"),
  requiredApproverRole: text("required_approver_role", { enum: requiredApproverRoles }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_exceptions_run").on(table.payrollRunId),
  index("idx_payroll_exceptions_employee").on(table.employeeId),
  index("idx_payroll_exceptions_status").on(table.status),
]);

export const payrollExceptionsRelations = relations(payrollExceptions, ({ one, many }) => ({
  run: one(payrollRuns, { fields: [payrollExceptions.payrollRunId], references: [payrollRuns.id] }),
  employee: one(employees, { fields: [payrollExceptions.employeeId], references: [employees.id] }),
  branch: one(branches, { fields: [payrollExceptions.branchId], references: [branches.id] }),
  approvals: many(payrollExceptionApprovals),
}));

export const insertPayrollExceptionSchema = createInsertSchema(payrollExceptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPayrollException = z.infer<typeof insertPayrollExceptionSchema>;
export type PayrollException = typeof payrollExceptions.$inferSelect;

// ============================================
// PAYROLL EXCEPTION APPROVALS
// ============================================

export const payrollExceptionApprovals = pgTable("payroll_exception_approvals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollExceptionId: uuid("payroll_exception_id").references(() => payrollExceptions.id).notNull(),
  approverId: varchar("approver_id").references(() => users.id).notNull(),
  role: text("role").notNull(),
  decision: text("decision", { enum: ["APPROVED", "REJECTED", "WAIVED"] }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_exception_approvals_exception").on(table.payrollExceptionId),
]);

export const payrollExceptionApprovalsRelations = relations(payrollExceptionApprovals, ({ one }) => ({
  exception: one(payrollExceptions, { fields: [payrollExceptionApprovals.payrollExceptionId], references: [payrollExceptions.id] }),
  approver: one(users, { fields: [payrollExceptionApprovals.approverId], references: [users.id] }),
}));

export const insertPayrollExceptionApprovalSchema = createInsertSchema(payrollExceptionApprovals).omit({
  id: true,
  createdAt: true,
});

export type InsertPayrollExceptionApproval = z.infer<typeof insertPayrollExceptionApprovalSchema>;
export type PayrollExceptionApproval = typeof payrollExceptionApprovals.$inferSelect;

// ============================================
// PAYROLL LINE ITEMS
// ============================================

export const payrollLineItems = pgTable("payroll_line_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollRunId: uuid("payroll_run_id").references(() => payrollRuns.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  lineType: text("line_type", { enum: lineItemTypes }).notNull(),
  code: text("code").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 4 }),
  rate: numeric("rate", { precision: 12, scale: 4 }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  taxable: boolean("taxable").notNull().default(true),
  statutory: boolean("statutory").notNull().default(false),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_line_items_run").on(table.payrollRunId),
  index("idx_payroll_line_items_employee").on(table.employeeId),
  index("idx_payroll_line_items_code").on(table.code),
]);

export const payrollLineItemsRelations = relations(payrollLineItems, ({ one }) => ({
  run: one(payrollRuns, { fields: [payrollLineItems.payrollRunId], references: [payrollRuns.id] }),
  employee: one(employees, { fields: [payrollLineItems.employeeId], references: [employees.id] }),
}));

export const insertPayrollLineItemSchema = createInsertSchema(payrollLineItems).omit({
  id: true,
  createdAt: true,
});

export type InsertPayrollLineItem = z.infer<typeof insertPayrollLineItemSchema>;
export type PayrollLineItem = typeof payrollLineItems.$inferSelect;

// ============================================
// PAYROLL EMPLOYEE SUMMARIES
// ============================================

export const payrollEmployeeSummaries = pgTable("payroll_employee_summaries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollRunId: uuid("payroll_run_id").references(() => payrollRuns.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  grossPay: numeric("gross_pay", { precision: 12, scale: 2 }).notNull().default("0"),
  taxableIncome: numeric("taxable_income", { precision: 12, scale: 2 }).notNull().default("0"),
  totalDeductions: numeric("total_deductions", { precision: 12, scale: 2 }).notNull().default("0"),
  netPay: numeric("net_pay", { precision: 12, scale: 2 }).notNull().default("0"),
  employerCost: numeric("employer_cost", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("THB"),
  status: text("status", { enum: employeeSummaryStatuses }).notNull().default("DRAFT"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_employee_summaries_run").on(table.payrollRunId),
  index("idx_payroll_employee_summaries_employee").on(table.employeeId),
]);

export const payrollEmployeeSummariesRelations = relations(payrollEmployeeSummaries, ({ one }) => ({
  run: one(payrollRuns, { fields: [payrollEmployeeSummaries.payrollRunId], references: [payrollRuns.id] }),
  employee: one(employees, { fields: [payrollEmployeeSummaries.employeeId], references: [employees.id] }),
}));

export const insertPayrollEmployeeSummarySchema = createInsertSchema(payrollEmployeeSummaries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPayrollEmployeeSummary = z.infer<typeof insertPayrollEmployeeSummarySchema>;
export type PayrollEmployeeSummary = typeof payrollEmployeeSummaries.$inferSelect;

// ============================================
// PAYSLIPS
// ============================================

export const payslips = pgTable("payslips", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollRunId: uuid("payroll_run_id").references(() => payrollRuns.id).notNull(),
  payrollPeriodId: uuid("payroll_period_id").references(() => payrollPeriods.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  slipNumber: text("slip_number").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  pdfUrl: text("pdf_url"),
  slipData: jsonb("slip_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payslips_run").on(table.payrollRunId),
  index("idx_payslips_employee").on(table.employeeId),
  index("idx_payslips_slip_number").on(table.slipNumber),
]);

export const payslipsRelations = relations(payslips, ({ one }) => ({
  run: one(payrollRuns, { fields: [payslips.payrollRunId], references: [payrollRuns.id] }),
  period: one(payrollPeriods, { fields: [payslips.payrollPeriodId], references: [payrollPeriods.id] }),
  employee: one(employees, { fields: [payslips.employeeId], references: [employees.id] }),
}));

export const insertPayslipSchema = createInsertSchema(payslips).omit({
  id: true,
  createdAt: true,
});

export type InsertPayslip = z.infer<typeof insertPayslipSchema>;
export type Payslip = typeof payslips.$inferSelect;

// ============================================
// SALARY ADVANCES
// ============================================

export const salaryAdvances = pgTable("salary_advances", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  operatorId: uuid("operator_id").references(() => operators.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  principalAmount: numeric("principal_amount", { precision: 12, scale: 2 }).notNull(),
  issuedDate: date("issued_date").notNull(),
  repaymentStartPeriodId: uuid("repayment_start_period_id").references(() => payrollPeriods.id),
  repaymentType: text("repayment_type", { enum: repaymentTypes }).notNull(),
  repaymentAmount: numeric("repayment_amount", { precision: 12, scale: 2 }),
  repaymentMonths: integer("repayment_months"),
  percentOfNet: numeric("percent_of_net", { precision: 5, scale: 4 }),
  maxPercentOfNetCap: numeric("max_percent_of_net_cap", { precision: 5, scale: 4 }).default("0.30"),
  remainingBalance: numeric("remaining_balance", { precision: 12, scale: 2 }).notNull(),
  status: text("status", { enum: advanceStatuses }).notNull().default("ACTIVE"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_salary_advances_tenant").on(table.tenantId),
  index("idx_salary_advances_operator").on(table.operatorId),
  index("idx_salary_advances_employee").on(table.employeeId),
  index("idx_salary_advances_status").on(table.status),
]);

export const salaryAdvancesRelations = relations(salaryAdvances, ({ one, many }) => ({
  tenant: one(tenants, { fields: [salaryAdvances.tenantId], references: [tenants.id] }),
  operator: one(operators, { fields: [salaryAdvances.operatorId], references: [operators.id] }),
  employee: one(employees, { fields: [salaryAdvances.employeeId], references: [employees.id] }),
  repaymentStartPeriod: one(payrollPeriods, { fields: [salaryAdvances.repaymentStartPeriodId], references: [payrollPeriods.id] }),
  createdByUser: one(users, { fields: [salaryAdvances.createdBy], references: [users.id] }),
  repayments: many(salaryAdvanceRepayments),
}));

export const insertSalaryAdvanceSchema = createInsertSchema(salaryAdvances).omit({
  id: true,
  createdAt: true,
});

export type InsertSalaryAdvance = z.infer<typeof insertSalaryAdvanceSchema>;
export type SalaryAdvance = typeof salaryAdvances.$inferSelect;

// ============================================
// SALARY ADVANCE REPAYMENTS
// ============================================

export const salaryAdvanceRepayments = pgTable("salary_advance_repayments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  salaryAdvanceId: uuid("salary_advance_id").references(() => salaryAdvances.id).notNull(),
  payrollRunId: uuid("payroll_run_id").references(() => payrollRuns.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  remainingBalanceAfter: numeric("remaining_balance_after", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_salary_advance_repayments_advance").on(table.salaryAdvanceId),
  index("idx_salary_advance_repayments_run").on(table.payrollRunId),
]);

export const salaryAdvanceRepaymentsRelations = relations(salaryAdvanceRepayments, ({ one }) => ({
  advance: one(salaryAdvances, { fields: [salaryAdvanceRepayments.salaryAdvanceId], references: [salaryAdvances.id] }),
  run: one(payrollRuns, { fields: [salaryAdvanceRepayments.payrollRunId], references: [payrollRuns.id] }),
  employee: one(employees, { fields: [salaryAdvanceRepayments.employeeId], references: [employees.id] }),
}));

export const insertSalaryAdvanceRepaymentSchema = createInsertSchema(salaryAdvanceRepayments).omit({
  id: true,
  createdAt: true,
});

export type InsertSalaryAdvanceRepayment = z.infer<typeof insertSalaryAdvanceRepaymentSchema>;
export type SalaryAdvanceRepayment = typeof salaryAdvanceRepayments.$inferSelect;

// ============================================
// STATUTORY RULE SETS
// ============================================

export const statutoryRuleSetStatuses = ["active", "archived"] as const;

export const statutoryRuleSets = pgTable("statutory_rule_sets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  operatorId: uuid("operator_id").references(() => operators.id),
  branchId: varchar("branch_id").references(() => branches.id),
  countryCode: text("country_code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  rules: jsonb("rules").notNull(),
  status: text("status", { enum: statutoryRuleSetStatuses }).notNull().default("active"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_statutory_rule_sets_tenant").on(table.tenantId),
  index("idx_statutory_rule_sets_operator").on(table.operatorId),
  index("idx_statutory_rule_sets_branch").on(table.branchId),
  index("idx_statutory_rule_sets_country").on(table.countryCode),
  index("idx_statutory_rule_sets_effective").on(table.effectiveFrom),
  index("idx_statutory_rule_sets_status").on(table.status),
]);

export const statutoryRuleSetsRelations = relations(statutoryRuleSets, ({ one }) => ({
  tenant: one(tenants, { fields: [statutoryRuleSets.tenantId], references: [tenants.id] }),
  operator: one(operators, { fields: [statutoryRuleSets.operatorId], references: [operators.id] }),
  branch: one(branches, { fields: [statutoryRuleSets.branchId], references: [branches.id] }),
  createdByUser: one(users, { fields: [statutoryRuleSets.createdBy], references: [users.id] }),
}));

export const insertStatutoryRuleSetSchema = createInsertSchema(statutoryRuleSets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertStatutoryRuleSet = z.infer<typeof insertStatutoryRuleSetSchema>;
export type StatutoryRuleSet = typeof statutoryRuleSets.$inferSelect;

// ============================================
// STATUTORY CALCULATION RESULTS
// ============================================

export const statutoryCalculationResults = pgTable("statutory_calculation_results", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payrollRunId: uuid("payroll_run_id").references(() => payrollRuns.id).notNull(),
  employeeId: varchar("employee_id").references(() => employees.id).notNull(),
  countryCode: text("country_code").notNull(),
  results: jsonb("results").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_statutory_results_run").on(table.payrollRunId),
  index("idx_statutory_results_employee").on(table.employeeId),
]);

export const statutoryCalculationResultsRelations = relations(statutoryCalculationResults, ({ one }) => ({
  run: one(payrollRuns, { fields: [statutoryCalculationResults.payrollRunId], references: [payrollRuns.id] }),
  employee: one(employees, { fields: [statutoryCalculationResults.employeeId], references: [employees.id] }),
}));

export const insertStatutoryCalculationResultSchema = createInsertSchema(statutoryCalculationResults).omit({
  id: true,
  createdAt: true,
});

export type InsertStatutoryCalculationResult = z.infer<typeof insertStatutoryCalculationResultSchema>;
export type StatutoryCalculationResult = typeof statutoryCalculationResults.$inferSelect;

// ============================================
// PAYROLL POLICY SETTINGS
// ============================================

export const payrollPolicySettings = pgTable("payroll_policy_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  operatorId: uuid("operator_id").references(() => operators.id).notNull().unique(),
  varianceMinutesThreshold: integer("variance_minutes_threshold").notNull().default(15),
  varianceAmountThreshold: numeric("variance_amount_threshold", { precision: 12, scale: 2 }).notNull().default("100"),
  otRequiresApproval: boolean("ot_requires_approval").notNull().default(true),
  roundingRule: text("rounding_rule", { enum: roundingRules }).notNull().default("NONE"),
  unpaidBreakMinutesDefault: integer("unpaid_break_minutes_default").notNull().default(0),
  maxAdvanceDeductionPercentOfNet: numeric("max_advance_deduction_percent_of_net", { precision: 5, scale: 4 }).notNull().default("0.30"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_policy_settings_tenant").on(table.tenantId),
  index("idx_payroll_policy_settings_operator").on(table.operatorId),
]);

export const payrollPolicySettingsRelations = relations(payrollPolicySettings, ({ one }) => ({
  tenant: one(tenants, { fields: [payrollPolicySettings.tenantId], references: [tenants.id] }),
  operator: one(operators, { fields: [payrollPolicySettings.operatorId], references: [operators.id] }),
}));

export const insertPayrollPolicySettingsSchema = createInsertSchema(payrollPolicySettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPayrollPolicySettings = z.infer<typeof insertPayrollPolicySettingsSchema>;
export type PayrollPolicySettings = typeof payrollPolicySettings.$inferSelect;

// ============================================
// PAYROLL EXTENDED TYPES
// ============================================

export type PayrollPeriodWithRuns = PayrollPeriod & {
  runs: PayrollRun[];
  operator?: Operator;
};

export type PayrollRunWithDetails = PayrollRun & {
  period?: PayrollPeriod;
  summaries: PayrollEmployeeSummary[];
  exceptions: PayrollException[];
};

export type PayrollExceptionWithDetails = PayrollException & {
  employee?: Employee;
  branch?: Branch;
  approvals: PayrollExceptionApproval[];
};

export type PayslipData = {
  operatorName: string;
  branchName: string;
  employeeName: string;
  employeeCode: string;
  taxIdMasked: string;
  socialSecurityMasked: string;
  periodStart: string;
  periodEnd: string;
  earnings: Array<{ code: string; description: string; amount: string }>;
  deductions: Array<{ code: string; description: string; amount: string }>;
  employerContributions: Array<{ code: string; description: string; amount: string }>;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  ytdGross: string;
  ytdTax: string;
  ytdSSO: string;
  ytdNet: string;
  bankMasked: string;
};

// ============================================
// ACCESS VAULT (Shared Passwords/Codes)
// ============================================

export const accessCategories = ["wifi", "systems", "door_lock", "vendor", "banking", "other"] as const;
export type AccessCategory = typeof accessCategories[number];

export const accessVisibilityLevels = ["admin_only", "admin_manager", "all_staff"] as const;
export type AccessVisibilityLevel = typeof accessVisibilityLevels[number];

export const accessStatuses = ["active", "archived"] as const;
export type AccessStatus = typeof accessStatuses[number];

export const accessItems = pgTable("access_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  title: text("title").notNull(),
  category: text("category", { enum: accessCategories }),
  username: text("username"),
  passwordEncrypted: text("password_encrypted").notNull(),
  notes: text("notes"),
  branchIds: text("branch_ids").array().notNull().default(sql`'{}'::text[]`),
  visibilityLevel: text("visibility_level", { enum: accessVisibilityLevels }).notNull().default("admin_only"),
  status: text("status", { enum: accessStatuses }).notNull().default("active"),
  updatedBy: varchar("updated_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_access_items_tenant").on(table.tenantId),
  index("idx_access_items_status").on(table.status),
  index("idx_access_items_visibility").on(table.visibilityLevel),
]);

export const accessItemsRelations = relations(accessItems, ({ one }) => ({
  tenant: one(tenants, { fields: [accessItems.tenantId], references: [tenants.id] }),
  updater: one(users, { fields: [accessItems.updatedBy], references: [users.id] }),
}));

export const insertAccessItemSchema = createInsertSchema(accessItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAccessItem = z.infer<typeof insertAccessItemSchema>;
export type AccessItem = typeof accessItems.$inferSelect;

export const accessViewLogs = pgTable("access_view_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  accessItemId: uuid("access_item_id").references(() => accessItems.id).notNull(),
  viewedBy: varchar("viewed_by").references(() => users.id).notNull(),
  viewedAt: timestamp("viewed_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_access_view_logs_item").on(table.accessItemId),
  index("idx_access_view_logs_user").on(table.viewedBy),
]);

export const accessViewLogsRelations = relations(accessViewLogs, ({ one }) => ({
  tenant: one(tenants, { fields: [accessViewLogs.tenantId], references: [tenants.id] }),
  accessItem: one(accessItems, { fields: [accessViewLogs.accessItemId], references: [accessItems.id] }),
  viewer: one(users, { fields: [accessViewLogs.viewedBy], references: [users.id] }),
}));

export const insertAccessViewLogSchema = createInsertSchema(accessViewLogs).omit({
  id: true,
  viewedAt: true,
});

export type InsertAccessViewLog = z.infer<typeof insertAccessViewLogSchema>;
export type AccessViewLog = typeof accessViewLogs.$inferSelect;

// ============================================
// DUTY TYPES & DUTY BLOCKS (Micro-shifts within scheduled shifts)
// ============================================

export const dutyTypes = pgTable("duty_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  defaultDurationMinutes: integer("default_duration_minutes"),
  color: text("color"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_duty_types_tenant").on(table.tenantId),
]);

export const dutyTypesRelations = relations(dutyTypes, ({ one }) => ({
  tenant: one(tenants, { fields: [dutyTypes.tenantId], references: [tenants.id] }),
}));

export const insertDutyTypeSchema = createInsertSchema(dutyTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDutyType = z.infer<typeof insertDutyTypeSchema>;
export type DutyType = typeof dutyTypes.$inferSelect;

export const dutyBlocks = pgTable("duty_blocks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  branchId: varchar("branch_id").references(() => branches.id, { onDelete: "cascade" }).notNull(),
  date: date("date").notNull(),
  employeeId: varchar("employee_id").references(() => employees.id, { onDelete: "cascade" }).notNull(),
  assignmentId: varchar("assignment_id").references(() => scheduleAssignments.id, { onDelete: "cascade" }).notNull(),
  dutyTypeId: varchar("duty_type_id").references(() => dutyTypes.id, { onDelete: "cascade" }),
  dutyName: text("duty_name"),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_duty_blocks_employee_date").on(table.employeeId, table.date),
  index("idx_duty_blocks_branch_date").on(table.branchId, table.date),
  index("idx_duty_blocks_assignment").on(table.assignmentId),
]);

export const dutyBlocksRelations = relations(dutyBlocks, ({ one }) => ({
  tenant: one(tenants, { fields: [dutyBlocks.tenantId], references: [tenants.id] }),
  branch: one(branches, { fields: [dutyBlocks.branchId], references: [branches.id] }),
  employee: one(employees, { fields: [dutyBlocks.employeeId], references: [employees.id] }),
  assignment: one(scheduleAssignments, { fields: [dutyBlocks.assignmentId], references: [scheduleAssignments.id] }),
  dutyType: one(dutyTypes, { fields: [dutyBlocks.dutyTypeId], references: [dutyTypes.id] }),
  creator: one(users, { fields: [dutyBlocks.createdBy], references: [users.id] }),
}));

export const insertDutyBlockSchema = createInsertSchema(dutyBlocks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDutyBlock = z.infer<typeof insertDutyBlockSchema>;
export type DutyBlock = typeof dutyBlocks.$inferSelect;

// ============================================
// XERO INTEGRATION
// ============================================

export const xeroTokens = pgTable("xero_tokens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").references(() => tenants.id),
  xeroTenantId: text("xero_tenant_id"),
  xeroTenantName: text("xero_tenant_name"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  idToken: text("id_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes"),
  connectedBy: varchar("connected_by").references(() => users.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertXeroTokenSchema = createInsertSchema(xeroTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertXeroToken = z.infer<typeof insertXeroTokenSchema>;
export type XeroToken = typeof xeroTokens.$inferSelect;

// ============================================
// XERO FINANCE SYNC
// ============================================

export const xeroSyncRuns = pgTable("xero_sync_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull(),
  syncType: text("sync_type").notNull(),
  fromDate: date("from_date"),
  toDate: date("to_date"),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type XeroSyncRun = typeof xeroSyncRuns.$inferSelect;

export const xeroTrackingCategories = pgTable("xero_tracking_categories", {
  tenantId: text("tenant_id").notNull(),
  trackingCategoryId: text("tracking_category_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  rawJson: jsonb("raw_json").notNull(),
}, (t) => [
  { primaryKey: [t.tenantId, t.trackingCategoryId] },
]);

export type XeroTrackingCategory = typeof xeroTrackingCategories.$inferSelect;

export const xeroTrackingOptions = pgTable("xero_tracking_options", {
  tenantId: text("tenant_id").notNull(),
  trackingCategoryId: text("tracking_category_id").notNull(),
  trackingOptionId: text("tracking_option_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
}, (t) => [
  { primaryKey: [t.tenantId, t.trackingOptionId] },
]);

export type XeroTrackingOption = typeof xeroTrackingOptions.$inferSelect;

export const xeroReportsRaw = pgTable("xero_reports_raw", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id").notNull(),
  reportType: text("report_type").notNull(),
  fromDate: date("from_date").notNull(),
  toDate: date("to_date").notNull(),
  trackingCategoryId: text("tracking_category_id"),
  rawJson: jsonb("raw_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type XeroReportRaw = typeof xeroReportsRaw.$inferSelect;

export const plFacts = pgTable("pl_facts", {
  reportRawId: uuid("report_raw_id").notNull().references(() => xeroReportsRaw.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  fromDate: date("from_date").notNull(),
  toDate: date("to_date").notNull(),
  section: text("section").notNull(),
  lineName: text("line_name").notNull(),
  locationName: text("location_name").notNull(),
  value: numeric("value").notNull(),
});

export type PlFact = typeof plFacts.$inferSelect;

export const cashTxns = pgTable("cash_txns", {
  tenantId: text("tenant_id").notNull(),
  xeroBankTransactionId: text("xero_bank_transaction_id").notNull(),
  date: date("date").notNull(),
  bankAccountName: text("bank_account_name"),
  type: text("type"),
  total: numeric("total").notNull(),
  direction: text("direction").notNull(),
  rawJson: jsonb("raw_json").notNull(),
}, (t) => [
  { primaryKey: [t.tenantId, t.xeroBankTransactionId] },
]);

export type CashTxn = typeof cashTxns.$inferSelect;

export const cashDaily = pgTable("cash_daily", {
  tenantId: text("tenant_id").notNull(),
  date: date("date").notNull(),
  cashIn: numeric("cash_in").notNull().default("0"),
  cashOut: numeric("cash_out").notNull().default("0"),
  net: numeric("net").notNull().default("0"),
}, (t) => [
  { primaryKey: [t.tenantId, t.date] },
]);

export type CashDailyRow = typeof cashDaily.$inferSelect;

// ============================================
// CORE MODULE SCHEMA (Re-export)
// ============================================
export * from "../server/db/coreSchema";

// Explicit named re-exports for static-analysis visibility
// (covered by export * above, but named here for clarity)
export {
  beoSetMenuTemplates,
  insertBeoSetMenuTemplateSchema,
  beoSetMenuSelections,
  insertBeoSetMenuSelectionSchema,
} from "../server/db/coreSchema";
export type {
  BeoSetMenuTemplate,
  InsertBeoSetMenuTemplate,
  BeoSetMenuSelection,
  InsertBeoSetMenuSelection,
} from "../server/db/coreSchema";
