import type { WeekdayWeekendPrice } from '@/types';
import { getPricingOverrides } from '@/store/catalogStore';
import {
  DEFAULT_BUSINESS_DAY_START_MINUTES,
  businessDate,
  dayOfWeekOfIsoDate,
  isIsoDate,
  isoDateInTz,
  parseDayStart,
} from '@oto/shared';

/**
 * Which rate is active for a sale. Every price in the catalog stores a
 * {weekday, weekend} pair; this is the ONE resolver that turns "what day is
 * it" into "which of those two numbers applies" — see getRateModeForDate.
 */
export type RateMode = 'weekday' | 'weekend';

export interface RateModeResult {
  mode: RateMode;
  /** Human-readable reason shown on the POS indicator, e.g. "Weekend pricing — Songkran". */
  reason: string;
  /** Name of the matched holiday override, when the mode came from one. */
  overrideName?: string;
}

/**
 * The branch's timezone, which is the calendar the trading day is read off.
 *
 * SCRUM-229: the API resolves the rate mode on `branchToday(branch.timezone)`,
 * and until this was here the till resolved it on whatever timezone the browser
 * was set to. The two agreed only on a device set to Asia/Bangkok, and on a
 * Friday→Saturday boundary they parted company for as long as the offset —
 * the header chip (which already reads the API) saying weekend while the cart
 * charged weekday, or the reverse.
 *
 * The default is the one branch trading today. It is a starting value, not an
 * assumption about the estate: `setBranchTimezone` overwrites it with the real
 * one the moment the catalog loads, on every branch and every branch switch.
 */
const DEFAULT_BRANCH_TIMEZONE = 'Asia/Bangkok';
let branchTimezone = DEFAULT_BRANCH_TIMEZONE;

/**
 * Point the trading-day calendar at a branch. Called from the catalog
 * hydration, which is the first thing that knows which branch this till is.
 *
 * An unusable zone falls back rather than throwing: a branch row with a typo in
 * its timezone must not take the till down, and every price on the screen goes
 * through here.
 */
export function setBranchTimezone(timeZone: string | null | undefined): void {
  if (!timeZone) {
    branchTimezone = DEFAULT_BRANCH_TIMEZONE;
    return;
  }
  try {
    isoDateInTz(new Date(), timeZone); // throws RangeError on an unknown zone
    branchTimezone = timeZone;
  } catch {
    branchTimezone = DEFAULT_BRANCH_TIMEZONE;
  }
}

export function getBranchTimezone(): string {
  return branchTimezone;
}

/**
 * When the branch's trading day starts, in minutes after midnight (SCRUM-308).
 *
 * A sale is priced on the trading day — `branch.business_day_start`, 05:00 by
 * default — and until this was here the till read the calendar day: between
 * midnight and five the header chip said one thing and the receipt said
 * another. Seen on staging at 00:20 on the 23rd: chip Weekday, basket priced
 * Weekend for a holiday on the 22nd, which was still the trading day. Set from
 * the same hydration that sets the timezone; unparseable falls back to the
 * default rather than taking the till down.
 */
let branchDayStartMinutes = DEFAULT_BUSINESS_DAY_START_MINUTES;

export function setBranchDayStart(time: string | null | undefined): void {
  if (!time) {
    branchDayStartMinutes = DEFAULT_BUSINESS_DAY_START_MINUTES;
    return;
  }
  try {
    branchDayStartMinutes = parseDayStart(time);
  } catch {
    branchDayStartMinutes = DEFAULT_BUSINESS_DAY_START_MINUTES;
  }
}

/**
 * Today's trading date (yyyy-mm-dd) at the branch, from THIS DEVICE'S clock.
 *
 * What this does and does not fix: it places the device's instant on the
 * branch's calendar and its trading day, so a till in another timezone now
 * agrees with the API about which day it is, and a till at 00:30 agrees with
 * the receipt it is about to print. It cannot correct a device whose clock is
 * simply wrong — an iPad two days behind computes a branch date two days
 * behind. That case is covered by the server answer below, which is computed
 * on the platform's clock; this is the fallback for when the platform is
 * unreachable, and it is the best a till alone can do.
 *
 * The same `businessDate` the sale service prices on, so the two cannot drift.
 */
