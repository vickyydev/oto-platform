import type { Pool } from "pg";

/**
 * Deleting a user of the app — the last step of `DELETE /api/users/:id`, after
 * the route's own checks (tenant, self, managed role, HR record) have passed
 * (S2-17b round 1, plan section 4 and H28) — and the ONLY way the app deletes
 * a user: `DELETE /api/people/:id`, `DELETE /api/employees/:id` and
 * `POST /api/employees/bulk-delete` take the user matched by email through
 * here too, first, before writing anything of their own, so a refusal leaves
 * them untouched. The storage layer has no user delete of its own.
 *
 * TWO CASES THE ROUTE MET WITH A BARE 500, OR NOT AT ALL.
 *
 *  1. A user something in the app still points at. `users.id` is referenced
 *     with `ON DELETE no action` from across the schema — module overrides,
 *     tasks, contracts, activity — so the delete failed on a foreign key and
 *     the route answered "Internal Server Error". Worse, the branch-access
 *     rows were deleted first as a separate statement, so the refusal left
 *     the user behind with no branch access at all. Now the two deletes are
 *     one transaction, and a foreign-key refusal is answered with the app's
 *     own 409 words and changes nothing.
 *
 *  2. A user the platform has linked (`platform_user_id`). The platform's
 *     `core.app_identity` names this user as somebody's way into the app, and
 *     deleting it would leave that row pointing at nothing — the person's
 *     launcher tile would open onto a refusal, and nothing would say why. The
 *     app already refuses a user with an employee or person record in these
 *     words; a platform-linked user is refused the same way. Unlinking is the
 *     Console's act, and after it the user can be deleted here as before.
 *
 * The answer is the app's existing sentence, unchanged, so a screen that
 * already shows it needs nothing new. `reason` says which case it was, for
 * logs and tests; the screen reads `message`.
 *
 * Plain `pg` and unqualified table names, like the directory writes: the pool
 * carries `search_path=otoapp`, and this module imports nothing from the app's
 * Drizzle setup so the platform's tests can run it against the real schema.
 */

/** The app's own words for a user it will not delete (`server/routes.ts`, `DELETE /api/users/:id`). */
export const DEACTIVATE_INSTEAD = "Deactivate this account to preserve its HR record";

export type UserDeletionOutcome =
  | { deleted: true }
  | { deleted: false; status: 404; message: string }
  | {
      deleted: false;
      status: 409;
      message: string;
      reason: "linked_to_platform" | "still_referenced";
    };

/** Postgres' code for a foreign-key refusal. */
const FOREIGN_KEY_VIOLATION = "23503";

export async function deleteManagedUser(pool: Pool, userId: string): Promise<UserDeletionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Locked, so a link written by the platform between this read and the
    // delete waits for this transaction rather than being deleted under it.
    const { rows } = await client.query<{ platform_user_id: string | null }>(
      "select platform_user_id::text as platform_user_id from users where id = $1 for update",
      [userId],
    );
    const user = rows[0];
    if (!user) {
      await client.query("rollback");
      return { deleted: false, status: 404, message: "User not found" };
    }
    if (user.platform_user_id) {
      await client.query("rollback");
      return { deleted: false, status: 409, message: DEACTIVATE_INSTEAD, reason: "linked_to_platform" };
    }
    try {
      await client.query("delete from user_branch_access where user_id = $1", [userId]);
      await client.query("delete from users where id = $1", [userId]);
    } catch (err) {
      await client.query("rollback");
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        return { deleted: false, status: 409, message: DEACTIVATE_INSTEAD, reason: "still_referenced" };
      }
      throw err;
    }
    await client.query("commit");
    return { deleted: true };
  } catch (err) {
    // Already rolled back above when it was ours to answer; a second rollback
    // on an aborted or finished transaction is harmless and keeps the
    // connection clean for the next borrower.
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
