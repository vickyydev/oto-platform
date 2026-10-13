import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  boothEvents,
  type BoothEvent,
  type BoothEventInput,
} from "@shared/schema";

/**
 * Insert booth events idempotently: a retry that re-sends the same eventId
 * is silently skipped, so the sender can retry after network hiccups
 * without double-counting.
 */
export async function ingestBoothEvents(
  events: BoothEventInput[],
): Promise<{ inserted: number; duplicates: number }> {
  if (events.length === 0) return { inserted: 0, duplicates: 0 };
  const rows = events.map((e) => ({
    eventId: e.eventId,
    source: e.source,
    eventType: e.eventType,
    claimId: e.claimId,
    prizeName: e.prizeName ?? null,
    phone: e.phone ?? null,
    code: e.code ?? null,
    occurredAt: e.occurredAt,
    payload: e.meta ?? null,
  }));
  const inserted = await db
    .insert(boothEvents)
    .values(rows)
    .onConflictDoNothing({ target: boothEvents.eventId })
    .returning({ id: boothEvents.id });
  return { inserted: inserted.length, duplicates: events.length - inserted.length };
}

/**
 * The game keys prize_won events by winId (no claim exists yet) and later
 * events by claimId. When an event arrives carrying both, re-point earlier
 * winId-keyed rows at the claimId so the whole lifecycle rolls up as ONE claim.
 */
export async function relinkBoothClaim(fromKey: string, toKey: string): Promise<void> {
  if (fromKey === toKey) return;
  await db.update(boothEvents).set({ claimId: toKey }).where(eq(boothEvents.claimId, fromKey));
}

/**
 * Delayed-win resolution: if a claim event referencing this winId was already
 * ingested (its payload carries winId but it is keyed by claimId), return that
 * claimId so a late-arriving prize_won lands in the same claim.
 */
