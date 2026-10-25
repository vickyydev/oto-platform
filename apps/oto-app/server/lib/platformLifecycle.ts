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
const pendingEvent = z.object({
  id: z.string().uuid(), user_id: z.string().min(1), platform_account_id: z.string().uuid(), state: z.literal("pending"),
}).strict();
const acknowledgement = z.object({
  ok: z.literal(true), eventId: z.string().uuid(), state: z.enum(["delivered", "superseded"]), replayed: z.boolean(),
}).strict();

function endpoint(config: SuiteProvisionConfig | null): string | null {
  if (!config || !config.key.trim()) return null;
  try {
    const url = new URL(config.apiUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin + "/admin/apps/oto_app/lifecycle-deactivations";
  } catch { return null; }
}

/** No transaction or row lock survives an HTTP call. The platform alone settles terminal state. */
export async function drainPlatformLifecycleEvents(
  dependencies: PlatformLifecycleDependencies,
  limit = 25,
): Promise<PlatformLifecycleSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("LIFECYCLE_BATCH_LIMIT_INVALID");
  const { database } = dependencies;
  const summary: PlatformLifecycleSummary = { selected: 0, delivered: 0, superseded: 0, failed: 0 };
  let rows: unknown[];
  try {
    rows = (await database.query(`SELECT id,user_id,platform_account_id,state FROM login_lifecycle_events
      WHERE state='pending' ORDER BY attempt_count,created_at,id LIMIT $1`, [limit])).rows;
  } catch { summary.failed++; return summary; }
  summary.selected = rows.length;
  const url = endpoint(dependencies.config);
  for (const row of rows) {
    const parsed = pendingEvent.safeParse(row);
    if (!parsed.success) { summary.failed++; continue; }
    const event = parsed.data;
    let failure: string | null = null;
    try {
      // A concurrent reactivation or another consumer may already have settled
      // this event. Incrementing an attempt does not reclaim terminal rows.
      const attempt = await database.query(`UPDATE login_lifecycle_events
        SET attempt_count=attempt_count+1,last_error_code=NULL
        WHERE id=$1 AND state='pending' RETURNING id`, [event.id]);
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
      await database.query(`UPDATE login_lifecycle_events SET last_error_code=$2
        WHERE id=$1 AND state='pending'`, [event.id, failure]).catch(() => {});
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
      if (summary.failed) console.warn(`[PLATFORM_LIFECYCLE] ${summary.failed} delivery attempt(s) await retry`);
    } catch { console.warn("[PLATFORM_LIFECYCLE] Delivery awaits retry"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
