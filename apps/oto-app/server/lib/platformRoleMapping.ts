import type { Branch, Operator, User, UserWithBranchAccess } from "@shared/schema";
import { PlatformRoleMappingError, readOtoAppRoleContext } from "@shared/platformRoleMapping";

interface PlatformRoleSession {
  accountId: string;
  otoApp?: unknown;
}

interface RoleIdentityReader {
  getUser(id: string): Promise<User | undefined>;
  getUserWithBranchAccess(id: string, trustedTenant?: { tenantId: string }): Promise<UserWithBranchAccess | undefined>;
  getOperator(id: string): Promise<Pick<Operator, "id" | "tenantId" | "platformRolesEnabled"> | undefined>;
  getBranch(id: string): Promise<Pick<Branch, "id" | "tenantId"> | undefined>;
}

function requireBinding(value: unknown): asserts value {
  if (!value) throw new PlatformRoleMappingError();
}

/** Resolve a mapped session without changing the app's raw advisor identity or access policy. */
export async function loadPlatformUserWithBranchAccess(
  userId: string,
  platform: PlatformRoleSession | undefined,
  reader: RoleIdentityReader,
): Promise<UserWithBranchAccess | undefined> {
  const context = readOtoAppRoleContext(platform?.otoApp);
  if (!context) return reader.getUserWithBranchAccess(userId);

  const raw = await reader.getUser(userId);
  requireBinding(raw?.isActive && raw.id === context.userId && raw.platformUserId === platform?.accountId
    && raw.operatorId === context.operatorId);
  const operator = await reader.getOperator(context.operatorId);
  requireBinding(operator?.id === context.operatorId && operator.tenantId === context.tenantId
    && operator.platformRolesEnabled === true);
  const user = await reader.getUserWithBranchAccess(userId, { tenantId: context.tenantId });
  if (!user) return undefined;
  requireBinding(user.branchAccess.every(row => row.userId === raw.id && row.tenantId === context.tenantId));

  const explicitBranches = [...new Set(user.branchAccess.flatMap(row => row.branchId ? [row.branchId] : []))];
  const policyBranches = raw.role === "advisor" ? user.allowedBranchIds : [];
  for (const branchId of new Set([...explicitBranches, ...policyBranches])) {
    const branch = await reader.getBranch(branchId);
    requireBinding(branch?.id === branchId && branch.tenantId === context.tenantId);
  }
  // The platform's identity seam owns ordinary persisted role writes. A stale or
  // mismatched exchange must not turn this app into a second role writer.
  requireBinding(raw.role === "advisor" || raw.role === context.role);
  const allBranches = raw.role === "advisor" ? user.hasAllBranchesAccess
    : user.branchAccess.some(row => row.accessScope === "all_branches");
  const allowedBranchIds = raw.role === "advisor" ? [...user.allowedBranchIds] : explicitBranches;
  return { ...user, role: context.role, tenantId: context.tenantId,
    hasAllBranchesAccess: allBranches, allowedBranchIds: allBranches ? [] : allowedBranchIds,
    platformRoleMapping: context };
}
