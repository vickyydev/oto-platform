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
  /** SCRUM-852: events the platform itself refused for the last time in this drain. */
  parked: number;
  /** SCRUM-852: the distinct safe failure codes of this drain, for the warn line. */
  causes: string[];
}
// SCRUM-778/810: a durable schedule, including after a process restart. A null
// next_attempt_at parks the pending row for review; it never means immediate retry.
//
// SCRUM-852: only the platform's own refusal can park. This is a leaver's
// switch-off: an outage, a deploy or a wrong key must never leave it undelivered
// for ever. So every attempt still counts and still backs off (30 s doubling to
// the 15 minute cap, where it stays), but a row parks only when the platform
// ANSWERED a refusal about the event and the event has had its six tries.
// Anything else keeps trying at the cap until it is delivered, superseded or
// refused. An administrator sends a parked event again from the employee's
// Access & Login panel (`requeueParkedLifecycleEvent`).
export const LIFECYCLE_MAX_ATTEMPTS = 6;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 15 * 60;
/** Past this power the delay is at the cap anyway; bounding it keeps power() finite for ever. */
const RETRY_MAX_DOUBLINGS = 10;

/** One failed attempt: a safe code and whether the platform itself refused the event. */
export interface LifecycleFailure { code: string; definite: boolean }
const transient = (code: string): LifecycleFailure => ({ code, definite: false });
/** The platform's error codes are upper-case words; nothing else is ever stored or logged. */
const PLATFORM_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** This transport's own vocabulary: a platform code may never pass for one of these. */
const OWN_CODE = /^(?:PLATFORM_|LOCAL_|RETRY_LIMIT|LOGIN_DELETED)/;
/**
 * What rows were parked with before SCRUM-852, when every failure counted to
 * the ceiling: none of these says the platform refused the event (the old
 * PLATFORM_HTTP_REFUSED was any non-200, a 502 during a deploy included). They
 * are put back in the queue; a real refusal parks again at once under its own
 * code, which is not in this list.
 */
const PARKED_WITHOUT_A_REFUSAL = [
  "RETRY_LIMIT_REACHED", "RETRY_LIMIT:PLATFORM_UNCONFIGURED", "RETRY_LIMIT:PLATFORM_UNREACHABLE",
  "RETRY_LIMIT:PLATFORM_HTTP_REFUSED", "RETRY_LIMIT:PLATFORM_RESPONSE_INVALID", "RETRY_LIMIT:LOCAL_QUEUE_ERROR",
  "RETRY_LIMIT:UNKNOWN",
];

/**
 * A non-200 answer, classified (SCRUM-852).
 *
 *  - 5xx, 408, 425, 429: the platform is down, deploying or busy — transient.
 *  - 401, 403, 407: this deployment's key or its road was refused before the
 *    event was looked at, like having no key at all — transient.
 *  - a 404 that says the door itself is not there (ROUTE_NOT_FOUND: an older
 *    platform mid-rollout, a wrong address): nothing was decided — transient.
 *  - any other 4xx carrying the platform's error envelope: the platform read
 *    the event and refused it (LAST_OPERATOR_ADMIN, NOT_FOUND) — definite,
 *    under the platform's own code.
 *  - anything else (a proxy's page, an unreadable body): not the platform's
 *    answer — transient.
 */
