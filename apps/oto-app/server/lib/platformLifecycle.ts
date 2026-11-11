import type { Pool } from "pg";
import { z } from "zod";
import type { SuiteProvisionConfig } from "./suiteSignIn";

export interface PlatformLifecycleDependencies {
  database: Pick<Pool, "query">;
  config: SuiteProvisionConfig | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}
export interface PlatformLifecycleSummary {
  selected: number;
  delivered: number;
  superseded: number;
  failed: number;
}
// SCRUM-778/810: a durable schedule, including after a process restart. A null
// next_attempt_at parks the pending row for review; it never means immediate retry.
export const LIFECYCLE_MAX_ATTEMPTS = 6;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 15 * 60;
// SCRUM-769 (migration 0044): an event is a switch-off ('deactivate', every
// event before 0044) or a restriction to pay only ('restrict'), each consumed
// on its own platform door. A row read without the column is a switch-off.
const pendingEvent = z.object({
  id: z.string().uuid(), user_id: z.string().min(1), platform_account_id: z.string().uuid(), state: z.literal("pending"),
  kind: z.enum(["deactivate", "restrict"]).default("deactivate"),
}).strict();
const DOORS = {
  deactivate: "/admin/apps/oto_app/lifecycle-deactivations",
  restrict: "/admin/apps/oto_app/lifecycle-restrictions",
} as const;
const acknowledgement = z.object({
  ok: z.literal(true), eventId: z.string().uuid(), state: z.enum(["delivered", "superseded"]), replayed: z.boolean(),
}).strict();

function endpoint(config: SuiteProvisionConfig | null, kind: keyof typeof DOORS): string | null {
  if (!config || !config.key.trim()) return null;
  try {
    const url = new URL(config.apiUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin + DOORS[kind];
  } catch { return null; }
}

/** No transaction or row lock survives HTTP. Deleted logins settle in the app's delete transaction. */
export async function drainPlatformLifecycleEvents(
  dependencies: PlatformLifecycleDependencies,
  limit = 25,
): Promise<PlatformLifecycleSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("LIFECYCLE_BATCH_LIMIT_INVALID");
  const { database } = dependencies;
  const summary: PlatformLifecycleSummary = { selected: 0, delivered: 0, superseded: 0, failed: 0 };
  let rows: unknown[];
  try {
    rows = (await database.query(`SELECT id,user_id,platform_account_id,state,kind FROM login_lifecycle_events
      WHERE state='pending' AND next_attempt_at <= now() AND attempt_count < $2
      ORDER BY next_attempt_at,created_at,id LIMIT $1`, [limit, LIFECYCLE_MAX_ATTEMPTS])).rows;
  } catch { summary.failed++; return summary; }
  summary.selected = rows.length;
  for (const row of rows) {
    const parsed = pendingEvent.safeParse(row);
    if (!parsed.success) { summary.failed++; continue; }
    const event = parsed.data;
    const url = endpoint(dependencies.config, event.kind);
    let failure: string | null = null;
    try {
      // Claim the next due attempt atomically. Another process cannot claim the
      // same due row, and a crash retains its backoff or final parking reason.
      const attempt = await database.query(`UPDATE login_lifecycle_events
        SET attempt_count=attempt_count+1,
          next_attempt_at=CASE WHEN attempt_count+1 >= $2 THEN NULL
            ELSE now()+make_interval(secs => least($4,$3*power(2,attempt_count))::integer) END,
          last_error_code=CASE WHEN attempt_count+1 >= $2 THEN 'RETRY_LIMIT_REACHED' ELSE last_error_code END
        WHERE id=$1 AND state='pending' AND next_attempt_at <= now() AND attempt_count < $2
        RETURNING id`, [event.id, LIFECYCLE_MAX_ATTEMPTS, RETRY_BASE_SECONDS, RETRY_MAX_SECONDS]);
      if (attempt.rowCount !== 1) continue;
      if (!url || !dependencies.config) failure = "PLATFORM_UNCONFIGURED";
      else {
        let response: Response | undefined;
        try {
          response = await dependencies.fetch(url, {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dependencies.config.key}` },
            body: JSON.stringify({ eventId: event.id }), signal: AbortSignal.timeout(10_000), redirect: "error",
          });
        } catch { failure = "PLATFORM_UNREACHABLE"; }
        if (!failure) {
          if (!response || response.status !== 200) {
            failure = "PLATFORM_HTTP_REFUSED";
            await response?.body?.cancel().catch(() => {});
          } else {
            const body: unknown = await response.json().catch(() => null);
            const result = acknowledgement.safeParse(body);
            if (!result.success || result.data.eventId !== event.id) failure = "PLATFORM_RESPONSE_INVALID";
            else summary[result.data.state]++;
          }
        }
      }
    } catch { failure = "LOCAL_QUEUE_ERROR"; }
    if (failure) {
      summary.failed++;
      // If a response was lost after the platform committed, this conditional
      // note cannot turn its terminal event back into a pending one.
      await database.query(`UPDATE login_lifecycle_events
        SET last_error_code=CASE WHEN attempt_count >= $3 THEN 'RETRY_LIMIT:' || $2 ELSE $2 END
        WHERE id=$1 AND state='pending'`, [event.id, failure, LIFECYCLE_MAX_ATTEMPTS]).catch(() => {});
    }
  }
  return summary;
}

/** Transport continues in both job modes; it does not run any business batch. */
export function startPlatformLifecycleTransport(dependencies: PlatformLifecycleDependencies): () => void {
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await drainPlatformLifecycleEvents(dependencies);
      if (summary.failed) console.warn(`[PLATFORM_LIFECYCLE] ${summary.failed} delivery attempt(s) did not settle`);
    } catch { console.warn("[PLATFORM_LIFECYCLE] Delivery awaits retry"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

/** Safe support readback, including a deleted login's immutable tenant stamp. */
export async function readPlatformLifecycleEvents(
  database: Pick<Pool, "query">,
  tenantId: string,
  userId: string,
) {
  const tenant = z.string().uuid().parse(tenantId), user = z.string().uuid().parse(userId);
  return (await database.query(`SELECT id,kind,state,created_at AS "createdAt",settled_at AS "settledAt",
    attempt_count AS "attemptCount",last_error_code AS "lastErrorCode",next_attempt_at AS "nextAttemptAt"
    FROM login_lifecycle_events WHERE tenant_id=$1 AND user_id=$2
    ORDER BY created_at DESC,id DESC LIMIT 100`, [tenant, user])).rows;
}
