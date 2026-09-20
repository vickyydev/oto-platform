import { z } from "zod";

// ============================================
// MODULE REGISTRY
// ============================================

export const MODULE_KEYS = [
  "today",
  "tasks",
  "checklists",
  "scheduling",
  "events",
  "hr",
  "hr_admin",
  "org_chart",
  "reports",
  "settings",
  "studio",
] as const;

export type ModuleKey = typeof MODULE_KEYS[number];

export interface ModuleDefinition {
  key: ModuleKey;
  label: string;
  isBranchScoped: boolean;
  adminOnly: boolean;
  appMode: AppModeKey | null;
}

export type AppModeKey = "core" | "ops" | "events" | "hr" | "studio" | "setup";

export const MODULES: Record<ModuleKey, ModuleDefinition> = {
  today:        { key: "today",        label: "Today",          isBranchScoped: true,  adminOnly: false, appMode: "core" },
  tasks:        { key: "tasks",        label: "Tasks",          isBranchScoped: true,  adminOnly: false, appMode: "ops" },
  checklists:   { key: "checklists",   label: "Checklists",     isBranchScoped: true,  adminOnly: false, appMode: "ops" },
  scheduling:   { key: "scheduling",   label: "Scheduling",     isBranchScoped: true,  adminOnly: false, appMode: "ops" },
  events:       { key: "events",       label: "Events",         isBranchScoped: true,  adminOnly: false, appMode: "events" },
  hr:           { key: "hr",           label: "HR",             isBranchScoped: true,  adminOnly: false, appMode: "hr" },
  hr_admin:     { key: "hr_admin",     label: "HR Admin",       isBranchScoped: false, adminOnly: true,  appMode: "hr" },
  org_chart:    { key: "org_chart",    label: "Org Chart",      isBranchScoped: false, adminOnly: false, appMode: "hr" },
  reports:      { key: "reports",      label: "Reports",        isBranchScoped: true,  adminOnly: false, appMode: "hr" },
  settings:     { key: "settings",     label: "Settings",       isBranchScoped: false, adminOnly: true,  appMode: "setup" },
  studio:       { key: "studio",       label: "Studio",         isBranchScoped: false, adminOnly: false, appMode: "studio" },
};

export const ADMIN_ONLY_ACTIONS = [
  "hr.manage_payroll",
  "hr.edit_salary",
  "hr.edit_contract_templates",
  "hr.terminate_employee",
  "settings.manage_access",
  "settings.manage_roles",
  "settings.delete_data",
] as const;

export type AdminOnlyAction = typeof ADMIN_ONLY_ACTIONS[number];

// Map legacy module access booleans to new module keys
export const LEGACY_MODULE_MAP: Record<string, ModuleKey[]> = {
  core:   ["today"],
  ops:    ["tasks", "checklists", "scheduling"],
  events: ["events"],
  hr:     ["hr", "org_chart", "reports"],
  setup:  ["settings"],
  studio: ["studio"],
};

// Reverse map: module key → app mode
export function getAppModeForModule(moduleKey: ModuleKey): AppModeKey | null {
  return MODULES[moduleKey]?.appMode ?? null;
}

// ============================================
// ROLE TYPES
// ============================================

export type PermissionRole = "staff" | "manager" | "admin" | "operator_admin" | "global_admin";

// ============================================
// ADVISOR ROLE NORMALISATION
// ============================================

/**
 * Map an advisor's accessLevel string (STAFF / MANAGER / ADMIN) to the
 * equivalent PermissionRole.  Call this before constructing a
 * PermissionUserContext when the raw DB role value may be "advisor".
 *
 * If the caller already has the effective role from getUserWithBranchAccess
 * this function is never reached; it exists as a belt-and-suspenders safety
 * net for any code path that builds a PermissionUserContext directly from the
 * raw users table row.
 */
export function resolveAdvisorRole(
  rawRole: string,
  accessLevel?: string | null
): PermissionRole {
  if (rawRole !== "advisor") {
    return rawRole as PermissionRole;
  }
  if (!accessLevel) return "staff";
  switch (accessLevel.toUpperCase()) {
    case "ADMIN":   return "admin";
    case "MANAGER": return "manager";
    case "STAFF":
    default:        return "staff";
  }
}