export function classifyLifecycleRefusal(status: number, body: unknown): LifecycleFailure {
  if (status >= 500 || status === 408 || status === 425 || status === 429) return transient("PLATFORM_UNAVAILABLE");
  if (status === 401 || status === 403 || status === 407) return transient("PLATFORM_KEY_REFUSED");
  if (status >= 400) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    if (code === "ROUTE_NOT_FOUND") return transient("PLATFORM_DOOR_MISSING");
    if (typeof code === "string" && PLATFORM_CODE.test(code) && !OWN_CODE.test(code)) return { code, definite: true };
  }
  return transient("PLATFORM_RESPONSE_INVALID");
}
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
  const summary: PlatformLifecycleSummary = { selected: 0, delivered: 0, superseded: 0, failed: 0, parked: 0, causes: [] };
  const failed = (code: string) => { summary.failed++; if (!summary.causes.includes(code)) summary.causes.push(code); };
  let rows: unknown[];
  try {
    // SCRUM-852: a row the older rule parked without a refusal goes back in the queue.
    await database.query(`UPDATE login_lifecycle_events
      SET next_attempt_at=now(), last_error_code=nullif(replace(last_error_code,'RETRY_LIMIT:',''),'RETRY_LIMIT_REACHED')
      WHERE state='pending' AND next_attempt_at IS NULL AND last_error_code = ANY($1::text[])`, [PARKED_WITHOUT_A_REFUSAL]).catch(() => {});
    rows = (await database.query(`SELECT id,user_id,platform_account_id,state,kind FROM login_lifecycle_events
      WHERE state='pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at,created_at,id LIMIT $1`, [limit])).rows;
  } catch { failed("LOCAL_QUEUE_ERROR"); return summary; }
  summary.selected = rows.length;
  for (const row of rows) {
    const parsed = pendingEvent.safeParse(row);
    if (!parsed.success) { failed("LOCAL_QUEUE_ERROR"); continue; }
    const event = parsed.data;
    const url = endpoint(dependencies.config, event.kind);
    let failure: LifecycleFailure | null = null;
    try {
      // Claim the next due attempt atomically. Another process cannot claim the
      // same due row, and a crash retains its backoff: the claim never parks
      // (SCRUM-852), so an attempt cut short is simply due again later.
      const attempt = await database.query(`UPDATE login_lifecycle_events
        SET attempt_count=attempt_count+1,
          next_attempt_at=now()+make_interval(secs => least($3,$2*power(2,least(attempt_count,$4)))::integer)
        WHERE id=$1 AND state='pending' AND next_attempt_at <= now()
        RETURNING id`, [event.id, RETRY_BASE_SECONDS, RETRY_MAX_SECONDS, RETRY_MAX_DOUBLINGS]);
      if (attempt.rowCount !== 1) continue;
      if (!url || !dependencies.config) failure = transient("PLATFORM_UNCONFIGURED");
      else {
        let response: Response | undefined;
        try {
          response = await dependencies.fetch(url, {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dependencies.config.key}` },
            body: JSON.stringify({ eventId: event.id }), signal: AbortSignal.timeout(10_000), redirect: "error",
          });
        } catch { failure = transient("PLATFORM_UNREACHABLE"); }
        if (!failure) {
          if (!response) failure = transient("PLATFORM_UNREACHABLE");
          else if (response.status !== 200) {
            // Only an answer that may be the platform's refusal has its body read, for the code alone.
            failure = classifyLifecycleRefusal(response.status, null);
            if (failure.code === "PLATFORM_RESPONSE_INVALID" && response.status >= 400 && response.status < 500) {
              failure = classifyLifecycleRefusal(response.status, await response.json().catch(() => null));
            } else await response.body?.cancel().catch(() => {});
          } else {
            const body: unknown = await response.json().catch(() => null);
            const result = acknowledgement.safeParse(body);
            if (!result.success || result.data.eventId !== event.id) failure = transient("PLATFORM_RESPONSE_INVALID");
            else summary[result.data.state]++;
          }
        }
      }
    } catch { failure = transient("LOCAL_QUEUE_ERROR"); }
    if (failure) {
      failed(failure.code);
      // If a response was lost after the platform committed, this conditional
      // note cannot turn its terminal event back into a pending one. Only the
      // platform's own refusal, at the ceiling, parks (a null due time).
      const noted = await database.query(`UPDATE login_lifecycle_events
        SET last_error_code=CASE WHEN $3::boolean AND attempt_count >= $4 THEN 'RETRY_LIMIT:' || $2::text ELSE $2::text END,
          next_attempt_at=CASE WHEN $3::boolean AND attempt_count >= $4 THEN NULL ELSE next_attempt_at END
        WHERE id=$1 AND state='pending'
        RETURNING next_attempt_at IS NULL AS parked`, [event.id, failure.code, failure.definite, LIFECYCLE_MAX_ATTEMPTS]).catch(() => null);
      if (failure.definite && noted?.rows?.[0]?.parked === true) summary.parked++;
    }
  }
  return summary;
}

const WARN_AGAIN_AFTER_MS = 60 * 60 * 1000;
/**
 * SCRUM-852: which of a drain's failure codes are worth a log line now. A cause
 * is named when it first appears and at most once an hour while it lasts, so an
 * outage that keeps every event retrying for a day writes a line an hour, not
 * one every attempt. A cause not seen for an hour is forgotten, so its return
 * is named at once.
 */
export function lifecycleWarnGate(repeatAfterMs = WARN_AGAIN_AFTER_MS): (causes: readonly string[], now: number) => string[] {
  const warned = new Map<string, number>();
  return (causes, now) => {
    for (const [cause, at] of warned) if (!causes.includes(cause) && now - at >= repeatAfterMs) warned.delete(cause);
    const due = causes.filter(cause => { const at = warned.get(cause); return at === undefined || now - at >= repeatAfterMs; });
    for (const cause of due) warned.set(cause, now);
    return due;
  };
}

/** Transport continues in both job modes; it does not run any business batch. */
export function startPlatformLifecycleTransport(dependencies: PlatformLifecycleDependencies): () => void {
  let running = false, stopped = false;
  const worthALine = lifecycleWarnGate();
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await drainPlatformLifecycleEvents(dependencies);
      // A park is said every time: it happens once per event and waits for a person.
      if (summary.parked) console.warn(`[PLATFORM_LIFECYCLE] ${summary.parked} event(s) refused by the platform are parked; an administrator can send them again from the employee's Access & Login panel`);
      const causes = worthALine(summary.causes, Date.now());
      if (causes.length) console.warn(`[PLATFORM_LIFECYCLE] ${summary.failed} delivery attempt(s) did not settle (${causes.join(", ")})`);
    } catch { if (worthALine(["LOCAL_QUEUE_ERROR"], Date.now()).length) console.warn("[PLATFORM_LIFECYCLE] Delivery awaits retry"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

/**
 * SCRUM-852: a parked event that still says something true, so it may be sent
 * again. Parked: pending with no due time. Still true: the login exists, is
 * still stamped with the event's platform account, is still off (a switch-off)
 * or still in pay only (a restriction), and no newer event of the same kind has
 * replaced this one. The app's own triggers already settle an event when its
 * login is switched back on, lifted out of pay only or deleted (0031, 0044,
 * 0049), and the platform's doors settle a stale one as superseded; this is
 * the same rule held a third time, where a person presses a button.
 */
const PARKED_AND_STANDING = `e.state='pending' AND e.next_attempt_at IS NULL
  AND EXISTS (SELECT 1 FROM users u WHERE u.id=e.user_id AND u.platform_user_id=e.platform_account_id
    AND CASE e.kind WHEN 'restrict' THEN u.access_mode='pay_only' ELSE u.is_active IS FALSE END)
  AND NOT EXISTS (SELECT 1 FROM login_lifecycle_events n WHERE n.user_id=e.user_id AND n.kind=e.kind
    AND (n.created_at,n.id) > (e.created_at,e.id))`;

/**
 * Safe support readback, including a deleted login's immutable tenant stamp.
 * `parked` (SCRUM-852) is true for the event an administrator may send again.
 */
export async function readPlatformLifecycleEvents(
  database: Pick<Pool, "query">,
  tenantId: string,
  userId: string,
) {
  const tenant = z.string().uuid().parse(tenantId), user = z.string().uuid().parse(userId);
  return (await database.query(`SELECT e.id,e.kind,e.state,e.created_at AS "createdAt",e.settled_at AS "settledAt",
    e.attempt_count AS "attemptCount",e.last_error_code AS "lastErrorCode",e.next_attempt_at AS "nextAttemptAt",
    (${PARKED_AND_STANDING}) AS "parked"
    FROM login_lifecycle_events e WHERE e.tenant_id=$1 AND e.user_id=$2
    ORDER BY e.created_at DESC,e.id DESC LIMIT 100`, [tenant, user])).rows;
}

export type LifecycleRequeueAnswer =
  | { outcome: "requeued"; eventId: string; kind: "deactivate" | "restrict" }
  | { outcome: "not_found" | "not_parked" | "moved_on" };
/** The refusals of "Send again", in the words the screen shows. */
export const LIFECYCLE_SEND_AGAIN_REFUSALS = {
  not_found: "That event was not found.",
  not_parked: "This is no longer waiting: it was already sent again, or the platform has it now.",
  moved_on: "This login has changed since, so there is nothing to send.",
} as const;

/**
 * SCRUM-852: "Send again". Puts ONE parked event of the caller's park group
 * back in the queue, due now, with its six tries afresh, and writes the
 * activity row in the same statement: both happen or neither does. It changes
 * delivery only: it never creates an event and never touches the login.
 *
 * Two administrators pressing at once: the second finds the row no longer
 * parked and is refused, so there is one re-queue and one activity row. An
 * event of another park group is not found. The transport delivers it on its
 * next drain; the platform's door still judges the event as it stands then.
 */
export async function requeueParkedLifecycleEvent(
  database: Pick<Pool, "query">,
  tenantId: string,
  eventId: string,
  actorUserId: string,
): Promise<LifecycleRequeueAnswer> {
  const tenant = z.string().uuid().parse(tenantId), event = z.string().uuid().parse(eventId);
  const actor = z.string().min(1).parse(actorUserId);
  const requeued = (await database.query(`WITH parked AS (
      SELECT id,last_error_code,attempt_count FROM login_lifecycle_events WHERE id=$1 AND tenant_id=$2
    ), requeued AS (
      UPDATE login_lifecycle_events e SET attempt_count=0, next_attempt_at=now(), last_error_code=NULL
        FROM parked p
       WHERE e.id=p.id AND e.tenant_id=$2 AND ${PARKED_AND_STANDING}
      RETURNING e.id,e.kind,e.user_id,p.last_error_code AS reason,p.attempt_count AS attempts
    ), logged AS (
      INSERT INTO activity_log (tenant_id,employee_id,activity_type,summary_text,metadata_json,created_by)
      SELECT $2::uuid,
        (SELECT min(m.id) FROM employees m WHERE m.user_id=r.user_id AND m.tenant_id=$2 HAVING count(*)=1),
        'USER_PLATFORM_LIFECYCLE_RESENT',
        'Sent the ' || CASE r.kind WHEN 'restrict' THEN 'pay-only restriction' ELSE 'login switch-off' END
          || ' for ' || coalesce((SELECT u.full_name FROM users u WHERE u.id=r.user_id), 'a login') || ' to the platform again',
        json_build_object('eventId', r.id, 'kind', r.kind, 'userId', r.user_id,
          'previousReason', r.reason, 'previousAttempts', r.attempts)::text,
        $3::varchar
      FROM requeued r
      RETURNING id
    )
    SELECT r.id,r.kind,(SELECT count(*) FROM logged)::int AS logged FROM requeued r`, [event, tenant, actor])).rows[0] as
    { id: string; kind: "deactivate" | "restrict"; logged: number } | undefined;
  if (requeued) return { outcome: "requeued", eventId: requeued.id, kind: requeued.kind };
  // Words only: the statement above already refused. Another park group's event reads as missing.
  const now = (await database.query(`SELECT state='pending' AND next_attempt_at IS NULL AS parked
    FROM login_lifecycle_events WHERE id=$1 AND tenant_id=$2`, [event, tenant])).rows[0] as { parked: boolean } | undefined;
  if (!now) return { outcome: "not_found" };
  return { outcome: now.parked ? "moved_on" : "not_parked" };
}
