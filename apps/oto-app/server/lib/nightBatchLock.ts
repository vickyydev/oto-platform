import type { Pool } from "pg";
import type { NightJobName } from "./nightJobs";

/**
 * One park group's night batch, held while it runs (S2-17b round 3).
 *
 * Two callers take it, so one park group's batch can never run twice at once
 * whoever starts it:
 *
 *  - the platform's job endpoint (`server/directory/jobRoutes.ts`), around
 *    the one park group its key is bound to — a second call answers 409
 *    `job_running`;
 *  - the app's own timers (`runNightBatchInProcess` in
 *    `server/scheduled-jobs.ts`), around each park group in turn — a park
 *    group held elsewhere is skipped. The switch (`OTOAPP_JOBS`) is read per
 *    PROCESS, so two instances that disagree about it (a rolling deploy
 *    across the flip, a second service on the same database) would otherwise
 *    run one night twice side by side (review F4).
 *
 * A session-level advisory lock on a connection of its own: the batch's own
 * statements run on other connections of the pool, and a lock taken on a
 * pooled connection would leave with it. Holding it costs one connection of
 * the app's pool for the length of one park group's batch.
 */

/** Ours, in the two-integer form, beside the platform's `0x070a`… `0x0711` on the same database. */
export const NIGHT_JOB_LOCK_NAMESPACE = 0x0712;

/** The lock's key: the batch and the park group, as both callers name them. */
export function nightBatchLockKey(name: NightJobName, tenantId: string): string {
  return `otoapp_night:${name}:${tenantId}`;
}

/**
 * Hold this park group's batch for the length of one run, or answer null when
 * another run holds it. Throws only when the database cannot be asked.
 */
export async function holdNightBatch(
  pool: Pool,
  name: NightJobName,
  tenantId: string,
): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  const key = nightBatchLockKey(name, tenantId);
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1::int4, hashtext($2)) as locked",
      [NIGHT_JOB_LOCK_NAMESPACE, key],
    );
    if (!rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
  return async () => {
    try {
      await client.query("select pg_advisory_unlock($1::int4, hashtext($2))", [NIGHT_JOB_LOCK_NAMESPACE, key]);
      client.release();
    } catch (error) {
      // Destroying the connection releases its locks with it.
      client.release(error as Error);
    }
  };
}
