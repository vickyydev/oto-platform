import { Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import type { UserWithBranchAccess, Branch } from "@shared/schema";
import { getEffectivePermissions, type ModuleKey, type PermissionUserContext, type PermissionRole } from "../shared/permissions";

// Extended role system with operator support
export type UserRole = "global_admin" | "operator_admin" | "admin" | "manager" | "staff";

// Check if user has global admin level access (global_admin or legacy admin)
export function isGlobalAdmin(user: UserWithBranchAccess): boolean {
  return user.role === "global_admin" || user.role === "admin";
}

// Check if user is operator admin
export function isOperatorAdmin(user: UserWithBranchAccess): boolean {
  return user.role === "operator_admin";
}

// Check if user has admin-level access (global, operator, or legacy admin)
export function isAnyAdmin(user: UserWithBranchAccess): boolean {
  return isGlobalAdmin(user) || isOperatorAdmin(user);
}

// Authorization helper: Get allowed operator and branch IDs based on user role
export interface AllowedScope {
  operatorIds: string[] | null;  // null means all operators
  branchIds: string[] | null;     // null means all branches
  isGlobalAdmin: boolean;
  isOperatorAdmin: boolean;
}

export async function getAllowedOperatorAndBranchIds(user: UserWithBranchAccess): Promise<AllowedScope> {
  // Global admins (or legacy admin) have full access
  if (isGlobalAdmin(user)) {
    return {
      operatorIds: null,
      branchIds: null,
      isGlobalAdmin: true,
      isOperatorAdmin: false,
    };
  }

  // Operator admins have access to their operator's branches
  if (isOperatorAdmin(user) && user.operatorId) {
    const branches = await storage.getBranchesByOperator(user.operatorId);
    return {
      operatorIds: [user.operatorId],
      branchIds: branches.map(b => b.id),
      isGlobalAdmin: false,
      isOperatorAdmin: true,
    };
  }

  // Regular users (manager/staff) use their configured branch access
  return {
    operatorIds: [], // No operator-level access
    branchIds: user.hasAllBranchesAccess ? null : user.allowedBranchIds,
    isGlobalAdmin: false,
    isOperatorAdmin: false,
  };
}

// Filter branches based on user's allowed scope
export function filterBranchesByScope(branches: Branch[], scope: AllowedScope): Branch[] {
  if (scope.branchIds === null) {
    return branches; // All branches allowed
  }
  return branches.filter(b => scope.branchIds!.includes(b.id));
}

declare global {
  namespace Express {
    interface Request {
      userWithAccess?: UserWithBranchAccess;
    }
  }
}

export async function loadUserWithAccess(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated() && req.user) {
    const userWithAccess = await storage.getUserWithBranchAccess(req.user.id);
    if (userWithAccess) {
      req.userWithAccess = userWithAccess;
    }
  }
  next();
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const userWithAccess = req.userWithAccess;
    if (!userWithAccess) {
      return res.status(403).json({ error: "User access data not loaded" });
    }

    if (!userWithAccess.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    if (!allowedRoles.includes(userWithAccess.role as UserRole)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
}

// Require global admin access (global_admin or legacy admin)
export function requireGlobalAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const userWithAccess = req.userWithAccess;
  if (!userWithAccess) {
    return res.status(403).json({ error: "User access data not loaded" });
  }
  if (!userWithAccess.isActive) {
    return res.status(403).json({ error: "Account is deactivated" });
  }
  if (!isGlobalAdmin(userWithAccess)) {
    return res.status(403).json({ error: "Global admin access required" });
  }
  next();
}

// Legacy requireAdmin - now includes global_admin, operator_admin, and legacy admin
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  return requireRole("global_admin", "operator_admin", "admin")(req, res, next);
}

// Require manager or admin level access
export function requireManager(req: Request, res: Response, next: NextFunction) {
  return requireRole("global_admin", "operator_admin", "admin", "manager")(req, res, next);
}

export function canUserAccessBranch(user: UserWithBranchAccess, branchId: string | null): boolean {
  if (user.hasAllBranchesAccess) {
    return true;
  }
  if (branchId === null) {
    return false;
  }
  return user.allowedBranchIds.includes(branchId);
}

export function requireBranchAccess(getBranchId: (req: Request) => string | null | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const userWithAccess = req.userWithAccess;
    if (!userWithAccess) {
      return res.status(403).json({ error: "User access data not loaded" });
    }

    const branchId = getBranchId(req);
    
    if (branchId === undefined) {
      return next();
    }

    if (!canUserAccessBranch(userWithAccess, branchId)) {
      return res.status(403).json({ error: "Access denied to this branch" });
    }

    next();
  };
}