export const BRANCH_SCOPE_TYPES = ["HOME_ONLY", "ALL", "CUSTOM"] as const;
export type BranchScopeType = typeof BRANCH_SCOPE_TYPES[number];

// ============================================
// OVERRIDE TYPES
// ============================================

export interface ModuleOverride {
  id?: string;
  userId: string;
  moduleKey: ModuleKey;
  enabled: boolean;
  branchScopeType: BranchScopeType;
  branchIds: string[];
  notes?: string | null;
  updatedBy?: string | null;
  updatedAt?: Date | string | null;
}

export const moduleOverrideSchema = z.object({
  moduleKey: z.enum(MODULE_KEYS),
  enabled: z.boolean(),
  branchScopeType: z.enum(BRANCH_SCOPE_TYPES),
  branchIds: z.array(z.string()).default([]),
  notes: z.string().optional().nullable(),
});

// ============================================
// PERMISSION RESULT TYPES
// ============================================

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  source: "role_default" | "override" | "admin_bypass";
  effectiveBranchScope: BranchScopeType;
  effectiveBranchIds: string[];
}

export interface EffectiveModulePermission {
  moduleKey: ModuleKey;
  label: string;
  allowed: boolean;
  reason: string;
  source: "role_default" | "override" | "admin_bypass";
  branchScope: BranchScopeType;
  branchIds: string[];
  hasOverride: boolean;
  override?: ModuleOverride;
  roleDefault: boolean;
}

export interface EffectivePermissions {
  userId: string;
  role: PermissionRole;
  homeBranchId: string | null;
  modules: EffectiveModulePermission[];
  appModes: AppModeKey[];
}

// ============================================
// USER CONTEXT (input to permission engine)
// ============================================

export interface PermissionUserContext {
  userId: string;
  role: PermissionRole;
  homeBranchId: string | null;
  overrides: ModuleOverride[];
}

// ============================================
// ROLE DEFAULTS
// ============================================

const STAFF_DEFAULT_MODULES: ModuleKey[] = ["today"];
const MANAGER_DEFAULT_MODULES: ModuleKey[] = [
  "today", "tasks", "checklists", "scheduling", "events",
  "hr", "org_chart", "reports",
];
const ADMIN_DEFAULT_MODULES: ModuleKey[] = MODULE_KEYS.filter(() => true) as unknown as ModuleKey[];

/**
 * Normalise a raw role string at the permission-engine boundary.
 * If "advisor" slips through (e.g. from a code path that uses the raw DB row
 * instead of UserWithBranchAccess), treat it as the safe minimum — "staff".
 * All other unrecognised strings are also mapped to "staff".
 */
function normaliseRole(role: string): PermissionRole {
  switch (role) {
    case "global_admin":
    case "admin":
    case "operator_admin":
    case "manager":
    case "staff":
      return role as PermissionRole;
    default:
      // "advisor" and any other unrecognised value → staff (safest fallback)
      return "staff";
  }
}

function getRoleDefaultModules(role: PermissionRole): ModuleKey[] {
  switch (normaliseRole(role)) {
    case "global_admin":
    case "admin":
      return [...ADMIN_DEFAULT_MODULES];
    case "operator_admin":
      return [...ADMIN_DEFAULT_MODULES];
    case "manager":
      return [...MANAGER_DEFAULT_MODULES];
    case "staff":
    default:
      return [...STAFF_DEFAULT_MODULES];
  }
}

function getRoleDefaultBranchScope(role: PermissionRole): BranchScopeType {
  switch (normaliseRole(role)) {
    case "global_admin":
    case "admin":
    case "operator_admin":
    case "manager":
      return "ALL";
    case "staff":
    default:
      return "HOME_ONLY";
  }
}

function isRoleDefaultAllowed(role: PermissionRole, moduleKey: ModuleKey): boolean {
  const defaults = getRoleDefaultModules(role);
  return defaults.includes(moduleKey);
}

// ============================================
// CENTRAL PERMISSION ENGINE
// ============================================

