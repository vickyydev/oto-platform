import { count, desc, eq } from 'drizzle-orm';
import { session } from '@oto/db';
import type { Exec } from './tx';

/**
 * SCRUM-793 — the sessions an account holds, a page at a time, each with
 * what it is now.
 *
 * A session row is never deleted: an expiry is enforced when the cookie is
 * next presented (`plugins/session.ts`, `loadAuth`) and a sign-out revokes
 * the row so the trail survives. The list therefore grew by one row per
 * sign-in for good, and a row whose end had passed still read "Active",
 * because nothing at read time compared its end with the clock. The status
 * here is derived from the same two facts `loadAuth` refuses on, so the word
 * on the screen and the answer at the door cannot disagree.
 */

export const SESSION_PAGE_DEFAULT = 10;
export const SESSION_PAGE_MAX = 50;

export const SESSION_STATUSES = ['active', 'locked', 'ended'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

interface SessionTimes {
  expiresAt: Date;
  revokedAt: Date | null;
  lockedAt: Date | null;
}

/**
 * When a session stopped letting anybody in, or null while it still does.
 *
 * The earlier of the two ends: a session revoked by "Sign out everywhere"
 * after its expiry had already passed ended at the expiry, not at the
 * revocation that found it already over.
 */
export function sessionEndedAt(row: SessionTimes, now: Date): Date | null {
  const expired = row.expiresAt.getTime() <= now.getTime() ? row.expiresAt : null;
  if (row.revokedAt && (!expired || row.revokedAt.getTime() < expired.getTime())) return row.revokedAt;
  return expired;
}

/** Ended outranks locked: a locked session past its end is over, not waiting for a password. */
export function sessionStatus(row: SessionTimes, now: Date): SessionStatus {
  if (sessionEndedAt(row, now)) return 'ended';
  return row.lockedAt ? 'locked' : 'active';
}

export interface AccountSessionRow {
  id: string;
  branchId: string | null;
  stationId: string | null;
  lockedAt: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
  status: SessionStatus;
  endedAt: string | null;
  /** The caller's own session: the device the list is being read on. */
  current: boolean;
}

export interface AccountSessionsPage {
  sessions: AccountSessionRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Newest sign-in first. Ordered on `created_at` (then the time-ordered id)
 * rather than on `last_seen_at`, which the session plugin moves while the
 * list is being paged: an offset over a moving order repeats one row and
 * skips another between pages.
 */
export async function accountSessionsPage(
  db: Exec,
  input: { accountId: string; currentSessionId: string; limit: number; offset: number; now?: Date },
): Promise<AccountSessionsPage> {
  const now = input.now ?? new Date();
  const [counted] = await db.select({ n: count() }).from(session).where(eq(session.accountId, input.accountId));
  const rows = await db
    .select()
    .from(session)
    .where(eq(session.accountId, input.accountId))
    .orderBy(desc(session.createdAt), desc(session.id))
    .limit(input.limit)
    .offset(input.offset);
  return {
    total: counted?.n ?? 0,
    limit: input.limit,
    offset: input.offset,
    sessions: rows.map((s) => ({
      id: s.id,
      branchId: s.branchId,
      stationId: s.stationId,
      lockedAt: s.lockedAt?.toISOString() ?? null,
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
      status: sessionStatus(s, now),
      endedAt: sessionEndedAt(s, now)?.toISOString() ?? null,
      current: s.id === input.currentSessionId,
    })),
  };
}
