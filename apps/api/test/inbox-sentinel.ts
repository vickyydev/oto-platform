import { sql } from 'drizzle-orm';
import type { Db } from '@oto/db';

/**
 * THE INBOX'S NO-BODY SENTINEL (S2-19 I2g, SCRUM-586; plan §3.6, §6).
 *
 * One check, used by every inbox suite that writes a message: a test puts a
 * unique string in a message body, drives a write path, and asks where else
 * the string turned up. The places a body must never reach are the record
 * the platform keeps ABOUT the inbox — the audit log, the timeline events,
 * the operational runs — and every line the api logs. The message table (and
 * the raw webhook payload, until it is purged) are where it lives.
 *
 * Answers a count per place, so a failure names where the leak is.
 */
export interface SentinelLeaks {
  audit: number;
  events: number;
  ops: number;
  logs: number;
}

/**
 * The console SMS adapter's delivery line. The check-in connection check is
 * SENT through it on every deployment (`routes/checkin.ts`
 * `consoleMessenger`): that line is the notice's delivery, which predates the
 * inbox, and the plan names it as the residual (§7: "today it is only a log
 * line"). It is the inbox's mirror that must never log the body, so the
 * sentinel counts every OTHER line, and `smsConsoleLines` lets a test pin
 * that this is the only one.
 */
export function isSmsConsoleLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { sms?: unknown };
    return typeof parsed.sms === 'object' && parsed.sms !== null;
  } catch {
    return false;
  }
}

export function smsConsoleLines(logLines: readonly string[], needle: string): number {
  return logLines.filter((l) => l.includes(needle) && isSmsConsoleLine(l)).length;
}

export async function sentinelLeaks(db: Db, needle: string, logLines: readonly string[] = []): Promise<SentinelLeaks> {
  const like = `%${needle}%`;
  const count = async (q: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(q)).rows[0]?.n ?? 0);
  return {
    audit: await count(
      sql`select count(*)::int as n from core.audit_log where coalesce(before::text,'') || coalesce(after::text,'') like ${like}`,
    ),
    events: await count(sql`select count(*)::int as n from inbox.event where payload::text like ${like}`),
    ops: await count(
      sql`select count(*)::int as n from core.ops_run where coalesce(detail::text,'') || coalesce(error_message,'') like ${like}`,
    ),
    logs: logLines.filter((l) => l.includes(needle) && !isSmsConsoleLine(l)).length,
  };
}

export const NO_LEAKS: SentinelLeaks = { audit: 0, events: 0, ops: 0, logs: 0 };

/** How many rows of the inbox schema still hold the string anywhere — after an erasure, none may. */
export async function inboxHolds(db: Db, needle: string): Promise<Record<string, number>> {
  const like = `%${needle}%`;
  const count = async (q: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(q)).rows[0]?.n ?? 0);
  return {
    messages: await count(
      sql`select count(*)::int as n from inbox.message
          where coalesce(body,'') || coalesce(translated_body,'') || coalesce(transcript,'') like ${like}`,
    ),
    previews: await count(
      sql`select count(*)::int as n from inbox.conversation
          where coalesce(last_message_preview,'') || coalesce(ai_summary,'') like ${like}`,
    ),
    contacts: await count(
      sql`select count(*)::int as n from inbox.contact
          where coalesce(display_name,'') || coalesce(external_handle,'') || coalesce(phone,'') like ${like}`,
    ),
    receipts: await count(sql`select count(*)::int as n from inbox.webhook_receipt where coalesce(payload::text,'') like ${like}`),
    events: await count(sql`select count(*)::int as n from inbox.event where payload::text like ${like}`),
  };
}
