import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  boxState,
  branch,
  discountDefinition,
  employee,
  product,
  redemptionThrottle,
  sale,
  spin,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  voucherMiss,
  voucherRedemption,
  type Db,
  type VoucherMissResult,
  type VoucherReleaseReason,
} from '@oto/db';
import {
  BOOTH_CODE_ALPHABET,
  BOOTH_CODE_LENGTH,
  boothStaffCode,
  boothStaffLabel,
  computeTicketCartTotals,
  isLegacyBoothCode,
  isoDateInTz,
  newId,
  normaliseBoothCode,
  priceForTier,
  resolveRate,
  verifyBoothCode,
  wallClockMinutesInTz,
  type CartPromo,
  type ManualDiscount,
  type PricingContext,
  type PromoDiscount,
  type TaxConfigShape,
  type TicketCartLine,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { raiseAlert } from './ops';
import type { Exec, Tx } from './tx';

/**
 * S2-10b (SCRUM-207) — a voucher at the counter: looked up, held on a cart,
 * priced by the platform, used up when the sale is paid.
 *
 * THE OWNER'S RULES (24 September), each of which is a line of code below:
 *
 *   - A scan answers at once what the voucher is and what it is worth, and
 *     CONSUMES NOTHING (`lookupVoucher`).
 *   - A voucher is HELD when it is put on a cart (`holdVoucher`) and USED UP
 *     when the sale is paid (`consumeSaleVouchers`, called from the one place
 *     a sale closes). It is let go when the line is removed
 *     (`releaseVoucher`) or the sale is voided (`POST /sales/:id/void`, and
 *     the database trigger in migration 0021, so every path that voids a sale
 *     is covered).
 *   - A sale RUNG UP with a voucher keeps it until it is paid or voided: no
 *     other cart, at this till or any other, takes it over (`holdStateOf`),
 *     and no tender starts on a sale whose voucher is not its own
 *     (`assertSaleVouchersHeld`, called from every tender the api starts; the
 *     offline replay banks money without it, and the close's own use-up then
 *     refuses a lost voucher and sends that sale to Failures).
 *   - The value comes from the voucher's definition, on this side, never from
 *     the till (`resolveCartVoucher` and `voucherPricing`).
 *   - A voucher may be redeemed at any branch, and the branch is recorded —
 *     except where its item is not sold. A free product is honoured only at a
 *     park selling the linked product (every park, for a product that belongs
 *     to no branch), or selling a product of its own with the same code, which
 *     can exist only once the linked one is archived (`freeItemAtBranch`). A
 *     1+1 is honoured only at a park with a live ticket package of the same
 *     name (`packageAtBranch`). Anywhere else the answer is
 *     VOUCHER_ITEM_UNAVAILABLE.
 *   - Booth vouchers are redeemed online only, whatever the definition's
 *     offline policy says (spec §8) — see `refuseOffline`.
 *   - Expiry is enforced when set; null means it never expires.
 *   - A mistyped code reads "Invalid code" (the check character, decided with
 *     no database; a ten-character code nobody has is a character dropped),
 *     an unsynced one "Code not found — the booth may not have synced yet", a
 *     used one says who, when and where.
 *   - Five different wrong codes inside a minute lock that till's redemption
 *     for ten minutes and raise `redemption.probing` (`recordVoucherMiss`);
 *     every wrong code after the fifth answers the lock. The same code tried
 *     again is the same miss (SCRUM-406), so a slip its booth has not sent yet
 *     can be tried again without locking the till.
 *   - The same budget holds for each PERSON, across every till (SCRUM-425):
 *     five different wrong codes from one signed-in account inside a minute,
 *     at any tills, lock that account's look-ups at every till for ten minutes
 *     and raise `redemption.probing` naming them. One person's codes are
 *     checked one at a time, each miss counted before their next code is
 *     looked at (`findForRedemption`), so however many arrive at once, every
 *     code after the fifth miss is refused unchecked. Either lock refuses,
 *     neither lifts the other, and while both are on the one that ends later
 *     answers. Every code checked and found wrong is a row of
 *     `promo.voucher_miss` — who, where, when, and the code's hash — for the
 *     Console to show.
 *
 * WHERE THE TILL IS. Every act here happens at the station the SESSION is
 * standing at (`PUT /me/session/station`), never at one a request names: the
 * guessing limit is per till, and a limit keyed on a value the caller chooses
 * is a limit the caller resets. The person is the session's account, for the
 * same reason.
 */

// --- Limits ------------------------------------------------------------------

/** Five different codes that missed — invalid, or nobody's — inside a minute ... */
export const VOUCHER_MISS_LIMIT = 5;
export const VOUCHER_MISS_WINDOW_MS = 60_000;
/** ... lock that till's voucher redemption for ten minutes. */
export const VOUCHER_LOCK_MS = 10 * 60_000;
/*
 * The same three numbers are each person's budget (SCRUM-425): five different
 * codes from one account inside a minute, at any tills, lock that account's
 * look-ups for ten minutes. The plan gives one budget for both — "per-station
 * and per-staff not-found budget 5 per minute → 10-minute lock"
 * (`docs/progress/SPRINT_2_PLAN.md`, S2-10b) — so they are one set of values.
 */

/**
 * The advisory lock one person's codes are checked under, one at a time
 * across every till: the look-up and the miss it may be are one act under it
 * (`findForRedemption`). Ours, beside the others in this api: `0x070a` the job
 * runner, `0x070b` the QR invoice number, `0x070c` an operator's barcodes,
 * `0x070e` the virtual box lease.
 */
const PERSON_MISS_LOCK_NAMESPACE = 0x070d;

/**
 * One person's lock in that namespace, as Postgres's two-integer form: the key
 * is the first four bytes of the SHA-256 of their account id. Exported because
 * the only honest way to test a check queued behind that lock is for the test
 * to hold it, as `scheduleLockId` in `jobs.ts` is for the job runner's.
 */
export function personMissLockId(accountId: string): [namespace: number, key: number] {
  return [
    PERSON_MISS_LOCK_NAMESPACE,
    createHash('sha256').update(accountId).digest().readInt32BE(0),
  ];
}

/**
 * How long a hold on a cart that has NOT been rung up keeps a voucher from
 * another till.
 *
 * A till that scanned a voucher and was then closed, crashed or abandoned must
 * not keep a family's voucher "in use" for ever. A hold only lapses when
 * another cart ASKS for the voucher, and only while the cart holding it has
 * not been rung up: once Pay is pressed the sale's price counts the voucher, a
 * card or a QR may be on its way, and the sale keeps the voucher until it is
 * paid or voided — however long that takes. Fifteen minutes is several times
 * the length of a transaction at the counter; it is a named value so the park
 * can move it.
 */
export const VOUCHER_HOLD_LAPSE_MS = 15 * 60_000;

// --- The exact words the counter shows (SPRINT_2_PLAN.md S2-10b) -------------

export const VOUCHER_MESSAGES = {
  invalid: 'Invalid code',
  /** The plan's words, and one sentence more (SCRUM-406): a slip printed offline is not lost. */
  notFound:
    'Code not found — the booth may not have synced yet. A slip printed while the booth was offline works once the booth is back online',
  notSetUp: "This voucher's item is not set up yet — ask a manager",
  itemUnavailable: "This voucher's item is not sold at this branch — ask a manager",
  offline: 'Vouchers can only be redeemed online — this till is working offline',
  void: 'This voucher has been cancelled',
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "8 Oct 2026" in a branch's timezone. Assembled from the pinned parts
 * `@oto/shared` reads, never from a locale's own date pattern, so a box and the
 * cloud print the same words (the reason `promo.ts` gives for its own).
 */
export function formatVoucherDate(instant: Date, timeZone: string): string {
  const [year, month, day] = isoDateInTz(instant, timeZone).split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** "8 Oct 2026 15:02" in a branch's timezone. */
export function formatVoucherDateTime(instant: Date, timeZone: string): string {
  const minutes = wallClockMinutesInTz(instant, timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${formatVoucherDate(instant, timeZone)} ${hh}:${mm}`;
}

/** Whole baht without decimals, satang when there are any: 15000 → "150". */
function baht(satang: number): string {
  return satang % 100 === 0 ? String(satang / 100) : (satang / 100).toFixed(2);
}

// --- What a code is, from the string alone -----------------------------------

/**
 * What a till can say about a code before asking the database.
 *
 *   invalid       the wrong shape, or an eleven-character code whose check
 *                 character is wrong — a mistake, answered "Invalid code"
 *                 without a query, so a typo never reads as "not synced yet".
 *   current       eleven characters with a correct check character.
 *   legacy_booth  ten characters of the pre-check shape. Printed before the
 *                 check existed and still in families' hands, so it is looked
 *                 up as it is. No box mints ten characters any more, so one
 *                 the platform does not have is an eleven-character code with
 *                 a character dropped: "Invalid code", not "not synced".
 *   legacy_short  four digits, or four characters starting with a letter:
 *                 Radar's codes, which the S2-10b import will bring into the
 *                 same table. Until one is there, an unknown one is "Invalid
 *                 code" (the plan's rule), not "not synced".
 */
export type VoucherCodeClass =
  | { kind: 'invalid' }
  | { kind: 'current'; code: string }
  | { kind: 'legacy_booth'; code: string }
  | { kind: 'legacy_short'; code: string };

const LEGACY_SHORT = /^(?:\d{4}|[A-Z][0-9A-Z]{3})$/;
/** The eleven-character shape, whatever the check says — used to spot a voucher claim. */
const CURRENT_SHAPE = new RegExp(`^[0-9A-Z]{2}[${BOOTH_CODE_ALPHABET}]{9}$`);

export function classifyVoucherCode(raw: string): VoucherCodeClass {
  const code = normaliseBoothCode(raw);
  if (code.length === BOOTH_CODE_LENGTH) {
    return verifyBoothCode(code).ok ? { kind: 'current', code } : { kind: 'invalid' };
  }
  if (isLegacyBoothCode(code)) return { kind: 'legacy_booth', code };
  if (LEGACY_SHORT.test(code)) return { kind: 'legacy_short', code };
  return { kind: 'invalid' };
}

/**
 * Whether a code in a cart's `promoCodes` has a booth voucher's SHAPE — a
 * current code, right check or wrong, or a legacy ten-character one. Naming
 * one there is claiming a voucher; a wrong check is a mistake the string alone
 * proves.
 */
function hasBoothShape(code: string): boolean {
  return CURRENT_SHAPE.test(code) || isLegacyBoothCode(code);
}

/**
 * Whether a code could be a booth voucher's at all: an eleven-character code
 * whose check character is right, or a legacy ten-character one (which carries
 * no check to hold it to). An eleven-character code with a wrong check is
 * nobody's voucher.
 */
function couldBeBoothVoucher(code: string): boolean {
  return verifyBoothCode(code).ok || isLegacyBoothCode(code);
}

// --- Refusals ----------------------------------------------------------------

export const voucherErrors = {
  invalid: () => new AppError(422, 'INVALID_CODE', VOUCHER_MESSAGES.invalid),
  notFound: () => new AppError(404, 'NOT_FOUND', VOUCHER_MESSAGES.notFound),
  locked: (until: Date, now: Date) => {
    const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
    return new AppError(
      429,
      'LOCKED',
      `Too many wrong codes — try again in ${minutes} minute${minutes === 1 ? '' : 's'}`,
      { lockedUntil: until.toISOString() },
    );
  },
  /**
   * The person's own lock (SCRUM-425): theirs, at every till, and not this
   * till's — the till may be open to everybody else. `lock: 'person'` tells it
   * from the till's, which carries no `lock`.
   */
  personLocked: (until: Date, now: Date) => {
    // Never more than the lock's own length. A request that began a moment
    // before the miss that set the lock — one of a burst — would otherwise
    // round the gap up and read a minute more than the lock lasts.
    const minutes = Math.min(
      VOUCHER_LOCK_MS / 60_000,
      Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000)),
    );
    return new AppError(
      429,
      'LOCKED',
      `Too many wrong codes from you — you cannot redeem vouchers at any till for ${minutes} minute${minutes === 1 ? '' : 's'}`,
      { lockedUntil: until.toISOString(), lock: 'person' },
    );
  },
  notSetUp: (definitionCode: string, why: string) =>
    new AppError(409, 'VOUCHER_NOT_SET_UP', VOUCHER_MESSAGES.notSetUp, {
      definition: definitionCode,
      reason: why,
    }),
  itemUnavailable: (definitionCode: string) =>
    new AppError(409, 'VOUCHER_ITEM_UNAVAILABLE', VOUCHER_MESSAGES.itemUnavailable, {
      definition: definitionCode,
    }),
};

// --- The till the act happens at ---------------------------------------------

export interface RedemptionStation {
  id: string;
  name: string;
  operatorId: string;
  branchId: string;
  branchName: string;
  timezone: string;
  boxId: string | null;
}

/**
 * The till this session is standing at, inside the caller's operator.
 *
 * Refused when the session has picked none — a redemption is recorded against
 * a till, and the guessing limit is counted per till — and when the station is
 * not a till: a booth prints vouchers, it does not take them.
 */
export async function loadRedemptionStation(
  db: Exec,
  operatorId: string,
  stationId: string | null,
): Promise<RedemptionStation> {
  if (!stationId) {
    throw new AppError(
      409,
      'NO_STATION_PICKED',
      'Take a till first — a voucher is redeemed at the till it is scanned at',
    );
  }
  const [row] = await db
    .select({
      id: station.id,
      name: station.name,
      kind: station.kind,
      operatorId: station.operatorId,
      branchId: station.branchId,
      boxId: station.boxId,
      branchName: branch.name,
      timezone: branch.timezone,
    })
    .from(station)
    .innerJoin(branch, eq(branch.id, station.branchId))
    .where(
      and(
        eq(station.id, stationId),
        eq(station.operatorId, operatorId),
        isNull(station.archivedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
  if (row.kind !== 'till') {
    throw new AppError(
      409,
      'STATION_CANNOT_REDEEM',
      `Vouchers are redeemed at a till, and ${row.name} is not one`,
    );
  }
  return {
    id: row.id,
    name: row.name,
    operatorId: row.operatorId,
    branchId: row.branchId,
    branchName: row.branchName,
    timezone: row.timezone,
    boxId: row.boxId,
  };
}

// --- The guessing limit ------------------------------------------------------

/** Until when a till's voucher redemption is locked, or null. Reads only. */
async function tillLockedUntil(db: Exec, stationId: string, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ lockedUntil: redemptionThrottle.lockedUntil })
    .from(redemptionThrottle)
    .where(eq(redemptionThrottle.stationId, stationId))
    .limit(1);
  return row?.lockedUntil && row.lockedUntil.getTime() > now.getTime() ? row.lockedUntil : null;
}

/**
 * Until when a person's voucher look-ups are locked, or null (SCRUM-425): the
 * latest lock one of their misses set that has not run out. A lock runs
 * `VOUCHER_LOCK_MS` from the miss that set it, so only a miss of the last lock
 * period can hold one, and the read stays on one person's latest rows
 * (`voucher_miss_account_idx`).
 */
async function personLockedUntil(db: Exec, accountId: string, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ until: voucherMiss.accountLockedUntil })
    .from(voucherMiss)
    .where(
      and(
        eq(voucherMiss.accountId, accountId),
        gt(voucherMiss.occurredAt, new Date(now.getTime() - VOUCHER_LOCK_MS)),
        gt(voucherMiss.accountLockedUntil, now),
      ),
    )
    .orderBy(desc(voucherMiss.accountLockedUntil))
    .limit(1);
  return row?.until ?? null;
}

/**
 * The answer while a till's lock, a person's, or both are on; null while
 * neither is (SCRUM-425).
 *
 * With both on, the one that ends later answers, and the till's on a tie.
 * Nothing is looked up for that person at that till until both have run out,
 * so "try again in N minutes" must never tell them less than that. A person's
 * lock given, there is always an answer.
 */
function lockRefusal(tillUntil: Date | null, personUntil: Date, now: Date): AppError;
function lockRefusal(tillUntil: Date | null, personUntil: Date | null, now: Date): AppError | null;
function lockRefusal(tillUntil: Date | null, personUntil: Date | null, now: Date): AppError | null {
  if (tillUntil && (!personUntil || tillUntil.getTime() >= personUntil.getTime())) {
    return voucherErrors.locked(tillUntil, now);
  }
  return personUntil ? voucherErrors.personLocked(personUntil, now) : null;
}

/**
 * Refuse a till, or a person, whose voucher redemption is locked. Reads only,
 * on the pool, in front of `findForRedemption`'s transaction: somebody already
 * locked is answered at once rather than queued behind their own lock.
 */
export async function assertRedemptionUnlocked(
  db: Exec,
  stationId: string,
  accountId: string,
  now: Date,
): Promise<void> {
  const tillUntil = await tillLockedUntil(db, stationId, now);
  const refusal = lockRefusal(tillUntil, await personLockedUntil(db, accountId, now), now);
  if (refusal) throw refusal;
}

/** One wrong code at a till: when, and the code's hash — null for a miss counted before 0024. */
interface VoucherMiss {
  at: Date;
  codeHash: string | null;
}

/**
 * What a miss is remembered by: the SHA-256, in hex, of the code in the one
 * form the table stores (`normaliseBoothCode`) — never the code itself. The
 * code typed with a dash and the same code scanned hash alike, so they are one
 * miss (SCRUM-406).
 */
function voucherMissCodeHash(rawCode: string): string {
  return createHash('sha256').update(normaliseBoothCode(rawCode)).digest('hex');
}

/**
 * The misses a till's row holds: `recent_misses`, with the hash of each one's
 * code beside it in `recent_miss_code_hashes`.
 *
 * A list of hashes that does not line up with the times is not trusted, and
 * every miss in the row then counts one, as all of them did before 0024: a row
 * written before the column existed has none (null), and the api from before
 * 0024 — still answering for the moments a deploy overlaps it — writes the
 * times and leaves the hashes as they were.
 *
 * Only the length can show that. When that api drops exactly as many aged
 * times as it adds, the hashes still line up and sit beside the wrong times
 * until those misses age out, and a code tried again can take the place of a
 * miss that was not its own. That forgets one miss, only in exchange for a
 * retry, which tells a guesser nothing new, and only while a deploy overlaps.
 */
function recordedMisses(row: {
  recentMisses: Date[];
  recentMissCodeHashes: (string | null)[] | null;
}): VoucherMiss[] {
  const hashes = row.recentMissCodeHashes;
  const aligned = hashes !== null && hashes.length === row.recentMisses.length;
  return row.recentMisses.map((at, i) => ({ at, codeHash: aligned ? (hashes[i] ?? null) : null }));
}

/**
 * The misses still inside the window once `miss` is counted, oldest first.
 *
 * A code tried again replaces its own earlier entry rather than adding one, so
 * the row keeps one entry per code, and a code is in the window for as long as
 * its LATEST try is — the same answer as keeping every try and counting the
 * codes. A miss with no hash is never taken for another.
 */
function missesInWindow(
  recorded: readonly VoucherMiss[],
  miss: { at: Date; codeHash: string },
  now: Date,
): VoucherMiss[] {
  const inside = recorded.filter((m) => now.getTime() - m.at.getTime() < VOUCHER_MISS_WINDOW_MS);
  return [...inside.filter((m) => m.codeHash !== miss.codeHash), miss];
}

/** What counts towards the limit: each different code once, and each miss with no hash on its own. */
function distinctMisses(misses: readonly VoucherMiss[]): number {
  const codes = new Set<string>();
  let unhashed = 0;
  for (const m of misses) {
    if (m.codeHash === null) unhashed += 1;
    else codes.add(m.codeHash);
  }
  return unhashed + codes.size;
}

/**
 * The codes one person has missed inside the window, at every till, each once:
 * the different hashes among their rows (SCRUM-425). A code tried again is one
 * code for the person, as it is for the till (SCRUM-406).
 */
async function personMissedCodes(tx: Tx, accountId: string, now: Date): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ codeHash: voucherMiss.codeHash })
    .from(voucherMiss)
    .where(
      and(
        eq(voucherMiss.accountId, accountId),
        gt(voucherMiss.occurredAt, new Date(now.getTime() - VOUCHER_MISS_WINDOW_MS)),
      ),
    );
  return new Set(rows.map((r) => r.codeHash));
}

/** Where a till's budget stands once a miss is counted against it. */
interface TillMiss {
  lockedUntil: Date | null;
  /** This miss set the lock. */
  lockedNow: boolean;
  /** The lock was there before this miss, which was then not counted against the till. */
  alreadyLocked: boolean;
  /** The different codes in the window, this one included; read only when this miss set the lock. */
  misses: number;
}

/**
 * Where a person's budget stands once a miss is counted against it: the lock
 * this miss set, when it was their fifth. A person who was already locked has
 * no code checked (`findForRedemption`), so there is no earlier lock to carry.
 */
interface PersonMiss {
  lockedUntil: Date | null;
  /** The different codes in the window, this one included. */
  misses: number;
}

/** Both budgets once a miss is counted: the till's and the person's. */
interface CountedMiss {
  till: TillMiss;
  person: PersonMiss;
}

/**
 * The person's half of a miss (SCRUM-425), inside `findForRedemption`'s
 * transaction: the row that records it, and that person's budget.
 *
 * UNDER THE PERSON'S LOCK. `findForRedemption` took the person's advisory
 * lock before their code was looked up and read that they were not locked,
 * so one miss of theirs is counted at a time, whichever till it is at, and no
 * other code of theirs is looked up while it is: two different wrong codes
 * from one person at two tills at once are counted as two, and the fifth
 * locks before any later code of theirs is checked.
 *
 * The row is written for every miss counted: the record is every code that
 * was checked and found wrong. The lock outlasts the window, so when it runs
 * out every miss before it has left the window too: a fresh budget.
 */
async function countPersonMiss(
  tx: Tx,
  at: RedemptionStation,
  actor: { accountId: string; requestId?: string },
  codeHash: string,
  result: VoucherMissResult,
  now: Date,
): Promise<PersonMiss> {
  const codes = await personMissedCodes(tx, actor.accountId, now);
  codes.add(codeHash);
  const misses = codes.size;
  const lockedUntil =
    misses >= VOUCHER_MISS_LIMIT ? new Date(now.getTime() + VOUCHER_LOCK_MS) : null;
  await tx.insert(voucherMiss).values({
    id: newId(),
    operatorId: at.operatorId,
    branchId: at.branchId,
    stationId: at.id,
    accountId: actor.accountId,
    codeHash,
    result,
    requestId: actor.requestId ?? null,
    occurredAt: now,
    accountLockedUntil: lockedUntil,
  });
  if (lockedUntil) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: at.operatorId,
      branchId: at.branchId,
      action: 'voucher.redemption_locked',
      entityType: 'account',
      entityId: actor.accountId,
      requestId: actor.requestId ?? null,
      after: {
        lockedUntil: lockedUntil.toISOString(),
        misses,
        windowSeconds: VOUCHER_MISS_WINDOW_MS / 1000,
        stationId: at.id,
      },
    });
  }
  return { lockedUntil, misses };
}

/** "Nok (S-7KMQ)": the name a slip's Staff line prints and the staff code beside it — never a phone number. */
async function personLabelOf(db: Exec, accountId: string): Promise<string> {
  const who = await issuedByOf(db, accountId);
  return boothStaffLabel(who?.name, who?.code) ?? boothStaffCode(accountId);
}

/**
 * Count a wrong code at a till and against the person who tried it, and lock
 * the till on the fifth DIFFERENT code inside a minute.
 *
 * WHAT COUNTS IS THE CODE, NOT THE TRY (SCRUM-406). A family's slip printed
 * while its booth was offline answers "not found" until the booth has sent it,
 * and the counter tries it again; five tries of that one code locked the till
 * for every family and raised a guessing alert. Each miss now carries the hash
 * of its code (`voucherMissCodeHash`), and the limit counts the different
 * codes in the window (`distinctMisses`): the same code tried five times is one
 * miss, and five different wrong codes lock the till as they always did. A
 * miss recorded before migration 0024 has no hash and counts one on its own.
 *
 * IN THE TRANSACTION THE CODE WAS LOOKED UP IN (`findForRedemption`), under the
 * person's lock, and committed before the refusal it goes with is thrown: a
 * miss recorded in a transaction the refusal rolled back would count nothing.
 * The till's row is locked while it is read, so two different wrong codes
 * arriving together are counted as two.
 *
 * ONE LOCK ORDER, everywhere: the person's lock, then the till's row. The
 * person's was taken before the code was looked up and the till's row is
 * taken here, after it; nothing takes them the other way round, so one
 * person's checks at two tills and two people's at one till queue behind each
 * other but never deadlock.
 *
 * `till.alreadyLocked` is true when the till was locked BEFORE this miss — by
 * an earlier one in the window, perhaps one that arrived alongside it and
 * passed `assertRedemptionUnlocked` at the same moment. Such a miss is not
 * counted against the till (the lock has spent the window) and its caller
 * answers the lock rather than the miss's own refusal: every wrong code after
 * the fifth reads LOCKED, even in a burst.
 *
 * AND THE PERSON (SCRUM-425). In the same transaction the miss becomes a row
 * of `promo.voucher_miss`, and counts against the account that tried it,
 * across every till (`countPersonMiss`); `person` says where that budget
 * stands, as `till` does for the till's. The two are counted apart and lock
 * apart: a till full of different people's misses locks the till and nobody,
 * and one person's misses spread over several tills lock that person and no
 * till.
 *
 * The alerts are raised once all this is committed, on the pool
 * (`raiseProbingAlerts`) — the same rule `raiseBoothAlert` in `sync-booth.ts`
 * follows.
 */
async function recordVoucherMiss(
  tx: Tx,
  at: RedemptionStation,
  actor: { accountId: string; requestId?: string },
  rawCode: string,
  result: VoucherMissResult,
  now: Date,
): Promise<CountedMiss> {
  const codeHash = voucherMissCodeHash(rawCode);
  await tx
    .insert(redemptionThrottle)
    .values({ stationId: at.id, operatorId: at.operatorId, branchId: at.branchId })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(redemptionThrottle)
    .where(eq(redemptionThrottle.stationId, at.id))
    .for('update')
    .limit(1);
  if (!row) throw new Error('the redemption throttle row was not written');
  // The till's row just now, after the person's lock `findForRedemption` took
  // before the look-up: the one order, so nothing deadlocks.
  const person = await countPersonMiss(tx, at, actor, codeHash, result, now);
  if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
    return {
      person,
      till: {
        lockedUntil: row.lockedUntil,
        lockedNow: false,
        alreadyLocked: true,
        misses: row.recentMisses.length,
      },
    };
  }
  const recent = missesInWindow(recordedMisses(row), { at: now, codeHash }, now);
  const misses = distinctMisses(recent);
  if (misses < VOUCHER_MISS_LIMIT) {
    await tx
      .update(redemptionThrottle)
      .set({
        recentMisses: recent.map((m) => m.at),
        recentMissCodeHashes: recent.map((m) => m.codeHash),
        updatedAt: now,
      })
      .where(eq(redemptionThrottle.stationId, at.id));
    return {
      person,
      till: { lockedUntil: null, lockedNow: false, alreadyLocked: false, misses },
    };
  }
  const lockedUntil = new Date(now.getTime() + VOUCHER_LOCK_MS);
  // The budget after a lock is a fresh one: the misses that caused it are
  // spent on it, and are in the audit row below.
  await tx
    .update(redemptionThrottle)
    .set({
      recentMisses: [],
      recentMissCodeHashes: [],
      lockedUntil,
      lockCount: sql`${redemptionThrottle.lockCount} + 1`,
      updatedAt: now,
    })
    .where(eq(redemptionThrottle.stationId, at.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: at.operatorId,
    branchId: at.branchId,
    action: 'voucher.redemption_locked',
    entityType: 'station',
    entityId: at.id,
    requestId: actor.requestId ?? null,
    after: {
      lockedUntil: lockedUntil.toISOString(),
      misses,
      windowSeconds: VOUCHER_MISS_WINDOW_MS / 1000,
    },
  });
  return { person, till: { lockedUntil, lockedNow: true, alreadyLocked: false, misses } };
}

/**
 * The `redemption.probing` alerts for a miss that locked a till, a person, or
 * both — raised on the pool once the miss is committed (`recordVoucherMiss`).
 * The alert for a person's lock names them.
 */
async function raiseProbingAlerts(
  db: Db,
  at: RedemptionStation,
  actor: { accountId: string },
  { till, person }: CountedMiss,
): Promise<void> {
  if (till.lockedNow && till.lockedUntil) {
    await raiseAlert(
      db,
      {
        key: `redemption.probing:${at.id}`,
        category: 'redemption.probing',
        severity: 'warning',
        subject: `${at.name} (${at.branchName})`,
        summary:
          `${till.misses} wrong voucher codes inside a minute at ${at.name} — voucher ` +
          `redemption there is locked until ${formatVoucherDateTime(till.lockedUntil, at.timezone)}. ` +
          'Somebody may be guessing codes.',
        detail: {
          stationId: at.id,
          misses: till.misses,
          lockedUntil: till.lockedUntil.toISOString(),
          accountId: actor.accountId,
        },
        operatorId: at.operatorId,
        branchId: at.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  }
  if (person.lockedUntil) {
    const who = await personLabelOf(db, actor.accountId);
    await raiseAlert(
      db,
      {
        key: `redemption.probing:account:${actor.accountId}`,
        category: 'redemption.probing',
        severity: 'warning',
        subject: who,
        summary:
          `${person.misses} wrong voucher codes inside a minute from ${who}, the last at ` +
          `${at.name} (${at.branchName}) — their voucher redemption is locked at every till ` +
          `until ${formatVoucherDateTime(person.lockedUntil, at.timezone)}. ` +
          'Somebody may be guessing codes with this account.',
        detail: {
          accountId: actor.accountId,
          stationId: at.id,
          misses: person.misses,
          lockedUntil: person.lockedUntil.toISOString(),
        },
        operatorId: at.operatorId,
        branchId: at.branchId,
      },
      { flapWindowSeconds: 0 },
    );
  }
}

// --- Reading a voucher -------------------------------------------------------

type VoucherRow = typeof voucher.$inferSelect;
type DefinitionRow = typeof voucherDefinition.$inferSelect;

/**
 * What a voucher is worth, resolved from its definition at the branch it is
 * being redeemed at. Never from the till.
 */
export type VoucherEffect =
  | { type: 'amount_off'; appliesTo: 'tickets'; valueSatang: number }
  | { type: 'percent_off'; appliesTo: 'tickets'; valueBp: number }
  | {
      type: 'free_item';
      product: {
        id: string;
        name: string;
        kind: 'menu' | 'merch' | 'addon';
        priceSatang: number;
        weekendPriceSatang: number;
      };
    }
  | { type: 'free_kids_ticket'; package: { id: string; name: string } }
  | { type: 'hand_over' };

/**
 * A free item from its product link, at the branch doing the redeeming.
 *
 * HONOURED AT THE PARK THAT SELLS THE LINKED PRODUCT, not at every park. The
 * owner's "any branch" (24 Sept) meets a catalogue that is partly per branch,
 * and for a free item the catalogue decides. The linked row is used when it is
 * on sale here: an operator-wide product (no branch) is on sale at every park,
 * a park's own product only at that park. Otherwise a product of this branch
 * with the same `code` is looked for — but `product_code_unique` gives a code
 * to one live row in the whole operator, so while the linked row is live no
 * other park can hold its code, and this finds a row only once the linked one
 * has been archived. A product with no code, or one this park does not stock,
 * is refused by name (VOUCHER_ITEM_UNAVAILABLE) rather than guessed at. How
 * the other parks should honour it is the owner's open choice
 * (`docs/progress/plans/booth/AUDIT-CLOSING-2026-09-25.md`, M7 and Q7).
 */
async function freeItemAtBranch(
  db: Exec,
  operatorId: string,
  productId: string,
  branchId: string,
): Promise<typeof product.$inferSelect | null> {
  const [linked] = await db
    .select()
    .from(product)
    .where(and(eq(product.id, productId), eq(product.operatorId, operatorId)))
    .limit(1);
  if (!linked) return null;
  const onSaleHere = (row: typeof product.$inferSelect) =>
    row.active && !row.archivedAt && (row.branchId === null || row.branchId === branchId);
  if (onSaleHere(linked)) return linked;
  if (!linked.code) return null;
  const [twin] = await db
    .select()
    .from(product)
    .where(
      and(
        eq(product.operatorId, operatorId),
        eq(product.branchId, branchId),
        eq(product.code, linked.code),
        eq(product.active, true),
        isNull(product.archivedAt),
      ),
    )
    .limit(1);
  return twin ?? null;
}

/**
 * The 1+1's package at the branch doing the redeeming. A ticket package is
 * branch-owned and the same product at another park is the row with the same
 * NAME there — `ticket_package_name_unique` is (branch, name), and the seed
 * upserts every park's packages on exactly that key.
 */
async function packageAtBranch(
  db: Exec,
  operatorId: string,
  packageId: string,
  branchId: string,
): Promise<typeof ticketPackage.$inferSelect | null> {
  const [linked] = await db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.id, packageId), eq(ticketPackage.operatorId, operatorId)))
    .limit(1);
  if (!linked) return null;
  if (linked.branchId === branchId && linked.active && !linked.archivedAt) return linked;
  const [twin] = await db
    .select()
    .from(ticketPackage)
    .where(
      and(
        eq(ticketPackage.branchId, branchId),
        eq(ticketPackage.name, linked.name),
        eq(ticketPackage.active, true),
        isNull(ticketPackage.archivedAt),
      ),
    )
    .limit(1);
  return twin ?? null;
}

/**
 * What the definition says the voucher is worth, here.
 *
 * A definition whose free item has no product, or whose 1+1 has no package, is
 * refused with the counter's own words — "not set up yet, ask a manager" —
 * because the till cannot put on a bill a thing nobody has named (the Console
 * slice links them). An archived or inactive definition is still honoured: the
 * paper was printed under it, and archiving stops NEW vouchers, not old ones.
 */
export async function resolveVoucherEffect(
  db: Exec,
  operatorId: string,
  def: DefinitionRow,
  branchId: string,
): Promise<VoucherEffect> {
  switch (def.kind) {
    case 'discount': {
      if (def.valueType === 'amount' && (def.valueSatang ?? 0) > 0) {
        return { type: 'amount_off', appliesTo: 'tickets', valueSatang: def.valueSatang! };
      }
      if (def.valueType === 'percent' && (def.valueBp ?? 0) > 0) {
        return { type: 'percent_off', appliesTo: 'tickets', valueBp: def.valueBp! };
      }
      throw voucherErrors.notSetUp(def.code, 'the discount has no amount or percentage');
    }
    case 'free_item': {
      if (!def.productId) throw voucherErrors.notSetUp(def.code, 'no product is linked');
      const row = await freeItemAtBranch(db, operatorId, def.productId, branchId);
      if (!row) throw voucherErrors.itemUnavailable(def.code);
      return {
        type: 'free_item',
        product: {
          id: row.id,
          name: row.name,
          kind: row.kind,
          priceSatang: row.priceSatang,
          weekendPriceSatang: row.priceWeekendSatang ?? row.priceSatang,
        },
      };
    }
    case 'free_ticket': {
      if (!def.ticketPackageId)
        throw voucherErrors.notSetUp(def.code, 'no ticket package is linked');
      const row = await packageAtBranch(db, operatorId, def.ticketPackageId, branchId);
      if (!row) throw voucherErrors.itemUnavailable(def.code);
      return { type: 'free_kids_ticket', package: { id: row.id, name: row.name } };
    }
    case 'manual':
      return { type: 'hand_over' };
    default:
      // `wallet_credit` needs the wallet (S2-10a/b's neighbour), which is not
      // built; a till that "redeemed" one would load credit into nothing.
      throw voucherErrors.notSetUp(
        def.code,
        `a ${def.kind} voucher cannot be redeemed at a till yet`,
      );
  }
}

/**
 * The line the till's card shows under the prize name.
 *
 * A free item and a hand-over prize are something staff give the family, and
 * the card says to ring the voucher up FIRST. A scan and a hold use nothing
 * up: the voucher is used up only when a sale carrying it closes
 * (`consumeSaleVouchers`). Staff who handed the prize over at the scan and
 * then pressed Cancel would leave the voucher free for a second prize. Every
 * answer that carries this line — the look-up and the hold — comes before that
 * sale closes; once it has, a look-up answers ALREADY_REDEEMED instead.
 */
export function describeEffect(effect: VoucherEffect, prizeName: string): string {
  switch (effect.type) {
    case 'amount_off':
      return `${baht(effect.valueSatang)} THB off the ticket order`;
    case 'percent_off':
      return `${effect.valueBp / 100}% off the ticket order`;
    case 'free_item':
      return `Ring up to use it, then hand over: ${effect.product.name}`;
    case 'free_kids_ticket':
      return `Second kids ticket free — ${effect.package.name}`;
    case 'hand_over':
      return `Ring up to use it, then hand over: ${prizeName}`;
  }
}

/** A voucher as every answer here shows it. */
export interface VoucherView {
  id: string;
  code: string;
  source: string;
  /** `available` — nobody has it on a cart; `held_here` — this till has it. */
  state: 'available' | 'held_here';
  prize: { nameEn: string; nameTh: string | null };
  definitionCode: string;
  kind: string;
  effect: VoucherEffect;
  summary: string;
  issuedAt: string;
  issuedBooth: { stationId: string; name: string; codePrefix: string | null } | null;
  issuedBranch: { id: string; name: string };
  expiresAt: string | null;
  /** Printed before the check character existed, and looked up as it is. */
  legacyFormat: boolean;
  hold: { saleId: string; stationId: string; stationName: string; heldAt: string } | null;
  /**
   * Always false for a booth voucher, whatever its definition's offline policy
   * says: spec §8 — a printed slip is never trusted offline. See `refuseOffline`.
   */
  redeemableOffline: boolean;
  /**
   * Who was signed in at the booth when it printed — the Staff line of the
   * slip, so the counter can match the paper in the guest's hand: the name the
   * slip prints (the employee's nickname, else their name; null for an account
   * with no employee) and the staff code beside it (`boothStaffCode`, derived
   * from the account id exactly as the booth derived it). Null when the spin
   * was unattributed — nobody signed in, which a booth allows so that a login
   * problem never stops the wheel (`voucher.issued_by_account_id`).
   */
  issuedBy: { name: string | null; code: string } | null;
}

/** The Staff line of the slip, from the account the booth recorded. */
async function issuedByOf(db: Exec, accountId: string | null): Promise<VoucherView['issuedBy']> {
  if (!accountId) return null;
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, accountId))
    .limit(1);
  return { name: row?.nickname ?? row?.name ?? null, code: boothStaffCode(accountId) };
}

async function viewOf(
  db: Exec,
  v: VoucherRow,
  def: DefinitionRow,
  effect: VoucherEffect,
  state: VoucherView['state'],
  legacyFormat: boolean,
): Promise<VoucherView> {
  const [issuedBranch] = await db
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(eq(branch.id, v.branchId))
    .limit(1);
  // Which booth printed it lives on the spin that minted it, not on the voucher.
  const [booth] = await db
    .select({ stationId: station.id, name: station.name, codePrefix: station.codePrefix })
    .from(spin)
    .innerJoin(station, eq(station.id, spin.stationId))
    .where(eq(spin.voucherId, v.id))
    .limit(1);
  let hold: VoucherView['hold'] = null;
  if (v.heldSaleId && v.heldStationId && v.heldAt) {
    const [holder] = await db
      .select({ name: station.name })
      .from(station)
      .where(eq(station.id, v.heldStationId))
      .limit(1);
    hold = {
      saleId: v.heldSaleId,
      stationId: v.heldStationId,
      stationName: holder?.name ?? 'another till',
      heldAt: v.heldAt.toISOString(),
    };
  }
  return {
    id: v.id,
    code: v.code,
    source: v.source,
    state,
    prize: { nameEn: def.nameEn, nameTh: def.nameTh },
    definitionCode: def.code,
    kind: def.kind,
    effect,
    summary: describeEffect(effect, def.nameEn),
    issuedAt: v.issuedAt.toISOString(),
    issuedBooth: booth ?? null,
    issuedBranch: issuedBranch ?? { id: v.branchId, name: 'another branch' },
    expiresAt: v.expiresAt?.toISOString() ?? null,
    legacyFormat,
    hold,
    redeemableOffline: redeemableOffline(v, def),
    issuedBy: await issuedByOf(db, v.issuedByAccountId),
  };
}

/**
 * BOOTH VOUCHERS ARE REDEEMED ONLINE ONLY, whatever the definition says.
 *
 * `voucher_definition.offline_policy` defaults to `allow` and every seeded
 * definition carries it, on the reasoning that a lost ice cream is cheap.
 * Spec §8 says otherwise for the wheel — "redemption only via server
 * validation, never offline trust of the printed slip" — and the owner
 * confirmed it on 24 September, so for a voucher born from a spin the policy
 * is ignored here rather than trusted. The policy still means what it says for
 * the other sources (the legacy import, manual issue).
 */
function redeemableOffline(v: VoucherRow, def: DefinitionRow): boolean {
  if (v.source === 'booth') return false;
  return def.offlinePolicy === 'allow';
}

/**
 * Refuse to hold a voucher at a till whose box is working offline, when the
 * voucher may not be trusted offline. The sale such a till rings up is priced
 * and recorded on the box and reaches the platform later; a booth voucher on
 * it would be honoured on the strength of the slip alone, which is exactly
 * what spec §8 forbids.
 */
async function refuseOffline(
  db: Exec,
  at: RedemptionStation,
  v: VoucherRow,
  def: DefinitionRow,
): Promise<void> {
  if (redeemableOffline(v, def) || !at.boxId) return;
  const [state] = await db
    .select({ offline: boxState.offline })
    .from(boxState)
    .where(eq(boxState.boxId, at.boxId))
    .limit(1);
  if (state?.offline) {
    throw new AppError(409, 'VOUCHER_OFFLINE', VOUCHER_MESSAGES.offline);
  }
}

/** "Nok", or the name, or a neutral word — never a phone number in a refusal. */
async function staffNameOf(db: Exec, accountId: string | null): Promise<string> {
  if (!accountId) return 'a member of staff';
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, accountId))
    .limit(1);
  return row?.nickname ?? row?.name ?? 'a member of staff';
}

/**
 * The refusal for a voucher that cannot be redeemed at all any more: used up,
 * cancelled, or past its date. `null` when it can.
 */
async function stateRefusal(
  db: Exec,
  v: VoucherRow,
  at: RedemptionStation,
  now: Date,
): Promise<AppError | null> {
  if (v.status === 'redeemed') {
    const [br] = await db
      .select({ name: branch.name, timezone: branch.timezone })
      .from(branch)
      .where(eq(branch.id, v.redeemedBranchId ?? v.branchId))
      .limit(1);
    const [st] = v.redeemedStationId
      ? await db
          .select({ name: station.name })
          .from(station)
          .where(eq(station.id, v.redeemedStationId))
          .limit(1)
      : [];
    const [paidBy] = v.saleId
      ? await db
          .select({ receiptNumber: sale.receiptNumber })
          .from(sale)
          .where(eq(sale.id, v.saleId))
          .limit(1)
      : [];
    // The time on the clock of the park where it happened, which is the one
    // the guest and the receipt both remember.
    const when = v.redeemedAt
      ? formatVoucherDateTime(v.redeemedAt, br?.timezone ?? at.timezone)
      : 'an earlier visit';
    const place = [br?.name, st?.name].filter(Boolean).join(' / ') || 'another till';
    const who = await staffNameOf(db, v.redeemedByAccountId);
    return new AppError(
      409,
      'ALREADY_REDEEMED',
      `Already redeemed on ${when} at ${place} by ${who}`,
      {
        redeemedAt: v.redeemedAt?.toISOString() ?? null,
        branchName: br?.name ?? null,
        stationName: st?.name ?? null,
        staffName: who,
        saleId: v.saleId,
        receiptNumber: paidBy?.receiptNumber ?? null,
      },
    );
  }
  if (v.status === 'void') return new AppError(409, 'VOUCHER_VOID', VOUCHER_MESSAGES.void);
  const expiredAt =
    v.expiresAt && v.expiresAt.getTime() <= now.getTime()
      ? v.expiresAt
      : v.status === 'expired'
        ? (v.expiresAt ?? now)
        : null;
  if (expiredAt) {
    return new AppError(
      409,
      'EXPIRED',
      `Voucher expired on ${formatVoucherDate(expiredAt, at.timezone)}`,
      {
        expiresAt: expiredAt.toISOString(),
      },
    );
  }
  return null;
}

/**
 * Who has this voucher on a cart, and whether this till may take it.
 *
 *   free      nobody holds it.
 *   mine      it is held for the very sale asking (a repeated scan).
 *   takeable  held, but the hold is dead or abandoned and may be taken over:
 *               - `sale_closed`  the sale it names was closed, or rung up
 *                                without it;
 *               - `moved`        this same till put it on an earlier cart that
 *                                it has not rung up;
 *               - `lapsed`       another till's cart, not rung up, has held it
 *                                longer than the lapse window.
 *   live      another cart has it and is keeping it — "in use at …", or, when
 *             that cart was rung up with it, "on a sale already rung up at …"
 *             (`rungUpSaleId`).
 *
 * A SALE RUNG UP WITH THE VOUCHER IS NEVER TAKEN OVER — not by the till that
 * rang it up, not by another after any length of time, and whether or not a
 * tender has been tried. Its price counts the voucher; a card on the terminal
 * or a QR on the guest's phone may already be paying that price; and money
 * taken against a voucher another sale has since used is money no sale can be
 * closed for. It lets go only by being paid (consumed) or voided (released —
 * `POST /sales/:id/void`, which is the till's way out of a failed tender).
 */
type HoldState =
  | { kind: 'free' }
  | { kind: 'mine' }
  | { kind: 'takeable'; reason: VoucherReleaseReason; fromSaleId: string; fromStationId: string }
  | { kind: 'live'; stationId: string; rungUpSaleId: string | null };

async function holdStateOf(
  db: Exec,
  v: VoucherRow,
  at: { stationId: string; saleId: string | null },
  now: Date,
): Promise<HoldState> {
  if (!v.heldSaleId || !v.heldStationId || !v.heldAt) return { kind: 'free' };
  if (at.saleId && v.heldSaleId === at.saleId) return { kind: 'mine' };
  const from = { fromSaleId: v.heldSaleId, fromStationId: v.heldStationId };

  const [holder] = await db
    .select({ id: sale.id, status: sale.status })
    .from(sale)
    .where(eq(sale.id, v.heldSaleId))
    .limit(1);
  if (holder) {
    // Finalised, voided or refunded with the hold somehow left on it: a dead hold.
    if (holder.status !== 'tendering' && holder.status !== 'paid') {
      return { kind: 'takeable', reason: 'sale_closed', ...from };
    }
    const [applied] = await db
      .select({ id: voucherRedemption.id })
      .from(voucherRedemption)
      .where(
        and(
          eq(voucherRedemption.voucherId, v.id),
          eq(voucherRedemption.saleId, holder.id),
          eq(voucherRedemption.kind, 'applied'),
        ),
      )
      .limit(1);
    // Rung up WITHOUT it: its price does not count the voucher, so the hold is dead.
    if (!applied) return { kind: 'takeable', reason: 'sale_closed', ...from };
    // Rung up WITH it: kept until paid or voided. See the note above.
    return { kind: 'live', stationId: v.heldStationId, rungUpSaleId: holder.id };
  }
  // The cart has not been rung up: nothing is priced with the voucher yet and
  // no tender can be against a sale that does not exist.
  if (v.heldStationId === at.stationId) return { kind: 'takeable', reason: 'moved', ...from };
  if (now.getTime() - v.heldAt.getTime() >= VOUCHER_HOLD_LAPSE_MS) {
    return { kind: 'takeable', reason: 'lapsed', ...from };
  }
  return { kind: 'live', stationId: v.heldStationId, rungUpSaleId: null };
}

/**
 * The refusal for a voucher another cart is keeping.
 *
 * When that cart has been rung up with it, the words say so and say what to
 * do, because the answer is not "wait": the sale is paid or voided. The till
 * that rang it up is also told WHICH sale (`details.saleId`), so it can offer
 * the void; another till is told where, not which.
 */
async function heldElsewhere(
  db: Exec,
  stationId: string,
  at: RedemptionStation,
  rungUpSaleId: string | null = null,
): Promise<AppError> {
  const [holder] = await db
    .select({ name: station.name, branchId: station.branchId, branchName: branch.name })
    .from(station)
    .innerJoin(branch, eq(branch.id, station.branchId))
    .where(eq(station.id, stationId))
    .limit(1);
  const name = holder
    ? holder.branchId === at.branchId
      ? holder.name
      : `${holder.name} (${holder.branchName})`
    : 'another till';
  if (rungUpSaleId) {
    return new AppError(
      409,
      'HELD_ELSEWHERE',
      `This voucher is on a sale already rung up at ${name} — pay or void that sale first`,
      {
        stationId,
        stationName: holder?.name ?? null,
        rungUp: true,
        saleId: stationId === at.id ? rungUpSaleId : null,
      },
    );
  }
  return new AppError(409, 'HELD_ELSEWHERE', `This voucher is in use at ${name}`, {
    stationId,
    stationName: holder?.name ?? null,
    rungUp: false,
  });
}

/** The definition behind a voucher. Read, never locked — see `holdVoucher`. */
async function definitionBehind(db: Exec, v: VoucherRow): Promise<DefinitionRow> {
  const [def] = await db
    .select()
    .from(voucherDefinition)
    .where(eq(voucherDefinition.id, v.voucherDefinitionId))
    .limit(1);
  if (!def) throw new Error(`voucher ${v.id} names a definition that is not there`);
  return def;
}

// --- Look-up: what is this voucher? Never consumes. --------------------------

export interface RedemptionActor {
  accountId: string;
  operatorId: string;
  requestId?: string;
}

/**
 * The voucher behind a code with nothing changed — except, on a wrong code,
 * one more miss against this till and this person, and the row recording it.
 *
 * `db` is the pool and not a transaction on purpose: a miss has to be
 * committed whatever the answer is, so the code is checked in a transaction
 * of its own (`findForRedemption`).
 */
export async function lookupVoucher(
  db: Db,
  actor: RedemptionActor,
  at: RedemptionStation,
  rawCode: string,
  now: Date = new Date(),
): Promise<{ voucher: VoucherView }> {
  const found = await findForRedemption(db, actor, at, rawCode, now);
  const { v, def, legacyFormat } = found;
  const refusal = await stateRefusal(db, v, at, now);
  if (refusal) throw refusal;
  const hold = await holdStateOf(db, v, { stationId: at.id, saleId: null }, now);
  if (hold.kind === 'live') throw await heldElsewhere(db, hold.stationId, at, hold.rungUpSaleId);
  await refuseOffline(db, at, v, def);
  const effect = await resolveVoucherEffect(db, actor.operatorId, def, at.branchId);
  const state = v.heldStationId === at.id && hold.kind !== 'free' ? 'held_here' : 'available';
  return { voucher: await viewOf(db, v, def, effect, state, legacyFormat) };
}

/** What checking a code decided, with everything the check wrote committed (`findForRedemption`). */
type CodeCheck =
  | { kind: 'found'; v: VoucherRow; def: DefinitionRow; legacyFormat: boolean }
  | { kind: 'refused'; refusal: AppError }
  | { kind: 'missed'; result: VoucherMissResult; counted: CountedMiss };

/**
 * The code, checked, and the voucher it names — or the refusal, with the miss
 * counted. Shared by the look-up and the hold, so the two cannot disagree
 * about what a code is.
 *
 * ONE PERSON'S CODES ARE CHECKED ONE AT A TIME (SCRUM-425). The look-up and
 * the miss it may be are one act: one transaction on the pool, under the
 * person's advisory lock, in which their lock is read again, the code is
 * looked up and, on a miss, the till's row and the person's budget are counted
 * (`recordVoucherMiss`). It commits, and only then are the alerts raised and
 * the refusal thrown, on the pool. A code of theirs that arrives in a burst
 * waits its turn, and once the fifth miss has locked them it is refused
 * unchecked and leaves no row: however many arrive together, nothing of
 * theirs is looked up after the fifth miss, and a real code queued behind it
 * is refused like any other.
 *
 * Every query between taking the lock and the commit runs on that
 * transaction. One on the pool there could wait for a connection that the
 * person's other checks, queued on this lock, are all holding — ten of them
 * fill the pool — and nothing would move again.
 *
 * The lock reads in front, on the pool, answer somebody already locked at
 * once, without queueing (`assertRedemptionUnlocked`). Under the person's
 * lock only the person's is checked again; the till's stays as it was, read
 * in front and counted under the till's row.
 */
async function findForRedemption(
  db: Db,
  actor: RedemptionActor,
  at: RedemptionStation,
  rawCode: string,
  now: Date,
): Promise<{ v: VoucherRow; def: DefinitionRow; legacyFormat: boolean }> {
  await assertRedemptionUnlocked(db, at.id, actor.accountId, now);
  const code = classifyVoucherCode(rawCode);
  const checked = await db.transaction(async (tx): Promise<CodeCheck> => {
    const [namespace, key] = personMissLockId(actor.accountId);
    await tx.execute(sql`select pg_advisory_xact_lock(${namespace}::int4, ${key}::int4)`);
    const personUntil = await personLockedUntil(tx, actor.accountId, now);
    if (personUntil) {
      // Locked while this waited its turn, by a miss of theirs that went first.
      // Refused unchecked, and nothing is recorded: the code was never found
      // wrong. The till's lock is read only to say which of the two ends later.
      const tillUntil = await tillLockedUntil(tx, at.id, now);
      return { kind: 'refused', refusal: lockRefusal(tillUntil, personUntil, now) };
    }
    // Decided from the string: no voucher row is read for a code that cannot be one.
    if (code.kind !== 'invalid') {
      const [row] = await tx
        .select({ v: voucher, def: voucherDefinition })
        .from(voucher)
        .innerJoin(voucherDefinition, eq(voucherDefinition.id, voucher.voucherDefinitionId))
        .where(and(eq(voucher.operatorId, actor.operatorId), eq(voucher.code, code.code)))
        .limit(1);
      if (row) {
        const legacyFormat = code.kind === 'legacy_booth';
        return { kind: 'found', v: row.v, def: row.def, legacyFormat };
      }
    }
    // Only an eleven-character code with a right check can be a booth that has
    // not synced. A ten-character one is a current code with a character
    // dropped — no box mints ten any more, and every such deletion leaves a
    // well-formed ten — and a four-character one is Radar's shape, which
    // nothing has imported yet. Both are mistakes: "Invalid code".
    const result: VoucherMissResult = code.kind === 'current' ? 'not_found' : 'invalid';
    const counted = await recordVoucherMiss(tx, at, actor, rawCode, result, now);
    return { kind: 'missed', result, counted };
  });
  if (checked.kind === 'found') {
    return { v: checked.v, def: checked.def, legacyFormat: checked.legacyFormat };
  }
  if (checked.kind === 'refused') throw checked.refusal;
  await raiseProbingAlerts(db, at, actor, checked.counted);
  // A wrong code is answered with its own refusal — unless the till was
  // already locked when it was counted, which happens when several arrive
  // together at one till and all pass the reads in front before the fifth
  // locks it. Those answer the lock: the till's, or the person's when this
  // miss set theirs and it ends later.
  const { till, person } = checked.counted;
  if (till.alreadyLocked) {
    const refusal = lockRefusal(till.lockedUntil, person.lockedUntil, now);
    if (refusal) throw refusal;
  }
  throw checked.result === 'not_found' ? voucherErrors.notFound() : voucherErrors.invalid();
}

// --- Hold: put it on a cart --------------------------------------------------

export interface HoldResult {
  voucher: VoucherView;
  saleId: string;
  /** True when this sale already held it and nothing was written. */
  alreadyHeld: boolean;
}

/**
 * The part of a hold that must be committed even when the hold is refused —
 * the code check and the miss count — in a transaction of its own
 * (`findForRedemption`), committed before the hold's own transaction opens.
 * Returns the voucher's id for `holdVoucher`.
 */
export async function prepareHold(
  db: Db,
  actor: RedemptionActor,
  at: RedemptionStation,
  rawCode: string,
  now: Date = new Date(),
): Promise<{ voucherId: string; legacyFormat: boolean }> {
  const { v, legacyFormat } = await findForRedemption(db, actor, at, rawCode, now);
  return { voucherId: v.id, legacyFormat };
}

/**
 * Hold a voucher for a sale the till is ringing up.
 *
 * `saleId` is the id the till minted for its cart — the one it will send to
 * `POST /sales` — and there is usually no `pos.sale` row for it yet. When
 * there is, the cart has already been rung up at a price that did not include
 * this voucher, and holding it now would change nothing on the bill; that is
 * refused rather than quietly accepted.
 *
 * LOCKS, in the order the payment path takes them. `finaliseSale` locks the
 * sale and then consumes the voucher; this locks a holding sale BEFORE the
 * voucher, so the two can queue behind each other but never deadlock. A
 * takeover only ever happens from a cart with no sale row: a sale that has been
 * rung up keeps its voucher until it is paid or voided (`holdStateOf`).
 */
export async function holdVoucher(
  tx: Tx,
  actor: RedemptionActor,
  at: RedemptionStation,
  saleId: string,
  voucherId: string,
  legacyFormat: boolean,
  now: Date = new Date(),
): Promise<HoldResult> {
  const [target] = await tx
    .select({ id: sale.id, operatorId: sale.operatorId, status: sale.status })
    .from(sale)
    .where(eq(sale.id, saleId))
    .limit(1);
  if (target) {
    if (target.operatorId !== actor.operatorId)
      throw new AppError(404, 'NOT_FOUND', 'Sale not found');
    throw target.status === 'tendering' || target.status === 'paid'
      ? new AppError(
          409,
          'SALE_ALREADY_RUNG_UP',
          'This sale has already been rung up — scan the voucher before Pay',
        )
      : new AppError(409, 'SALE_CLOSED', `This sale is ${target.status}`);
  }

  // Who holds it now, read without a lock, so that sale can be locked first.
  const [peek] = await tx
    .select({ heldSaleId: voucher.heldSaleId })
    .from(voucher)
    .where(and(eq(voucher.id, voucherId), eq(voucher.operatorId, actor.operatorId)))
    .limit(1);
  if (!peek) throw voucherErrors.notFound();
  if (peek.heldSaleId && peek.heldSaleId !== saleId) {
    await tx.select({ id: sale.id }).from(sale).where(eq(sale.id, peek.heldSaleId)).for('update');
  }
  // Only the voucher row is locked. Its definition is shared by every voucher
  // of that kind, and locking it would queue every sale carrying one.
  const [v] = await tx
    .select()
    .from(voucher)
    .where(eq(voucher.id, voucherId))
    .for('update')
    .limit(1);
  if (!v) throw voucherErrors.notFound();
  const def = await definitionBehind(tx, v);

  const refusal = await stateRefusal(tx, v, at, now);
  if (refusal) throw refusal;
  // The holder changed between the look and the lock: somebody else was
  // quicker. Say so rather than decide on a sale this transaction never locked.
  if (
    v.heldSaleId !== peek.heldSaleId &&
    v.heldSaleId &&
    v.heldSaleId !== saleId &&
    v.heldStationId
  ) {
    throw await heldElsewhere(tx, v.heldStationId, at);
  }
  const hold = await holdStateOf(tx, v, { stationId: at.id, saleId }, now);
  if (hold.kind === 'live') throw await heldElsewhere(tx, hold.stationId, at, hold.rungUpSaleId);
  await refuseOffline(tx, at, v, def);
  // The value, resolved here as it will be when the sale is priced — a
  // definition with nothing linked is refused now, at the scan, rather than at
  // Pay with a guest waiting.
  const effect = await resolveVoucherEffect(tx, actor.operatorId, def, at.branchId);

  if (hold.kind === 'mine') {
    return {
      voucher: await viewOf(tx, v, def, effect, 'held_here', legacyFormat),
      saleId,
      alreadyHeld: true,
    };
  }

  const [other] = await tx
    .select({ id: voucher.id, code: voucher.code })
    .from(voucher)
    .where(and(eq(voucher.heldSaleId, saleId), eq(voucher.operatorId, actor.operatorId)))
    .limit(1);
  if (other) {
    throw new AppError(409, 'ONE_VOUCHER_PER_SALE', 'Only one voucher can be used on a sale', {
      heldVoucherId: other.id,
      heldCode: other.code,
    });
  }

  if (hold.kind === 'takeable') {
    // Recorded where it happened: at the till that took it over, by the person
    // who scanned it there. The till that lost it is in the audit row.
    await tx.insert(voucherRedemption).values({
      id: newId(),
      operatorId: actor.operatorId,
      voucherId: v.id,
      kind: 'released',
      saleId: hold.fromSaleId,
      branchId: at.branchId,
      stationId: at.id,
      accountId: actor.accountId,
      reason: hold.reason,
      requestId: actor.requestId ?? null,
      occurredAt: now,
    });
  }

  let taken: { id: string }[];
  try {
    taken = await tx
      .update(voucher)
      .set({
        heldSaleId: saleId,
        heldStationId: at.id,
        heldByAccountId: actor.accountId,
        heldAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(voucher.id, v.id),
          eq(voucher.status, 'issued'),
          sql`${voucher.heldSaleId} is not distinct from ${v.heldSaleId}`,
        ),
      )
      .returning({ id: voucher.id });
  } catch (error) {
    // `voucher_held_sale_unique`: another voucher reached this cart first.
    if (
      String((error as { cause?: unknown })?.cause ?? error).includes('voucher_held_sale_unique')
    ) {
      throw new AppError(409, 'ONE_VOUCHER_PER_SALE', 'Only one voucher can be used on a sale');
    }
    throw error;
  }
  if (taken.length === 0) {
    throw v.heldStationId
      ? await heldElsewhere(tx, v.heldStationId, at)
      : new AppError(409, 'HELD_ELSEWHERE', 'This voucher was just taken by another till');
  }

  await tx.insert(voucherRedemption).values({
    id: newId(),
    operatorId: actor.operatorId,
    voucherId: v.id,
    kind: 'held',
    saleId,
    branchId: at.branchId,
    stationId: at.id,
    accountId: actor.accountId,
    requestId: actor.requestId ?? null,
    occurredAt: now,
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: at.branchId,
    action: 'voucher.hold',
    entityType: 'voucher',
    entityId: v.id,
    requestId: actor.requestId ?? null,
    before:
      hold.kind === 'takeable'
        ? { heldSaleId: hold.fromSaleId, heldStationId: hold.fromStationId, released: hold.reason }
        : null,
    after: { code: v.code, saleId, stationId: at.id, effect: effect.type },
  });

  const held: VoucherRow = {
    ...v,
    heldSaleId: saleId,
    heldStationId: at.id,
    heldByAccountId: actor.accountId,
    heldAt: now,
  };
  return {
    voucher: await viewOf(tx, held, def, effect, 'held_here', legacyFormat),
    saleId,
    alreadyHeld: false,
  };
}

// --- Release: take it off the cart -------------------------------------------

export interface ReleaseResult {
  released: boolean;
  voucherId: string;
  saleId: string;
}

/**
 * Let a voucher go from a cart the till has not rung up yet — the line was
 * removed. Answers `released: false` when it is not held for that sale any
 * more, so a retried removal is not an error.
 *
 * A cart that HAS been rung up is refused: its price already counts the
 * voucher, and taking the voucher away would leave a sale nobody can pay for
 * honestly. Voiding the sale is what lets it go (`POST /sales/:id/void`).
 *
 * THE SALE IS READ AGAIN ONCE THE VOUCHER IS LOCKED, and that read decides.
 * Pay on this same cart may be under way: it locks the voucher's row while it
 * prices the cart (`resolveCartVoucher`) and keeps it until the sale is
 * written. A removal that read "not rung up yet" before that commit queues on
 * the row, and by the time it has it the sale has been rung up with the
 * voucher on its price. Each statement sees what was committed before it
 * began, so the read after the lock sees that sale. The read before the lock
 * only answers early, with nothing locked, for a sale rung up long ago.
 *
 * Only the till holding it lets it go: the cart is that till's, and another
 * till naming the cart's id is refused with where the voucher is.
 */
export async function releaseVoucher(
  tx: Tx,
  actor: RedemptionActor,
  at: RedemptionStation,
  saleId: string,
  voucherId: string,
  now: Date = new Date(),
): Promise<ReleaseResult> {
  /** The sale as it stands now: another operator's is not there, a rung-up one is refused. */
  const refuseIfRungUp = async (): Promise<void> => {
    const [target] = await tx
      .select({ operatorId: sale.operatorId, status: sale.status })
      .from(sale)
      .where(eq(sale.id, saleId))
      .limit(1);
    if (target && target.operatorId !== actor.operatorId) {
      throw new AppError(404, 'NOT_FOUND', 'Sale not found');
    }
    if (target && (target.status === 'tendering' || target.status === 'paid')) {
      throw new AppError(
        409,
        'SALE_ALREADY_RUNG_UP',
        'This sale has already been rung up with the voucher on it — void the sale to release it',
      );
    }
  };

  await refuseIfRungUp();
  const [v] = await tx
    .select()
    .from(voucher)
    .where(and(eq(voucher.id, voucherId), eq(voucher.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  if (!v) throw new AppError(404, 'NOT_FOUND', 'Voucher not found');
  // Again, with the voucher's row held: a Pay that held it first has finished
  // by now, committed or rolled back, and this read sees what it left. This is
  // the read that decides.
  await refuseIfRungUp();
  if (v.heldSaleId !== saleId) return { released: false, voucherId, saleId };
  if (v.heldStationId && v.heldStationId !== at.id) {
    throw await heldElsewhere(tx, v.heldStationId, at);
  }

  const freed = await tx
    .update(voucher)
    .set({
      heldSaleId: null,
      heldStationId: null,
      heldByAccountId: null,
      heldAt: null,
      updatedAt: now,
    })
    .where(and(eq(voucher.id, v.id), eq(voucher.heldSaleId, saleId), eq(voucher.status, 'issued')))
    .returning({ id: voucher.id });
  if (freed.length === 0) return { released: false, voucherId, saleId };

  await tx.insert(voucherRedemption).values({
    id: newId(),
    operatorId: actor.operatorId,
    voucherId: v.id,
    kind: 'released',
    saleId,
    branchId: at.branchId,
    stationId: at.id,
    accountId: actor.accountId,
    reason: 'line_removed',
    requestId: actor.requestId ?? null,
    occurredAt: now,
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: at.branchId,
    action: 'voucher.release',
    entityType: 'voucher',
    entityId: v.id,
    requestId: actor.requestId ?? null,
    before: { saleId, heldStationId: v.heldStationId },
    after: { reason: 'line_removed', stationId: at.id },
  });
  return { released: true, voucherId, saleId };
}

// --- On the bill: pricing a held voucher (called from `priceCart`) -----------

/**
 * Where a cart is being priced, for finding the voucher it carries.
 *
 *   quote   the cart names its till (`stationId` on the body); a voucher is
 *           found only among those held at that till, whatever cart id.
 *   commit  the sale id is known; a voucher is found only among those held
 *           for exactly that sale, at exactly that till, and is locked for the
 *           rest of the transaction that writes the sale.
 *
 * Neither looks a code up anywhere else. A quote that answered differently for
 * a real code and an invented one would be a way to test codes without the
 * guessing limit, so a code that is not held here is "not held here" whether
 * or not it exists.
 */
export interface CartVoucherContext {
  mode: 'quote' | 'commit';
  operatorId: string;
  branchId: string;
  stationId: string | null;
  saleId: string | null;
  now: Date;
}

export interface CartVoucherClaim {
  voucherId: string;
  code: string;
  definitionCode: string;
  /** What the sale's discount line says — `voucherLineLabel`, never the whole code. */
  label: string;
  effect: VoucherEffect;
}

/**
 * SCRUM-433 — A VOUCHER'S CODE WHERE A SALE SHOWS IT: an ellipsis and the
 * LAST FOUR characters, "…47WP".
 *
 * A sale is read back by anyone who can open History, and a voided sale's
 * voucher is free again, so a sale that showed the whole code handed a live
 * code to all of them. Four characters are enough to match a line to the slip
 * in the guest's hand and not enough to redeem it. So the discount line's
 * label (`voucherLineLabel`) and every sale answer's code field — the
 * `discounts[].code` of `GET /sales/:id`, the commit's `voucher.code` and its
 * free item's `payload.voucher.code` — carry this form. The whole code stays
 * where it is needed: the voucher row, its redemption ledger, and the sale's
 * own `pos.sale_discount` and `pos.sale_line` rows. A search by code goes there.
 */
export function maskVoucherCode(code: string): string {
  return `…${code.slice(-4)}`;
}

/**
 * SCRUM-433 — HOW A SALE'S DISCOUNT LINE NAMES THE VOUCHER: the type's name
 * and the code as `maskVoucherCode` shows it, "150 THB Voucher (voucher …47WP)".
 * Frozen on the row when the sale is written, like every label on a sale.
 */
function voucherLineLabel(nameEn: string, code: string): string {
  return `${nameEn} (voucher ${maskVoucherCode(code)})`;
}

/**
 * A voucher line's label as a sale answer gives it. Before 2246aef the line
 * was labelled with the whole code, "<type name> (voucher <code>)", and
 * migration 0025 rewrote those rows once into `voucherLineLabel`'s form, by the
 * same test as here: the label ends with " (voucher " and the row's own code.
 * This rewrites such a label on the way out as well, so no answer carries the
 * whole code whatever a row says: a row an older api wrote after the migration
 * had run, or a database restored from before it. Any other label is answered
 * as it is.
 */
export function maskedVoucherLineLabel(label: string, code: string): string {
  const whole = ` (voucher ${code})`;
  return label.endsWith(whole)
    ? voucherLineLabel(label.slice(0, label.length - whole.length), code)
    : label;
}

/**
 * Which of a cart's codes is a voucher, and the voucher held for it — or the
 * refusal. The till names a voucher by putting its code in `promoCodes`; what
 * it is worth is decided here.
 *
 * THE PARK'S OWN DISCOUNT CODES ARE NEVER VOUCHER CLAIMS. A code the operator
 * has defined in `pos.discount_definition` — active, withdrawn or archived — is
 * a discount wherever it appears on the cart, whatever it looks like:
 * SONGKRAN25, MOTHERSDAY and BIRTHDAY25 have the shape of a ten-character booth
 * code and MEMBERDAY25 the shape of an eleven-character one, and the till sends
 * every code it validated in `promos`. That lookup is made first.
 *
 * Refuses, before anything is priced:
 *   - a till-described promo (`promos[]`) under what could be a voucher's code
 *     — an eleven-character code whose check character is right, a legacy
 *     ten-character code, or a code held at this till — that is not one of
 *     the park's discount codes: the till does not get to say what a voucher
 *     takes off (VOUCHER_CLAIM_REFUSED);
 *   - two vouchers on one cart (ONE_VOUCHER_PER_SALE);
 *   - a voucher beside any other promo code (VOUCHER_NOT_COMBINABLE) — the
 *     park's "cannot be combined with other offers". Member tier prices and a
 *     staff member's manual discount are NOT offers in that sense and stay
 *     allowed: the tier is who the guest is, and a manual discount is a
 *     decision with a reason and a name on it. That reading is ours, stated
 *     here so it can be overruled in one place;
 *   - a voucher that is not held for this cart (VOUCHER_NOT_HELD), expired
 *     (EXPIRED), or whose item is not set up (VOUCHER_NOT_SET_UP).
 *
 * THIS FUNCTION ONLY READS. `POST /sales/quote` is on the write-nothing list
 * of `route-write-conformance.test.ts`, which follows a quote into this body.
 */
export async function resolveCartVoucher(
  db: Exec,
  ctx: CartVoucherContext,
  promoCodes: readonly string[],
  promos: readonly { code: string }[],
): Promise<{ claim: CartVoucherClaim | null; otherCodes: string[] }> {
  const heldHere = async (code: string): Promise<{ v: VoucherRow; def: DefinitionRow } | null> => {
    if (!ctx.stationId) return null;
    if (ctx.mode === 'commit') {
      if (!ctx.saleId) return null;
      // Locked for the rest of the transaction that writes the sale, so the
      // hold cannot move between being priced and being recorded. The voucher
      // row only; its definition is read beside it, unlocked.
      const [v] = await db
        .select()
        .from(voucher)
        .where(
          and(
            eq(voucher.operatorId, ctx.operatorId),
            eq(voucher.code, code),
            eq(voucher.heldSaleId, ctx.saleId),
            eq(voucher.heldStationId, ctx.stationId),
          ),
        )
        .for('update')
        .limit(1);
      return v ? { v, def: await definitionBehind(db, v) } : null;
    }
    const [row] = await db
      .select({ v: voucher, def: voucherDefinition })
      .from(voucher)
      .innerJoin(voucherDefinition, eq(voucherDefinition.id, voucher.voucherDefinitionId))
      .where(
        and(
          eq(voucher.operatorId, ctx.operatorId),
          eq(voucher.code, code),
          eq(voucher.heldStationId, ctx.stationId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  const isDiscountCode = await operatorDiscountCodes(db, ctx.operatorId, [
    ...promos.map((promo) => promo.code),
    ...promoCodes,
  ]);

  for (const promo of promos) {
    if (isDiscountCode(promo.code)) continue;
    const code = normaliseBoothCode(promo.code);
    if (couldBeBoothVoucher(code) || (await heldHere(code))) {
      throw new AppError(
        409,
        'VOUCHER_CLAIM_REFUSED',
        "A voucher's value comes from the platform — send the voucher's code, not a discount for it",
        { code: promo.code },
      );
    }
  }

  const claims: { code: string; held: { v: VoucherRow; def: DefinitionRow } | null }[] = [];
  const otherCodes: string[] = [];
  // The same voucher sent twice is one voucher, not two; an ordinary code is
  // passed through exactly as it came, as it always was.
  const addClaim = (code: string, held: { v: VoucherRow; def: DefinitionRow } | null): void => {
    if (!claims.some((c) => c.code === code)) claims.push({ code, held });
  };
  for (const raw of promoCodes) {
    // A discount code named with no definition attached: refused by name and
    // nothing taken off, exactly as before vouchers existed.
    if (isDiscountCode(raw)) {
      otherCodes.push(raw);
      continue;
    }
    const code = normaliseBoothCode(raw);
    if (hasBoothShape(code)) {
      // A booth-shaped code with the wrong check character is a mistake the
      // string alone proves; the till hears the counter's own words for it.
      if (code.length === BOOTH_CODE_LENGTH && !verifyBoothCode(code).ok)
        throw voucherErrors.invalid();
      addClaim(code, await heldHere(code));
      continue;
    }
    const held = await heldHere(code);
    if (held) addClaim(code, held);
    else otherCodes.push(raw);
  }

  if (claims.length === 0) return { claim: null, otherCodes };
  if (claims.length > 1) {
    throw new AppError(409, 'ONE_VOUCHER_PER_SALE', 'Only one voucher can be used on a sale');
  }
  if (promos.length > 0 || otherCodes.length > 0) {
    throw new AppError(
      409,
      'VOUCHER_NOT_COMBINABLE',
      'A voucher cannot be combined with another voucher or promo code on the same sale',
    );
  }
  const [only] = claims;
  if (!only?.held) {
    throw new AppError(
      409,
      'VOUCHER_NOT_HELD',
      'Scan the voucher at this till first — it is not held for this sale',
      { code: only?.code ?? null },
    );
  }
  const { v, def } = only.held;
  if (v.expiresAt && v.expiresAt.getTime() <= ctx.now.getTime()) {
    const [where] = await db
      .select({ timezone: branch.timezone })
      .from(branch)
      .where(eq(branch.id, ctx.branchId))
      .limit(1);
    throw new AppError(
      409,
      'EXPIRED',
      `Voucher expired on ${formatVoucherDate(v.expiresAt, where?.timezone ?? 'Asia/Bangkok')}`,
      { expiresAt: v.expiresAt.toISOString() },
    );
  }
  const effect = await resolveVoucherEffect(db, ctx.operatorId, def, ctx.branchId);
  return {
    claim: {
      voucherId: v.id,
      code: v.code,
      definitionCode: def.code,
      label: voucherLineLabel(def.nameEn, v.code),
      effect,
    },
    otherCodes,
  };
}

/**
 * Which of a cart's codes are the operator's own discount codes, in any
 * status — asked of `pos.discount_definition` and nothing else.
 *
 * THIS REVEALS NOTHING ABOUT VOUCHERS. It never reads `promo.voucher`: the
 * answer depends only on the park's discount catalogue, which the till already
 * holds (`GET /menu/discounts`) and validates its codes against. So a quote
 * cannot use it to learn whether a voucher code exists, and the guessing limit
 * has nothing to count.
 *
 * Matched on the code as sent, upper-cased, and normalised the way a booth code
 * is (spaces and dashes dropped), because the same string is judged as a
 * voucher code in that last form.
 */
async function operatorDiscountCodes(
  db: Exec,
  operatorId: string,
  codes: readonly string[],
): Promise<(raw: string) => boolean> {
  const forms = (raw: string): string[] => [
    ...new Set([raw.trim(), raw.trim().toUpperCase(), normaliseBoothCode(raw)]),
  ];
  const candidates = [...new Set(codes.flatMap(forms))].filter((code) => code.length > 0);
  if (candidates.length === 0) return () => false;
  const rows = await db
    .select({ code: discountDefinition.code })
    .from(discountDefinition)
    .where(
      and(
        eq(discountDefinition.operatorId, operatorId),
        inArray(discountDefinition.code, candidates),
      ),
    );
  const defined = new Set(rows.flatMap((row) => forms(row.code)));
  return (raw) => forms(raw).some((form) => defined.has(form));
}

/** The `packageId` a voucher's free-item line carries: a key no package has. */
export const VOUCHER_LINE_PACKAGE_KEY = 'voucher-line';

/**
 * A held voucher, turned into what the pricing engine takes: the discount it
 * gives, and — for a free item — the line that puts the item on the bill.
 *
 *   amount off   a fixed promo scoped to the ticket rows (`tickets` — kids and
 *                adults admission). The engine takes no more than those rows
 *                have left, and nothing is given back: "never more than the
 *                ticket total, and no change".
 *   percent off  the same scope, as a percentage.
 *   free item    the linked product on a line of its own at its shelf price
 *                for today's rate, and a fixed promo of exactly that price
 *                AIMED AT THAT LINE (`CartPromo.line`): gross the price,
 *                markdown the price, net zero — the item is handed over and
 *                booked as revenue foregone, as the engine's ruling 1 books a
 *                free-item promo. Aimed at the line, not at the product: a paid
 *                pizza beside the voucher's pizza stays a paid pizza, on its
 *                receipt line as on the bill.
 *   1+1 kids     with two or more kids tickets of the linked package on the
 *                cart, one kid's price for that package, AIMED AT THE KIDS OF
 *                ONE LINE of that package — the line with the most kid value
 *                left once the manual discounts have come off, the first such
 *                line on a tie — so the free ticket is one kid's, never a
 *                share of the adults' or of every line's, and never half a
 *                kid off a line a manual discount already reduced (audit L1).
 *                Only the linked package qualifies, which is how "not valid
 *                for Eat & Play" holds: that package is never the one linked.
 *   hand over    a promo worth nothing, so the sale still records which voucher
 *                it carried, and no line: the prize has no product and no
 *                price. On its own it is still a sale — a ฿0 one, which
 *                `priceCart` lets past its empty-cart check — because a sale
 *                closing is the only thing that uses a voucher up.
 *
 * `applicable: false` with a reason when the cart has nothing the voucher can
 * come off — a quote shows it, a commit refuses it, so a voucher is never used
 * up for nothing.
 */
/** What else is on the bill, for aiming a 1+1: the manual discounts, and the tax rules the engine runs under. */
export interface VoucherAimContext {
  manualDiscounts: readonly ManualDiscount[];
  taxConfig: TaxConfigShape;
}

export function voucherPricing(
  claim: CartVoucherClaim,
  lines: readonly TicketCartLine[],
  ctx: PricingContext,
  tierCode: string,
  aim: VoucherAimContext,
): { promo: CartPromo; line: TicketCartLine | null; notApplicable: string | null } {
  const base = { code: claim.code, label: claim.label } as const;
  const effect = claim.effect;
  switch (effect.type) {
    case 'amount_off':
      return {
        promo: { ...base, type: 'fixed', value: effect.valueSatang, target: { kind: 'tickets' } },
        line: null,
        notApplicable:
          'This voucher comes off tickets, and this sale has no tickets left to take it off',
      };
    case 'percent_off':
      return {
        promo: {
          ...base,
          type: 'percent',
          value: effect.valueBp / 100,
          target: { kind: 'tickets' },
        },
        line: null,
        notApplicable:
          'This voucher comes off tickets, and this sale has no tickets left to take it off',
      };
    case 'free_item': {
      const price = resolveRate(
        { weekday: effect.product.priceSatang, weekend: effect.product.weekendPriceSatang },
        ctx.mode,
      );
      // A shop item and a ticket add-on both book as merchandise: the engine's
      // free-item line knows menu and merch, and an add-on is not food.
      const itemKind = effect.product.kind === 'menu' ? ('menu' as const) : ('merch' as const);
      return {
        promo: {
          ...base,
          type: 'fixed',
          value: price,
          // The voucher's own line, and only it: see the note above.
          line: { lineId: claim.voucherId },
        },
        line: {
          // The voucher's own id: unique on the cart, and a uuid, which
          // `pos.sale_line.cart_line_id` requires.
          id: claim.voucherId,
          packageId: VOUCHER_LINE_PACKAGE_KEY,
          package: { prices: {}, adultRules: null },
          tier: tierCode,
          kids: 0,
          adults: 0,
          socks: 0,
          addOns: [],
          promoItem: { itemId: effect.product.id, itemKind, name: effect.product.name, price },
          lineTotal: price,
        },
        notApplicable: null,
      };
    }
    case 'free_kids_ticket': {
      const qualifying = lines.filter((l) => l.packageId === effect.package.id && !l.promoItem);
      const kids = qualifying.reduce((sum, l) => sum + l.kids, 0);
      // The kid whose ticket is free is on the line of the package with the
      // most kid value left once the manual discounts have come off — the
      // first such line on a tie — and the price is that line's. Aimed at the
      // first line with a kid, a 50% manual discount on that line left the
      // voucher taking half a kid while the next line's kid paid in full
      // (audit L1).
      const aimedAt = qualifying
        .filter((l) => l.kids > 0)
        .reduce<{ line: TicketCartLine; left: number } | null>((best, line) => {
          const left = kidValueLeft(line, lines, aim, ctx);
          return best && best.left >= left ? best : { line, left };
        }, null)?.line;
      const kidPrice = aimedAt ? priceForTier(aimedAt.package, aimedAt.tier, ctx.mode) : 0;
      return {
        promo: {
          ...base,
          type: 'fixed',
          value: kids >= 2 ? kidPrice : 0,
          ...(aimedAt
            ? { line: { lineId: aimedAt.id, component: { kind: 'kids' as const } } }
            : {}),
        },
        line: null,
        notApplicable: `The 1+1 kids ticket needs two kids tickets of ${effect.package.name} on this sale`,
      };
    }
    case 'hand_over':
      return {
        promo: { ...base, type: 'fixed', value: 0 },
        line: null,
        notApplicable: null,
      };
  }
}

/**
 * How much of one line's kids row a discount aimed at it could still take,
 * once the manual discounts on the cart have come off.
 *
 * The engine's own answer, read by aiming a probe of unlimited value at that
 * row and seeing what it takes: `computeTicketCartTotals` applies the manual
 * discounts first — line ones in order, then order-wide ones spread across
 * every unit — and clamps a line-aimed promo to what its scope has left. Read
 * that way, this restates neither the discount order nor the spreading
 * arithmetic, both of which are the engine's to change.
 */
function kidValueLeft(
  line: TicketCartLine,
  lines: readonly TicketCartLine[],
  aim: VoucherAimContext,
  ctx: PricingContext,
): number {
  const probe: CartPromo = {
    code: 'probe',
    label: 'probe',
    type: 'fixed',
    value: Number.MAX_SAFE_INTEGER,
    line: { lineId: line.id, component: { kind: 'kids' } },
  };
  const totals = computeTicketCartTotals(lines, [probe], aim.manualDiscounts, aim.taxConfig, ctx);
  return totals.appliedPromos[0]?.amount ?? 0;
}

/** The configured value a voucher's discount row records: satang, or basis points for a percentage. */
export function voucherConfiguredValue(promo: PromoDiscount): number {
  return promo.type === 'percent' ? Math.round(promo.value * 100) : promo.value;
}

// --- When Pay is pressed, and when the money is in ---------------------------

export interface SaleVoucherScope {
  saleId: string;
  operatorId: string;
  branchId: string;
  stationId: string;
}

/**
 * Pay was pressed on a cart carrying a voucher: record that this sale was
 * priced with it. The discount row says how much; this row says which voucher,
 * and it is what the payment step reads to know what it has to use up.
 */
export async function recordVoucherApplied(
  tx: Tx,
  scope: SaleVoucherScope,
  claim: CartVoucherClaim,
  actor: { accountId: string; requestId?: string },
  amountSatang: number,
  now: Date,
): Promise<void> {
  await tx.insert(voucherRedemption).values({
    id: newId(),
    operatorId: scope.operatorId,
    voucherId: claim.voucherId,
    kind: 'applied',
    saleId: scope.saleId,
    branchId: scope.branchId,
    stationId: scope.stationId,
    accountId: actor.accountId,
    requestId: actor.requestId ?? null,
    occurredAt: now,
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: scope.operatorId,
    branchId: scope.branchId,
    action: 'voucher.apply',
    entityType: 'voucher',
    entityId: claim.voucherId,
    requestId: actor.requestId ?? null,
    after: {
      code: claim.code,
      saleId: scope.saleId,
      stationId: scope.stationId,
      effect: claim.effect.type,
      amountSatang,
    },
  });
}

/** The vouchers a sale was priced with, in the order they were applied. */
async function appliedVoucherIds(db: Exec, scope: SaleVoucherScope): Promise<string[]> {
  const rows = await db
    .select({ voucherId: voucherRedemption.voucherId })
    .from(voucherRedemption)
    .where(
      and(
        eq(voucherRedemption.saleId, scope.saleId),
        eq(voucherRedemption.operatorId, scope.operatorId),
        eq(voucherRedemption.kind, 'applied'),
      ),
    )
    .orderBy(asc(voucherRedemption.occurredAt));
  return [...new Set(rows.map((r) => r.voucherId))];
}

/**
 * SCRUM-433 — the codes of the vouchers a sale was priced with, read from its
 * `applied` rows in the redemption ledger. That row is the one record tying a
 * sale to its voucher for good: a void lets the voucher go, and another sale
 * may have used it since. A voucher's discount row carries the voucher's code
 * (`recordVoucherApplied` and the row are written from the same claim), so
 * this is how `GET /sales/:id` knows which of a sale's `promo` rows are a
 * voucher's, and answers their code as `maskVoucherCode` shows it. A voucher
 * never shares a sale with a park's code (`resolveCartVoucher`), so every other
 * row is answered as it was written.
 */
export async function saleVoucherCodes(
  db: Exec,
  operatorId: string,
  saleId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ code: voucher.code })
    .from(voucherRedemption)
    .innerJoin(voucher, eq(voucher.id, voucherRedemption.voucherId))
    .where(
      and(
        eq(voucherRedemption.saleId, saleId),
        eq(voucherRedemption.operatorId, operatorId),
        eq(voucherRedemption.kind, 'applied'),
      ),
    );
  return new Set(rows.map((row) => row.code));
}

/**
 * The refusal when a sale's voucher is no longer its own. A sale rung up with
 * a voucher is never taken over (`holdStateOf`) and its line is never taken
 * off (`releaseVoucher`, which decides on the sale as it stands once it holds
 * the voucher's row, so a removal racing Pay is refused too); a void lets the
 * voucher go but closes the sale for good. So this is a state only a
 * correction outside the api reaches — but a tender or a close that met it
 * would be taking money towards a price nobody can honour, so it is refused
 * with one code, VOUCHER_NOT_HELD, and — when another sale has used the
 * voucher since — who, when and where in the words and the details.
 */
async function lostVoucher(
  db: Exec,
  voucherId: string,
  scope: SaleVoucherScope,
  now: Date,
): Promise<AppError> {
  const [v] = await db.select().from(voucher).where(eq(voucher.id, voucherId)).limit(1);
  const [at] = await db
    .select({ name: station.name, branchName: branch.name, timezone: branch.timezone })
    .from(station)
    .innerJoin(branch, eq(branch.id, station.branchId))
    .where(eq(station.id, scope.stationId))
    .limit(1);
  if (v && at) {
    const refusal = await stateRefusal(
      db,
      v,
      {
        id: scope.stationId,
        name: at.name,
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        branchName: at.branchName,
        timezone: at.timezone,
        boxId: null,
      },
      now,
    );
    if (refusal && refusal.code === 'ALREADY_REDEEMED') {
      const redeemed = refusal.message.replace(/^Already redeemed/, 'already redeemed');
      return new AppError(
        409,
        'VOUCHER_NOT_HELD',
        `The voucher on this sale is no longer held for it: ${redeemed} — void this sale and ring it up again`,
        { voucherId, redeemed: refusal.details ?? null },
      );
    }
  }
  return new AppError(
    409,
    'VOUCHER_NOT_HELD',
    'The voucher on this sale is no longer held for it — void this sale and ring it up again',
    { voucherId },
  );
}

/**
 * THE TENDER GUARD: a sale priced with a voucher takes no money unless the
 * voucher is still held for it. Otherwise money would be taken towards a price
 * nobody can honour — the sale could never close (the use-up would refuse it)
 * and the guest's money would sit on it.
 *
 * Called at the start of every tender the api starts, before the attempt is
 * written (the offline replay is the one path that banks money without it — the
 * close's use-up catches a lost voucher there): cash and every counter tender (`finaliseSale`), a card or
 * QR sent to a terminal (`startTerminalTender`), a card keyed in off a slip
 * (`recordManualTender`) and a gateway QR (`openQrAttempt`). The caller holds
 * the sale's row lock; this locks the voucher rows after it, the order every
 * other path takes. VOUCHER_NOT_HELD, with nothing written, when it fails.
 */
export async function assertSaleVouchersHeld(
  tx: Tx,
  scope: SaleVoucherScope,
  now: Date,
): Promise<void> {
  for (const voucherId of await appliedVoucherIds(tx, scope)) {
    const [v] = await tx
      .select({ heldSaleId: voucher.heldSaleId, status: voucher.status })
      .from(voucher)
      .where(eq(voucher.id, voucherId))
      .for('update')
      .limit(1);
    if (!v || v.status !== 'issued' || v.heldSaleId !== scope.saleId) {
      throw await lostVoucher(tx, voucherId, scope, now);
    }
  }
}

/**
 * USE THEM UP — in the transaction that closes the sale, and nowhere else.
 *
 * THE GUARD IS THE UPDATE ITSELF: it changes the voucher only while it is
 * still `issued` AND still held for THIS sale, and it reports how many rows it
 * changed. Two transactions closing over one voucher queue on its row; the
 * first changes it, and the second finds nothing to change and is refused, its
 * whole transaction — tender, receipt number and all — rolled back. No read
 * before it can stand in for it: a read and a write are two statements, and
 * the race is between them.
 *
 * It holds on its own, not only behind the tender guard: the ฿0 close in
 * `commitSale` and a gateway settlement closing a sale (`settlePaidAttempt` →
 * `finaliseSale` with nothing owed) take no tender at the counter, so this
 * update is the only check between them and a second use.
 *
 * A voucher held for this sale that it was NOT priced with — scanned while Pay
 * was already being pressed — is let go here rather than kept on a closed
 * sale for ever.
 */
export async function consumeSaleVouchers(
  tx: Tx,
  scope: SaleVoucherScope,
  actor: { accountId: string; requestId?: string },
  now: Date,
): Promise<{ consumed: string[] }> {
  const applied = await appliedVoucherIds(tx, scope);
  const consumed: string[] = [];
  for (const voucherId of applied) {
    const used = await tx
      .update(voucher)
      .set({
        status: 'redeemed',
        redeemedAt: now,
        redeemedByAccountId: actor.accountId,
        redeemedBranchId: scope.branchId,
        redeemedStationId: scope.stationId,
        saleId: scope.saleId,
        heldSaleId: null,
        heldStationId: null,
        heldByAccountId: null,
        heldAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(voucher.id, voucherId),
          eq(voucher.status, 'issued'),
          eq(voucher.heldSaleId, scope.saleId),
        ),
      )
      .returning({ id: voucher.id, code: voucher.code });
    if (used.length === 0) throw await lostVoucher(tx, voucherId, scope, now);

    await tx.insert(voucherRedemption).values({
      id: newId(),
      operatorId: scope.operatorId,
      voucherId,
      kind: 'consumed',
      saleId: scope.saleId,
      branchId: scope.branchId,
      stationId: scope.stationId,
      accountId: actor.accountId,
      requestId: actor.requestId ?? null,
      occurredAt: now,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: scope.operatorId,
      branchId: scope.branchId,
      action: 'voucher.redeem',
      entityType: 'voucher',
      entityId: voucherId,
      requestId: actor.requestId ?? null,
      before: { status: 'issued', heldSaleId: scope.saleId },
      after: {
        status: 'redeemed',
        code: used[0]!.code,
        saleId: scope.saleId,
        branchId: scope.branchId,
        stationId: scope.stationId,
        redeemedAt: now.toISOString(),
      },
    });
    consumed.push(voucherId);
  }

  const strays = await tx
    .select({ id: voucher.id })
    .from(voucher)
    .where(and(eq(voucher.heldSaleId, scope.saleId), eq(voucher.operatorId, scope.operatorId)));
  const strayIds = strays.map((s) => s.id).filter((id) => !consumed.includes(id));
  if (strayIds.length > 0) {
    await tx
      .update(voucher)
      .set({
        heldSaleId: null,
        heldStationId: null,
        heldByAccountId: null,
        heldAt: null,
        updatedAt: now,
      })
      .where(and(inArray(voucher.id, strayIds), eq(voucher.heldSaleId, scope.saleId)));
    for (const stray of strays.filter((s) => strayIds.includes(s.id))) {
      await tx.insert(voucherRedemption).values({
        id: newId(),
        operatorId: scope.operatorId,
        voucherId: stray.id,
        kind: 'released',
        saleId: scope.saleId,
        branchId: scope.branchId,
        stationId: scope.stationId,
        accountId: actor.accountId,
        reason: 'sale_closed',
        requestId: actor.requestId ?? null,
        occurredAt: now,
      });
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        action: 'voucher.release',
        entityType: 'voucher',
        entityId: stray.id,
        requestId: actor.requestId ?? null,
        before: { heldSaleId: scope.saleId },
        after: { reason: 'sale_closed', stationId: scope.stationId },
      });
    }
  }
  return { consumed };
}

// --- When a sale rung up with a voucher is voided ----------------------------

/**
 * The vouchers a sale holds, locked — what a void is about to let go. Read by
 * the void before it changes the sale's status, after it has locked the sale:
 * the same order the payment path takes (sale, then voucher).
 */
export async function lockVouchersHeldFor(
  tx: Tx,
  scope: { saleId: string; operatorId: string },
): Promise<{ id: string; code: string }[]> {
  return tx
    .select({ id: voucher.id, code: voucher.code })
    .from(voucher)
    .where(and(eq(voucher.heldSaleId, scope.saleId), eq(voucher.operatorId, scope.operatorId)))
    .orderBy(asc(voucher.id))
    .for('update');
}

/**
 * The audit rows for the vouchers a void let go.
 *
 * The LEDGER rows are the database's: the trigger in migration 0021 releases a
 * voided sale's vouchers and writes `released / sale_voided` in the same
 * statement that voids it, whoever voided it. What a trigger cannot know is who
 * asked and under which request, and that is this row.
 */
export async function auditVoidReleases(
  tx: Tx,
  scope: SaleVoucherScope,
  released: readonly { id: string; code: string }[],
  actor: { accountId: string; requestId?: string },
  reason: string,
): Promise<void> {
  for (const v of released) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: scope.operatorId,
      branchId: scope.branchId,
      action: 'voucher.release',
      entityType: 'voucher',
      entityId: v.id,
      requestId: actor.requestId ?? null,
      before: { heldSaleId: scope.saleId },
      after: {
        reason: 'sale_voided',
        code: v.code,
        stationId: scope.stationId,
        voidReason: reason,
      },
    });
  }
}