export function canAccessModule(
  ctx: PermissionUserContext,
  moduleKey: ModuleKey,
  branchId?: string | null
): PermissionResult {
  const moduleDef = MODULES[moduleKey];
  if (!moduleDef) {
    return { allowed: false, reason: `Unknown module: ${moduleKey}`, source: "role_default", effectiveBranchScope: "HOME_ONLY", effectiveBranchIds: [] };
  }

  // Normalise role at the engine boundary so "advisor" (raw DB value) never
  // silently falls through to unintended defaults.
  const role = normaliseRole(ctx.role as string);
  const normCtx: PermissionUserContext = role === ctx.role ? ctx : { ...ctx, role };

  // Admin bypass: global_admin and admin always allowed
  if (normCtx.role === "global_admin" || normCtx.role === "admin") {
    return {
      allowed: true,
      reason: "Admin: full access",
      source: "admin_bypass",
      effectiveBranchScope: "ALL",
      effectiveBranchIds: [],
    };
  }

  // Check for override
  const override = normCtx.overrides.find((o) => o.moduleKey === moduleKey);

  if (override) {
    if (!override.enabled) {
      return {
        allowed: false,
        reason: `Denied: module override disabled for ${moduleDef.label}`,
        source: "override",
        effectiveBranchScope: override.branchScopeType,
        effectiveBranchIds: override.branchIds,
      };
    }

    // Override enabled - check branch scope if branch-scoped module and branchId provided
    const branchResult = checkBranchAccess(normCtx, override.branchScopeType, override.branchIds, branchId, moduleDef);
    return {
      allowed: branchResult.allowed,
      reason: branchResult.allowed
        ? `Allowed: module override enabled (${override.branchScopeType})`
        : branchResult.reason,
      source: "override",
      effectiveBranchScope: override.branchScopeType,
      effectiveBranchIds: override.branchIds,
    };
  }

  // No override - use role defaults
  const roleAllowed = isRoleDefaultAllowed(normCtx.role, moduleKey);
  if (!roleAllowed) {
    return {
      allowed: false,
      reason: `Denied: ${normCtx.role} role does not include ${moduleDef.label}`,
      source: "role_default",
      effectiveBranchScope: getRoleDefaultBranchScope(normCtx.role),
      effectiveBranchIds: [],
    };
  }

  // Role allows - check admin-only module restriction for non-admin roles
  if (moduleDef.adminOnly && normCtx.role !== "operator_admin") {
    return {
      allowed: false,
      reason: `Denied: ${moduleDef.label} is admin-only`,
      source: "role_default",
      effectiveBranchScope: getRoleDefaultBranchScope(normCtx.role),
      effectiveBranchIds: [],
    };
  }

  // Role allows and module is not admin-only - check branch access
  const defaultBranchScope = getRoleDefaultBranchScope(normCtx.role);
  const branchResult = checkBranchAccess(normCtx, defaultBranchScope, [], branchId, moduleDef);
  return {
    allowed: branchResult.allowed,
    reason: branchResult.allowed
      ? `Allowed: ${normCtx.role} role default`
      : branchResult.reason,
    source: "role_default",
    effectiveBranchScope: defaultBranchScope,
    effectiveBranchIds: defaultBranchScope === "HOME_ONLY" && normCtx.homeBranchId ? [normCtx.homeBranchId] : [],
  };
}

function checkBranchAccess(
  ctx: PermissionUserContext,
  scopeType: BranchScopeType,
  branchIds: string[],
  requestedBranchId: string | null | undefined,
  moduleDef: ModuleDefinition
): { allowed: boolean; reason: string } {
  if (!moduleDef.isBranchScoped) {
    return { allowed: true, reason: "Module is not branch-scoped" };
  }

  if (!requestedBranchId) {
    return { allowed: true, reason: "No specific branch requested" };
  }

  switch (scopeType) {
    case "ALL":
      return { allowed: true, reason: "All branches allowed" };
    case "HOME_ONLY":
      if (!ctx.homeBranchId) {
        return { allowed: false, reason: "Denied: no home branch assigned" };
      }
      if (requestedBranchId === ctx.homeBranchId) {
        return { allowed: true, reason: "Allowed: home branch" };
      }
      return { allowed: false, reason: `Denied: branch ${requestedBranchId} is not home branch` };
    case "CUSTOM":
      if (branchIds.includes(requestedBranchId)) {
        return { allowed: true, reason: "Allowed: branch in custom list" };
      }
      return { allowed: false, reason: `Denied: branch ${requestedBranchId} not in allowed list` };
    default:
      return { allowed: false, reason: "Unknown branch scope type" };
  }
}