export async function resolveWinToClaim(winId: string): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT claim_id FROM booth_events
    WHERE payload->>'winId' = ${winId} AND claim_id <> ${winId}
    ORDER BY received_at DESC
    LIMIT 1
  `);
  const row = result.rows[0] as { claim_id?: string } | undefined;
  return row?.claim_id ?? null;
}

export type BoothClaim = {
  claimId: string;
  source: string;
  prizeName: string | null;
  phone: string | null;
  code: string | null;
  status: "won" | "claimed" | "redeemed" | "re_redeemed" | "expired";
  wonAt: string | null;
  claimedAt: string | null;
  redeemedAt: string | null;
  reRedeemedAt: string | null;
  expiredAt: string | null;
  lastEventAt: string;
};

// The game handles expiry client-side and sends no event for it: a claim
// with no redeem 48h after the last won/claimed activity counts as expired.
const EXPIRY_HOURS = 48;

export type BoothClaimsSummary = {
  totals: { won: number; redeemed: number; reRedeemed: number; expired: number; outstanding: number };
  claims: BoothClaim[];
};

/** Mask a voucher short code for the public read endpoint: first char only. */
function maskCode(code: string | null): string | null {
  if (!code) return null;
  return `${code.slice(0, 1)}${"•".repeat(Math.max(code.length - 1, 0))}`;
}

/** Mask a phone for the public read endpoint: keep first 3 + last 2 digits. */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 5) return "•".repeat(digits.length);
  return `${digits.slice(0, 3)}${"•".repeat(digits.length - 5)}${digits.slice(-2)}`;
}

/**
 * Roll events up into one row per prize claim with its latest status.
 * Status precedence: expired > re_redeemed > redeemed > won.
 * Totals are computed over ALL claims; the claims list is limited to the
 * most recent `limit`. Phone numbers are masked (this feeds a public
 * read-only endpoint, matching the rest of the dashboard).
 */
export async function listBoothClaims(limit = 300): Promise<BoothClaimsSummary> {
  // Totals over ALL claims (not just the limited recent list). A claim with
  // no redeem 48h after its last activity is treated as expired (the game
  // expires client-side without sending an event).
  const totalsResult = await db.execute(sql`
    WITH per_claim AS (
      SELECT
        claim_id,
        bool_or(event_type = 'redeemed') AS has_redeemed,
        bool_or(event_type = 're_redeemed') AS has_re_redeemed,
        bool_or(event_type = 'expired')
          OR (
            NOT bool_or(event_type IN ('redeemed', 're_redeemed'))
            AND max(occurred_at) < now() - interval '${sql.raw(String(EXPIRY_HOURS))} hours'
          ) AS has_expired
      FROM booth_events
      GROUP BY claim_id
    )
    SELECT
      count(*)::int AS won,
      count(*) FILTER (WHERE has_redeemed OR has_re_redeemed)::int AS redeemed,
      count(*) FILTER (WHERE has_re_redeemed)::int AS re_redeemed,
      count(*) FILTER (WHERE has_expired)::int AS expired,
      count(*) FILTER (WHERE NOT has_redeemed AND NOT has_re_redeemed AND NOT has_expired)::int AS outstanding
    FROM per_claim
  `);
  const t = (totalsResult.rows[0] ?? {}) as Record<string, number | null>;

  const result = await db.execute(sql`
    SELECT
      claim_id,
      (array_agg(source ORDER BY occurred_at DESC))[1] AS source,
      (array_agg(prize_name ORDER BY occurred_at DESC) FILTER (WHERE prize_name IS NOT NULL))[1] AS prize_name,
      (array_agg(phone ORDER BY occurred_at DESC) FILTER (WHERE phone IS NOT NULL))[1] AS phone,
      (array_agg(code ORDER BY occurred_at DESC) FILTER (WHERE code IS NOT NULL))[1] AS code,
      MIN(occurred_at) FILTER (WHERE event_type = 'prize_won') AS won_at,
      MIN(occurred_at) FILTER (WHERE event_type = 'claimed') AS claimed_at,
      MIN(occurred_at) FILTER (WHERE event_type = 'redeemed') AS redeemed_at,
      MAX(occurred_at) FILTER (WHERE event_type = 're_redeemed') AS re_redeemed_at,
      MAX(occurred_at) FILTER (WHERE event_type = 'expired') AS expired_at,
      MAX(occurred_at) AS last_event_at
    FROM booth_events
    GROUP BY claim_id
    ORDER BY MAX(occurred_at) DESC
    LIMIT ${limit}
  `);
  const rows = result.rows as Array<Record<string, unknown>>;
  const toIso = (v: unknown): string | null =>
    v == null ? null : new Date(v as string).toISOString();
  const claims: BoothClaim[] = rows.map((r) => {
    const expiredAt = toIso(r.expired_at);
    const reRedeemedAt = toIso(r.re_redeemed_at);
    const redeemedAt = toIso(r.redeemed_at);
    const claimedAt = toIso(r.claimed_at);
    const lastEventAt = toIso(r.last_event_at)!;
    const implicitlyExpired =
      !redeemedAt &&
      !reRedeemedAt &&
      Date.now() - new Date(lastEventAt).getTime() > EXPIRY_HOURS * 3600_000;
    const status: BoothClaim["status"] = expiredAt || implicitlyExpired
      ? "expired"
      : reRedeemedAt
        ? "re_redeemed"
        : redeemedAt
          ? "redeemed"
          : claimedAt
            ? "claimed"
            : "won";
    return {
      claimId: String(r.claim_id),
      source: String(r.source),
      prizeName: (r.prize_name as string | null) ?? null,
      phone: maskPhone((r.phone as string | null) ?? null),
      // Masked: this feeds a public read endpoint and unredeemed codes are
      // live vouchers — never expose them in full.
      code: maskCode((r.code as string | null) ?? null),
      status,
      wonAt: toIso(r.won_at),
      claimedAt,
      redeemedAt,
      reRedeemedAt,
      expiredAt: expiredAt ?? (implicitlyExpired ? lastEventAt : null),
      lastEventAt,
    };
  });
  const totals = {
    won: t.won ?? 0,
    redeemed: t.redeemed ?? 0,
    reRedeemed: t.re_redeemed ?? 0,
    expired: t.expired ?? 0,
    outstanding: t.outstanding ?? 0,
  };
  return { totals, claims };
}

export async function listRecentBoothEvents(limit = 100): Promise<BoothEvent[]> {
  return db.select().from(boothEvents).orderBy(desc(boothEvents.receivedAt)).limit(limit);
}