export function filterByUserBranches<T extends { branchId?: string | null }>(
  items: T[],
  user: UserWithBranchAccess
): T[] {
  if (user.hasAllBranchesAccess) {
    return items;
  }
  return items.filter(item => 
    item.branchId && user.allowedBranchIds.includes(item.branchId)
  );
}

export function getUserAllowedBranchIds(user: UserWithBranchAccess): string[] | null {
  if (user.hasAllBranchesAccess) {
    return null;
  }
  return user.allowedBranchIds;
}

// ============================================
// DIRECTORY API - Service-to-Service Authentication
// ============================================

const HR_API_KEY_HEADER = "x-hr-api-key";

// Rate limiting store for Directory API (configurable via environment variables)
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const rateLimitStore = new Map<string, RateLimitEntry>();

// Configurable rate limits via environment variables
function getRateLimitWindowMs(): number {
  const windowSeconds = parseInt(process.env.DIRECTORY_API_RATE_LIMIT_WINDOW_SECONDS || "60", 10);
  return windowSeconds * 1000;
}

function getRateLimitMaxRequests(): number {
  return parseInt(process.env.DIRECTORY_API_RATE_LIMIT_MAX_REQUESTS || "100", 10);
}

function cleanupRateLimitStore() {
  const now = Date.now();
  const keysToDelete: string[] = [];
  rateLimitStore.forEach((entry, key) => {
    if (entry.resetAt < now) {
      keysToDelete.push(key);
    }
  });
  keysToDelete.forEach(key => rateLimitStore.delete(key));
}

// Cleanup every 5 minutes
setInterval(cleanupRateLimitStore, 5 * 60 * 1000);

export function requireDirectoryApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers[HR_API_KEY_HEADER] as string | undefined;
  
  if (!apiKey) {
    return res.status(401).json({ 
      error: "Authentication required", 
      message: "Missing X-HR-API-KEY header" 
    });
  }

  const expectedApiKey = process.env.HR_DIRECTORY_API_KEY;
  
  if (!expectedApiKey) {
    console.error("HR_DIRECTORY_API_KEY environment variable not set");
    return res.status(500).json({ 
      error: "Service configuration error", 
      message: "API key not configured on server" 
    });
  }

  if (apiKey !== expectedApiKey) {
    return res.status(403).json({ 
      error: "Invalid API key", 
      message: "The provided API key is not valid" 
    });
  }

  next();
}

// ============================================
// MODULE-LEVEL PERMISSION MIDDLEWARE
// ============================================

export function requireModule(...moduleKeys: ModuleKey[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const user = req.user;
    if (!user.isActive) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    try {
      const tenantId = user.tenantId || "default";
      const overrides = await storage.getModuleOverrides(user.id);
      const employees = await storage.getEmployees(tenantId);
      const linkedEmployee = employees.find(e => e.userId === user.id);

      // Prefer the effective role from userWithAccess (which resolves "advisor" →
      // staff/manager/admin based on the access policy) over req.user.role which
      // always contains the raw DB value "advisor".
      const effectiveRole = (req.userWithAccess?.role ?? user.role) as PermissionRole;

      const ctx: PermissionUserContext = {
        userId: user.id,
        role: effectiveRole,
        homeBranchId: linkedEmployee?.branchId || null,
        overrides: overrides.map(o => ({
          id: o.id,
          userId: o.userId,
          moduleKey: o.moduleKey as ModuleKey,
          enabled: o.enabled,
          branchScopeType: o.branchScopeType as any,
          branchIds: (o.branchIds || []) as string[],
          notes: o.notes,
          updatedBy: o.updatedBy,
          updatedAt: o.updatedAt,
        })),
      };

      const effective = getEffectivePermissions(ctx);
      const hasAccess = moduleKeys.some(key => {
        const mod = effective.modules.find(m => m.moduleKey === key);
        return mod?.allowed;
      });

      if (!hasAccess) {
        return res.status(403).json({
          error: "Module access denied",
          required: moduleKeys,
        });
      }

      next();
    } catch (error) {
      console.error("Permission check error:", error);
      next(error);
    }
  };
}

export function directoryApiRateLimit(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers[HR_API_KEY_HEADER] as string || "unknown";
  const now = Date.now();
  const windowMs = getRateLimitWindowMs();
  const maxRequests = getRateLimitMaxRequests();
  
  let entry = rateLimitStore.get(apiKey);
  
  if (!entry || entry.resetAt < now) {
    entry = { count: 1, resetAt: now + windowMs };
    rateLimitStore.set(apiKey, entry);
  } else {
    entry.count++;
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfter.toString());
      return res.status(429).json({
        error: "Too many requests",
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        retryAfter,
      });
    }
  }

  res.setHeader("X-RateLimit-Limit", maxRequests.toString());
  res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - entry.count).toString());
  res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000).toString());

  next();
}