export function canPerformAction(
  ctx: PermissionUserContext,
  actionKey: string,
  moduleKey: ModuleKey,
  branchId?: string | null
): PermissionResult {
  const role = normaliseRole(ctx.role as string);
  const normCtx: PermissionUserContext = role === ctx.role ? ctx : { ...ctx, role };

  // First check module access
  const moduleResult = canAccessModule(normCtx, moduleKey, branchId);
  if (!moduleResult.allowed) {
    return moduleResult;
  }

  // Admin bypass
  if (normCtx.role === "global_admin" || normCtx.role === "admin") {
    return {
      allowed: true,
      reason: "Admin: full access to all actions",
      source: "admin_bypass",
      effectiveBranchScope: "ALL",
      effectiveBranchIds: [],
    };
  }

  // Check admin-only actions
  if ((ADMIN_ONLY_ACTIONS as readonly string[]).includes(actionKey)) {
    if (normCtx.role === "operator_admin") {
      return {
        ...moduleResult,
        allowed: true,
        reason: "Operator admin: allowed admin-only action",
      };
    }
    return {
      allowed: false,
      reason: `Denied: ${actionKey} is an admin-only action`,
      source: "role_default",
      effectiveBranchScope: moduleResult.effectiveBranchScope,
      effectiveBranchIds: moduleResult.effectiveBranchIds,
    };
  }

  return moduleResult;
}

// ============================================
// COMPUTE EFFECTIVE PERMISSIONS
// ============================================

export function getEffectivePermissions(ctx: PermissionUserContext): EffectivePermissions {
  // Normalise role at the engine entry point so any raw "advisor" value from DB
  // rows that bypassed getUserWithBranchAccess still resolves to a valid role.
  const role = normaliseRole(ctx.role as string);
  const normCtx: PermissionUserContext = role === ctx.role ? ctx : { ...ctx, role };

  const modules: EffectiveModulePermission[] = MODULE_KEYS.map((key) => {
    const moduleDef = MODULES[key];
    const override = normCtx.overrides.find((o) => o.moduleKey === key);
    const result = canAccessModule(normCtx, key);
    const roleDefault = isRoleDefaultAllowed(normCtx.role, key) && (!moduleDef.adminOnly || normCtx.role === "admin" || normCtx.role === "global_admin" || normCtx.role === "operator_admin");

    return {
      moduleKey: key,
      label: moduleDef.label,
      allowed: result.allowed,
      reason: result.reason,
      source: result.source,
      branchScope: result.effectiveBranchScope,
      branchIds: result.effectiveBranchIds,
      hasOverride: !!override,
      override,
      roleDefault,
    };
  });

  // Compute app modes from allowed modules
  const appModes = new Set<AppModeKey>();
  for (const mod of modules) {
    if (mod.allowed && MODULES[mod.moduleKey].appMode) {
      appModes.add(MODULES[mod.moduleKey].appMode!);
    }
  }

  return {
    userId: normCtx.userId,
    role: normCtx.role,
    homeBranchId: normCtx.homeBranchId,
    modules,
    appModes: Array.from(appModes),
  };
}

// ============================================
// UTILITY: Check if user can access an app mode
// ============================================

export function canAccessAppMode(ctx: PermissionUserContext, mode: AppModeKey): boolean {
  const perms = getEffectivePermissions(ctx);
  return perms.appModes.includes(mode);
}

// ============================================
// UTILITY: Get allowed branch IDs for a module
// ============================================

export function getAllowedBranchIdsForModule(
  ctx: PermissionUserContext,
  moduleKey: ModuleKey,
  allBranchIds: string[]
): string[] | null {
  const result = canAccessModule(ctx, moduleKey);
  if (!result.allowed) return [];
  
  switch (result.effectiveBranchScope) {
    case "ALL":
      return null; // null means all branches
    case "HOME_ONLY":
      return ctx.homeBranchId ? [ctx.homeBranchId] : [];
    case "CUSTOM":
      return result.effectiveBranchIds;
    default:
      return [];
  }
}
