/**
 * Empty seed: tenant + admin user. Nothing else.
 *
 * Usage: script/db-reset.sh empty
 */

import { db } from "../../server/db";
import { tenants, users, userBranchAccess, DEFAULT_TENANT_SLUG } from "../../shared/schema";
import { hashPassword } from "../../server/auth";
import seedUsers from "../../fixtures/users.json" with { type: "json" };

async function seed() {
	console.log("[seed-empty] Starting...");

	// Tenant
	const [tenant] = await db
		.insert(tenants)
		.values({ name: "Default", slug: DEFAULT_TENANT_SLUG })
		.returning();
	console.log("[seed-empty] Created tenant:", tenant.id);

	// Admin user
	const admin = seedUsers.admin;
	const [user] = await db
		.insert(users)
		.values({
			email: admin.email,
			password: await hashPassword(admin.password),
			fullName: admin.fullName,
			role: admin.role,
			mustChangePassword: false,
			phoneNumber: admin.phoneNumber,
			phoneE164: admin.phoneE164,
			phoneVerified: true,
			phoneVerifiedAt: new Date(),
		})
		.returning();
	console.log("[seed-empty] Created admin user:", user.email);

	// Branch access (all branches)
	await db.insert(userBranchAccess).values({
		tenantId: tenant.id,
		userId: user.id,
		branchId: null,
		accessScope: "all_branches",
	});
	console.log("[seed-empty] Granted all_branches access");

	console.log("[seed-empty] Done.");
	console.log(`\n  Login: ${admin.email} / ${admin.password}\n`);
	process.exit(0);
}

seed().catch((err) => {
	console.error("[seed-empty] Fatal error:", err);
	process.exit(1);
});
