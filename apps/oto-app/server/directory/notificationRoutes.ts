import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { directoryClientOf, requireDirectoryClient } from "./clientAuth";

/**
 * SCRUM-823 — the platform's way to put a notification in a person's OTO App
 * bell: `POST /api/directory/notifications`.
 *
 * The platform's inbox hands a Birthdays & Events conversation to a person and
 * tells the birthday manager on duty — and, fifteen minutes later when nobody
 * picked it up, the GM — here, beside the WhatsApp or Telegram ping it sends
 * through its own notice sender. The row is an ordinary `notifications` row of
 * type `inbox_handover` (migration 0046): the bell lists it like any other.
 *
 * A tenant-bound directory key with the `notifications:write` scope
 * (`clientAuth.ts`), never the shared HR key: the recipient must be a user of
 * the key's park group — an employee profile there, or branch access there —
 * or the answer is the same 404 as a user that does not exist. A login in pay
 * only (SCRUM-769) or switched off is addressed nothing, as
 * `createNotification` addresses it nothing, and the answer says so (409).
 *
 * THE CALLER'S ID IS THE NOTIFICATION'S. The platform mints it and sends it
 * again on a retry: the same id for the same recipient is a replay (200, one
 * row); the same id for anyone else is refused `id_in_use`.
 *
 * The pool is passed in, as the event routes take it, so the route mounts on a
 * bare server in a check without the app's boot-time configuration.
 */

export const notificationBodySchema = z
  .object({
    id: z.string().uuid(),
    recipientUserId: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(1000),
    referenceType: z.literal("inbox_conversation"),
    referenceId: z.string().uuid(),
  })
  .strict();
export type NotificationBody = z.infer<typeof notificationBodySchema>;

export interface NotificationAnswer {
  notification: { id: string; recipientUserId: string; type: "inbox_handover"; createdAt: string };
  replayed: boolean;
}

type Queryable = Pool | PoolClient;

type Outcome =
  | { ok: true; status: 200 | 201; body: NotificationAnswer }
  | { ok: false; status: 404 | 409; error: string; message: string };

/** The recipient as this park group sees it: none, addressable, or held (pay only, switched off). */
async function recipientOf(db: Queryable, tenantId: string, userId: string): Promise<"none" | "ok" | "held"> {
  const { rows } = await db.query<{ is_active: boolean; access_mode: string | null }>(
    `select u.is_active, to_jsonb(u)->>'access_mode' as access_mode
       from users u
      where u.id = $1
        and (exists (select 1 from employees e where e.user_id = u.id and e.tenant_id = $2)
             or exists (select 1 from user_branch_access a where a.user_id = u.id and a.tenant_id = $2))`,
    [userId, tenantId],
  );
  const row = rows[0];
  if (!row) return "none";
  return row.is_active && row.access_mode !== "pay_only" ? "ok" : "held";
}

export async function createDirectoryNotification(db: Queryable, tenantId: string, body: NotificationBody): Promise<Outcome> {
  const answer = (row: { id: string; recipient_user_id: string; created_at: Date }, replayed: boolean, status: 200 | 201): Outcome => ({
    ok: true,
    status,
    body: {
      notification: { id: row.id, recipientUserId: row.recipient_user_id, type: "inbox_handover", createdAt: new Date(row.created_at).toISOString() },
      replayed,
    },
  });
  const seen = async () =>
    (
      await db.query<{ id: string; tenant_id: string; recipient_user_id: string; reference_id: string | null; created_at: Date }>(
        `select id, tenant_id, recipient_user_id, reference_id, created_at from notifications where id = $1`,
        [body.id],
      )
    ).rows[0];
  const replayOf = (row: NonNullable<Awaited<ReturnType<typeof seen>>>): Outcome =>
    row.tenant_id === tenantId && row.recipient_user_id === body.recipientUserId && row.reference_id === body.referenceId
      ? answer(row, true, 200)
      : { ok: false, status: 409, error: "id_in_use", message: "That notification id is already used for another notification" };

  const earlier = await seen();
  if (earlier) return replayOf(earlier);
  const recipient = await recipientOf(db, tenantId, body.recipientUserId);
  if (recipient === "none") return { ok: false, status: 404, error: "recipient_not_found", message: "No such user in this park group" };
  if (recipient === "held") {
    return { ok: false, status: 409, error: "recipient_not_addressable", message: "That login is switched off or in pay only" };
  }
  const { rows } = await db.query<{ id: string; recipient_user_id: string; created_at: Date }>(
    `insert into notifications (id, tenant_id, recipient_user_id, type, title, body, reference_type, reference_id)
     values ($1, $2, $3, 'inbox_handover', $4, $5, $6, $7)
     on conflict (id) do nothing
     returning id, recipient_user_id, created_at`,
    [body.id, tenantId, body.recipientUserId, body.title, body.body, body.referenceType, body.referenceId],
  );
  if (rows[0]) return answer(rows[0], false, 201);
  // Two calls with one id at once: the other one wrote it.
  const raced = await seen();
  return raced ? replayOf(raced) : { ok: false, status: 409, error: "id_in_use", message: "That notification id could not be written" };
}

export function directoryNotificationRouter(pool: Pool): Router {
  const router = Router();
  const auth = requireDirectoryClient(pool, "notifications:write");

  router.post("/api/directory/notifications", auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = notificationBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation error", message: "The request body is not valid", details: parsed.error.flatten() });
      }
      const client = directoryClientOf(res);
      const outcome = await createDirectoryNotification(pool, client.tenantId, parsed.data);
      if (outcome.ok) return res.status(outcome.status).json(outcome.body);
      return res.status(outcome.status).json({ error: outcome.error, message: outcome.message });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
