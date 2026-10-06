import type { Logger } from 'pino';
import type { Db, Queryable } from './db.js';
import type { Env } from './env.js';
import type { WaClient } from './whatsapp/client.js';

const MAX_ATTEMPTS = 10;

/**
 * Messages are written here first and sent from here, so one that is due
 * while WhatsApp is reconnecting — or while the process is restarting — goes
 * out when the connection returns instead of being lost. `delayMinutes` is
 * what spaces the parts of a long digest apart. A message nobody could
 * deliver within its time-to-live is dropped: a morning note that turns up at
 * night is worse than none.
 */
export async function enqueue(
  q: Queryable,
  s: string,
  body: string,
  delayMinutes: number,
  ttlHours: number,
): Promise<void> {
  await q.query(
    `insert into ${s}.outbox (body, send_after, expires_at)
     values ($1,
             now() + make_interval(mins => $2),
             now() + make_interval(mins => $2, hours => $3))`,
    [body, delayMinutes, ttlHours],
  );
}

export function createOutbox(db: Db, env: Env, wa: WaClient, log: Logger) {
  let draining = false;

  /**
   * Send what is due, in order, stopping at the first failure. The earliest
   * unsent message always goes first, so part two of a digest can never
   * overtake a part one that is still being retried.
   */
  async function drain(): Promise<void> {
    if (draining || wa.status().status !== 'open') return;
    draining = true;
    try {
      for (;;) {
        const next = await db.pool.query<{ id: string; body: string; due: boolean }>(
          `select id, body, send_after <= now() as due from ${db.s}.outbox
           where sent_at is null and expires_at > now() and attempts < $1
           order by send_after, id limit 1`,
          [MAX_ATTEMPTS],
        );
        const row = next.rows[0];
        if (!row || !row.due) return;

        try {
          if (!env.WHATSAPP_GROUP_ID) throw new Error('WHATSAPP_GROUP_ID is not set');
          await wa.sendText(env.WHATSAPP_GROUP_ID, row.body);
          await db.pool.query(`update ${db.s}.outbox set sent_at = now() where id = $1`, [row.id]);
          log.info({ outboxId: row.id }, 'message sent');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await db.pool.query(
            `update ${db.s}.outbox set attempts = attempts + 1, last_error = $2 where id = $1`,
            [row.id, message],
          );
          log.warn({ outboxId: row.id, reason: message }, 'message not sent; will retry');
          return;
        }
      }
    } finally {
      draining = false;
    }
  }

  return { drain };
}
