import { db, pool } from "../server/db";
import { 
  tenants, 
  DEFAULT_TENANT_SLUG,
  operators,
  branches,
  users,
} from "../shared/schema";
import { eq, isNull, count } from "drizzle-orm";
import { assertDevEnv } from "../server/config/env";

assertDevEnv();

async function getDefaultTenantId(): Promise<string> {
  const existing = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);

  if (existing.length === 0) {
    throw new Error("Default tenant not found. Run backfillTenant.ts first.");
  }

  return existing[0].id;
}

async function createTTConceptOperator(tenantId: string): Promise<string> {
  const operatorName = "T&T Concept Co., Ltd.";
  
  const existing = await db
    .select()
    .from(operators)
    .where(eq(operators.name, operatorName))
    .limit(1);

  if (existing.length > 0) {
    console.log(`Operator "${operatorName}" already exists: ${existing[0].id}`);
    return existing[0].id;
  }

  const [newOperator] = await db
    .insert(operators)
    .values({
      tenantId,
      name: operatorName,
      status: "active",
    })
    .returning();

  console.log(`Created operator "${operatorName}": ${newOperator.id}`);
  return newOperator.id;
}

async function assignBranchesToOperator(operatorId: string): Promise<{ updated: number }> {
  const branchesWithoutOperator = await db
    .select()
    .from(branches)
    .where(isNull(branches.operatorId));

  if (branchesWithoutOperator.length === 0) {
    console.log("All branches already have operators assigned.");
    return { updated: 0 };
  }

  const branchIds = branchesWithoutOperator.map(b => b.id);
  
  await db
    .update(branches)
    .set({ operatorId })
    .where(isNull(branches.operatorId));

  console.log(`Assigned ${branchesWithoutOperator.length} branches to operator:`);
  branchesWithoutOperator.forEach(b => {
    console.log(`  - ${b.name} (${b.id})`);
  });

  return { updated: branchesWithoutOperator.length };
}

async function upgradeAdminUsersToGlobalAdmin(): Promise<{ updated: number }> {
  const adminUsers = await db
    .select()
    .from(users)
    .where(eq(users.role, "admin"));

  if (adminUsers.length === 0) {
    console.log("No admin users to upgrade.");
    return { updated: 0 };
  }

  await db
    .update(users)
    .set({ role: "global_admin" })
    .where(eq(users.role, "admin"));

  console.log(`Upgraded ${adminUsers.length} admin users to global_admin:`);
  adminUsers.forEach(u => {
    console.log(`  - ${u.fullName} (${u.email})`);
  });

  return { updated: adminUsers.length };
}

async function main() {
  console.log("=".repeat(60));
  console.log("Operator Setup Migration");
  console.log("=".repeat(60));

  try {
    const tenantId = await getDefaultTenantId();
    console.log(`Using tenant: ${tenantId}`);

    const operatorId = await createTTConceptOperator(tenantId);

    const branchResult = await assignBranchesToOperator(operatorId);
    console.log(`Branches updated: ${branchResult.updated}`);

    const userResult = await upgradeAdminUsersToGlobalAdmin();
    console.log(`Users upgraded: ${userResult.updated}`);

    console.log("=".repeat(60));
    console.log("Migration complete!");
    console.log("=".repeat(60));

  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