export function branchTradingDate(now: Date = new Date()): string {
  return businessDate(now, branchTimezone, branchDayStartMinutes);
}

/** The API's answer for the branch's today, as `/branches/:id/pricing-mode` returns it. */
export interface BranchRateModeAnswer extends RateModeResult {
  /** The branch's trading date the answer was computed for (yyyy-mm-dd). */
  date: string;
}

/**
 * The platform's own answer for today, and when this device received it.
 *
 * This is what protects a till with a wrong clock: the date and mode are
 * decided on the platform's clock in the branch's timezone, so a device that
 * disagrees about what day it is still charges what the branch is charging.
 * The header chip polls this endpoint every 60s (PricingModeIndicator); the
 * cart now reads the same answer, so the chip and the price cannot disagree
 * while it is live.
 */
let serverAnswer: { answer: RateModeResult; date: string; receivedAtMs: number } | null = null;

/**
 * How long an answer is trusted after it arrives. Ten minutes is ten of the
 * chip's 60s polls: a blip, a reload or a slow mall connection never drops the
 * till back onto its own clock, and a till that has been out of contact longer
 * than that is genuinely offline and falls back to `branchTradingDate` —
 * timezone-correct, and no staler than the device's own clock.
 */
const SERVER_ANSWER_TTL_MS = 10 * 60_000;

/**
 * Record the platform's answer for the branch's today.
 *
 * `null` clears it, for a branch switch or a sign-out. **Nothing passes null
 * today** — all three callers pass an answer — and this comment said
 * otherwise until a reviewer checked. The parameter stays because clearing on
 * a branch switch is the correct behaviour and the poll in
 * `PricingModeIndicator` does not do it yet; that is SCRUM-242, not a claim
 * about what happens now.
 */
export function setBranchRateMode(answer: BranchRateModeAnswer | null): void {
  serverAnswer = answer
    ? {
        answer: { mode: answer.mode, reason: answer.reason, overrideName: answer.overrideName },
        date: answer.date,
        receivedAtMs: Date.now(),
      }
    : null;
}

/** The branch's trading date as the platform last reported it, or null. */
export function serverTradingDate(): string | null {
  return liveServerAnswer() ? serverAnswer!.date : null;
}

function liveServerAnswer(): RateModeResult | null {
  if (!serverAnswer) return null;
  const ageMs = Date.now() - serverAnswer.receivedAtMs;
  // A negative age means the device clock moved backwards under us; that is
  // the one thing this cache must not treat as "fresh".
  if (ageMs < 0 || ageMs > SERVER_ANSWER_TTL_MS) return null;
  /**
   * An answer is about a DAY, not about a moment, so it expires when that day
   * does — not only when its ten minutes are up.
   *
   * Measured before this guard existed: a poll succeeding at 23:55 Bangkok on
   * a Friday answered `{date: '2026-09-25', mode: 'weekday'}`; the network
   * then died; at 00:02 on the Saturday the device knew the trading date had
   * rolled to the 26th, and this cache still answered weekday, so the till
   * charged Friday's rate on a Saturday. Before the cache existed the till
   * would have computed weekend correctly, so the TTL alone made that case
   * worse rather than better. The answer already carried its own date and
   * nothing compared it.
   *
   * What makes an answer stale is its day being BEHIND this device's trading
   * day, and only that (SCRUM-209 fix round 2). An answer dated AHEAD of it is
   * the platform's clock saying the day has already moved on where this
   * device's has not (a device a few minutes slow across 05:00, or a date the
   * platform decided on its own clock), and the platform is the one the
   * booking is quoted by: overruling it with this device's calendar is how the
   * booking site came to show one day's rate while the platform quoted
   * another's. ISO dates compare as strings.
   */
  if (serverAnswer.date < branchTradingDate()) return null;
  return serverAnswer.answer;
}

