import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Which of a park group's branches the platform has archived (SCRUM-749).
 *
 * The app's `branches` rows carry no archived flag of their own: a park is
 * archived on the platform (`core.branch.archived_at`), and the platform leaves
 * the app row in place on purpose, because the app's history hangs off it
 * (`packages/db/src/schema/otoapp.ts`). The row's `core_branch_id` names the
 * platform branch, so the platform's flag is read through it, by id. A row with
 * no `core_branch_id` (Head Office, which trades nowhere, and any row the
 * platform has not mapped) is never archived here.
 *
 * Where the platform's table cannot be read, the answer is "none archived" and
 * everything behaves exactly as it did before this was read: an app-only
 * installation has no `core` schema at all, and a database identity of the
 * app's own holds no privilege on it. That is said once in the log, so a
 * deployment that cannot see the flag is visible, and nothing on the floor
 * stops working because of it.
 */

/** Postgres codes for "this installation cannot read the platform's branch table". */
const PLATFORM_UNREADABLE = new Set([
  "3F000", // invalid_schema_name: no `core` schema (an app-only installation)
  "42P01", // undefined_table
  "42703", // undefined_column
  "42501", // insufficient_privilege: the app's own database identity
]);

let reportedUnreadable = false;

export async function archivedBranchIds(tenantId: string): Promise<Set<string>> {
  try {
    const result = await db.execute<{ id: string }>(sql`
      select b.id
        from branches b
        join core.branch platform_branch on platform_branch.id::text = lower(b.core_branch_id)
       where b.tenant_id = ${tenantId}
         and b.core_branch_id is not null
         and platform_branch.archived_at is not null`);
    return new Set(result.rows.map((row) => String(row.id)));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && PLATFORM_UNREADABLE.has(code)) {
      if (!reportedUnreadable) {
        reportedUnreadable = true;
        console.warn(`[PLATFORM_BRANCHES] The platform's branch table is not readable here (${code}); archived branches are treated as open`);
      }
      return new Set();
    }
    throw error;
  }
}