/**
 * Resolves the active rate mode for a given date, in order:
 *   1. Inside any named holiday override range (inclusive) → weekend.
 *   2. Saturday or Sunday → weekend.
 *   3. Otherwise → weekday.
 * Reads holiday overrides from the catalog store (never mockApi — see the
 * lib import-cycle rule) so it stays free of the seed-eval TDZ.
 *
 * An instant (a Date, e.g. a sale's createdAt) is placed on the BRANCH's
 * calendar, not the browser's — a sale rung at 18:30 UTC on a Friday is a
 * Saturday sale in Bangkok and is priced as one. A plain yyyy-mm-dd string is
 * already a calendar date and is used as given.
 */
export function getRateModeForDate(date: Date | string): RateModeResult {
  const instant = typeof date === 'string' && !isIsoDate(date) ? new Date(date) : date;
  // An unparseable timestamp used to fall through to weekday, because NaN is
  // neither Saturday nor Sunday. `isoDateInTz` throws on one instead, and the
  // history screens feed this whatever a record carries, so it keeps the old
  // answer rather than taking a screen down over a bad row.
  if (instant instanceof Date && Number.isNaN(instant.getTime())) {
    return { mode: 'weekday', reason: 'Weekday pricing' };
  }
  const iso = typeof instant === 'string' ? instant : isoDateInTz(instant, branchTimezone);

  const override = getPricingOverrides().find(
    (o) => iso >= o.startDate && iso <= o.endDate
  );
  if (override) {
    return {
      mode: 'weekend',
      reason: `Weekend pricing — ${override.name}`,
      overrideName: override.name,
    };
  }

  const day = dayOfWeekOfIsoDate(iso); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) {
    return { mode: 'weekend', reason: 'Weekend pricing' };
  }
  return { mode: 'weekday', reason: 'Weekday pricing' };
}

/**
 * THE DAY BEING PRICED, WHEN IT IS NOT TODAY (S2-12, SCRUM-209 fix round 2).
 *
 * The till always sells now. The booking site sells for the visit date the
 * family chose on its date step, and the platform quotes the booking at that
 * date's rate (`createPublicBooking`), so every price the site shows has to be
 * that date's too: the ticket cards, the add-on toggles, each line and the
 * total all read their mode through `todayRateMode`, and this is what points
 * it at the chosen day. Null (the default, and what the till always has) means
 * today. `/book` sets it when a date is chosen and clears it when it unmounts.
 */
let pricingDate: string | null = null;

export function setPricingDate(date: string | null): void {
  pricingDate = date && isIsoDate(date) ? date : null;
}

export function getPricingDate(): string | null {
  return pricingDate;
}

/**
 * The active rate mode for the day being sold: today at the till, the chosen
 * visit date on the booking site (`setPricingDate`).
 *
 * The platform's answer wins while it is live and is about that day, because
 * it is decided on a clock the park controls; a chosen date is otherwise
 * resolved from the catalogue's own holiday ranges by the same rule the
 * platform uses; and today is otherwise read off this device's clock on the
 * branch's calendar.
 */
export function todayRateMode(): RateModeResult {
  if (pricingDate) {
    const live = liveServerAnswer();
    if (live && serverAnswer?.date === pricingDate) return live;
    return getRateModeForDate(pricingDate);
  }
  return liveServerAnswer() ?? getRateModeForDate(branchTradingDate());
}

/** Resolves a stored weekday/weekend price to a concrete ฿ number for a mode. */
export function resolveRate(
  price: WeekdayWeekendPrice | undefined,
  mode: RateMode
): number {
  if (!price) return 0;
  return mode === 'weekend' ? price.weekend : price.weekday;
}

/** Convenience: resolve a price using TODAY's active mode. */
export function resolveRateToday(price: WeekdayWeekendPrice | undefined): number {
  return resolveRate(price, todayRateMode().mode);
}

/**
 * Human-readable ฿ display for an admin list row: a single figure when
 * weekday and weekend match, otherwise both ("฿100 / ฿150 wknd").
 */
export function formatWWPrice(price: WeekdayWeekendPrice | undefined): string {
  if (!price) return '฿0';
  if (price.weekday === price.weekend) return `฿${price.weekday.toLocaleString()}`;
  return `฿${price.weekday.toLocaleString()} / ฿${price.weekend.toLocaleString()} wknd`;
}
