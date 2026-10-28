import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  AI_INTENTS,
  WEEKDAY_KEYS,
  buildKnowledge,
  type AiBranchKey,
  type AiIntent,
  type BranchFacts,
  type ExampleInput,
  type KbEntryInput,
  type KnowledgeBlock,
  type KnowledgeInput,
  type OpeningHours,
  type TicketPackageFact,
  type TierPriceFact,
} from '@oto/assistant';
import { aiExample, branch, branchHoliday, kbEntry, ticketPackage } from '@oto/db';
import { formatTHB, parseDayStart, rateModeToday, type Satang } from '@oto/shared';
import type { Exec } from '../tx';

/**
 * THE ASSISTANT'S KNOWLEDGE, READ AT DECISION TIME (SCRUM-590, round A2 lane
 * a; plan `docs/progress/plans/inbox-ai-build/PLAN.md` §C.1, §C.3, §C.4, §E).
 *
 * Everything system block 2 holds, read from the platform each turn and
 * handed to `buildKnowledge` (`@oto/assistant`), which renders it to the same
 * bytes for the same rows so the cache holds:
 *
 *   - LIVE FACTS (§C.3): each park's name, `address`, `opening_hours`, and its
 *     ticket prices from the active `pos.ticket_package` rows — since the
 *     SCRUM-220 playbook EVERY TIER the packages carry (tourist, resident,
 *     Thai), weekday and weekend, as the till charges them (`priceFactText`).
 *     The KB can add wording; it can never override a number.
 *   - THE KB (§C.1): the operator's `approved` entries; a row still marked
 *     `needs_translation` is passed with its flag, and the builder leaves it out.
 *   - EXAMPLES (§E): approved, newest first, at most thirty.
 *
 * Today's weekday/weekend price mode is NOT in block 2 (it would change the
 * cached bytes at midnight): it is computed here for the per-call context.
 *
 * WHICH PARK IS WHICH. The brief names two parks, Central Floresta and
 * Chalong, and the model cites them as `central` / `chalong`. A branch maps
 * to one by its code (`hkt-central`, `robinson-chalong`); a branch whose
 * code names neither is not in the assistant's knowledge.
 */

export function aiBranchKeyOf(code: string): AiBranchKey | null {
  const c = code.toLowerCase();
  if (c.includes('chalong')) return 'chalong';
  if (c.includes('central')) return 'central';
  return null;
}

/** The standard, base tier of a ticket package's price table (CLAUDE.md §4: tier defaults to tourist). */
const BASE_TIER = 'tourist';

interface WW {
  weekday: number;
  weekend: number;
}

function ww(value: unknown): WW | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return typeof v['weekday'] === 'number' && typeof v['weekend'] === 'number'
    ? { weekday: v['weekday'], weekend: v['weekend'] }
    : null;
}

type AdultRule = { kind?: string; price?: unknown; freeAdults?: number; overflow?: string } | null;

function adultRuleOf(adultRules: unknown, tier: string): AdultRule {
  const rules = (adultRules ?? {}) as Record<string, unknown>;
  const rule = rules[tier];
  return rule && typeof rule === 'object' ? (rule as AdultRule) : null;
}

/** What one paying adult costs under a tier's rule: its set price, the overflow price, or the child's. */
function paidAdultOf(rule: AdultRule, kid: WW): WW {
  if (rule?.kind === 'set_price') return ww(rule.price) ?? kid;
  if (rule?.kind === 'free_adults') return (rule.overflow === 'set_price' ? ww(rule.price) : kid) ?? kid;
  return kid;
}

/** A package name on one line: a name with a line break would split its fact. */
const oneLine = (name: string) => name.replace(/\s+/g, ' ').trim();

/**
 * One package as the prompt states it: the child price, and the adult rule of
 * the base tier (`TierAdultRule`). A rule the fact shape cannot say exactly —
 * an overflow price that differs weekday to weekend — is left unsaid rather
 * than said wrong. The package's other tiers ride along as `tierPrices`
 * (SCRUM-220 playbook); the rendered price fact is `priceFactText`.
 */
export function packageFact(row: Pick<typeof ticketPackage.$inferSelect, 'name' | 'prices' | 'adultRules'>): TicketPackageFact | null {
  const prices = (row.prices ?? {}) as Record<string, unknown>;
  const kid = ww(prices[BASE_TIER]);
  if (!kid) return null;
  const rule = adultRuleOf(row.adultRules, BASE_TIER);
  let adult: WW = kid;
  let includedAdults = 0;
  let overflowAdult: number | null = null;
  if (rule?.kind === 'set_price') {
    adult = ww(rule.price) ?? kid;
  } else if (rule?.kind === 'free_adults') {
    includedAdults = Math.max(0, rule.freeAdults ?? 0);
    const over = rule.overflow === 'set_price' ? ww(rule.price) : kid;
    if (over && over.weekday === over.weekend) overflowAdult = over.weekday;
    if (over) adult = over;
  }
  const tierPrices: TierPriceFact[] = [];
  for (const tier of tierOrder(Object.keys(prices))) {
    if (tier === BASE_TIER) continue;
    const tierKid = ww(prices[tier]);
    if (!tierKid) continue;
    const tierAdult = paidAdultOf(adultRuleOf(row.adultRules, tier), tierKid);
    tierPrices.push({
      tierCode: tier,
      kidWeekday: tierKid.weekday as Satang,
      kidWeekend: tierKid.weekend as Satang,
      adultWeekday: tierAdult.weekday as Satang,
      adultWeekend: tierAdult.weekend as Satang,
    });
  }
  return {
    name: oneLine(row.name),
    kidWeekday: kid.weekday as Satang,
    kidWeekend: kid.weekend as Satang,
    adultWeekday: adult.weekday as Satang,
    adultWeekend: adult.weekend as Satang,
    includedAdults,
    overflowAdult: overflowAdult as Satang | null,
    ...(tierPrices.length > 0 ? { tierPrices } : {}),
  };
}

// --- The price fact, every tier (SCRUM-220 playbook) ------------------------------------------
//
// The playbook's pricing flow quotes the price that fits the customer — the
// tourist price, the resident price (expats with ID), the Thai price — and
// frames each as "starts from" the cheapest ticket. So the park's price fact
// says every tier its active packages carry, as the till charges them: the
// child price weekday and weekend, the adult rule, the starts-from, and a
// ticket a day type does not sell (a weekend price of zero: "not available on
// weekends"). It replaces the standard-only line `buildKnowledge` writes, under
// the same key (`fact.prices.<park>`, topic `prices`), so a reply quoting any
// tier's price is grounded by the source it cites. Compact on purpose: the
// prompt is refused at 40k tokens, and both parks' facts stay under 4,000
// characters (`inbox-ai-playbook.test.ts`).

/** The playbook's word for each tier. `expat` is the catalogue's code for the playbook's resident. */
const TIER_LABEL: Readonly<Record<string, string>> = {
  tourist: 'Tourist',
  expat: 'Resident',
  thai: 'Thai',
};
const TIER_RANK = ['tourist', 'expat', 'thai'];

function tierOrder(tiers: readonly string[]): string[] {
  const rank = (t: string) => {
    const i = TIER_RANK.indexOf(t);
    return i === -1 ? TIER_RANK.length : i;
  };
  return [...tiers].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

const tierLabel = (tier: string) => TIER_LABEL[tier] ?? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;

/** A child price pair as the customer hears it; null when the ticket is sold on neither day type. */
function kidPriceText(p: WW): string | null {
  if (p.weekday > 0 && p.weekend > 0) {
    return p.weekday === p.weekend ? `${formatTHB(p.weekday)} every day` : `${formatTHB(p.weekday)} weekday, ${formatTHB(p.weekend)} weekend`;
  }
  if (p.weekday > 0) return `${formatTHB(p.weekday)} weekday, not available on weekends`;
  if (p.weekend > 0) return `${formatTHB(p.weekend)} weekend, not available on weekdays`;
  return null;
}

/** An adult price pair: zero is a free adult, not a ticket the park does not sell. */
function adultPriceText(p: WW): string {
  const one = (v: number) => (v > 0 ? formatTHB(v) : 'free');
  return p.weekday === p.weekend ? `${one(p.weekday)} every day` : `${one(p.weekday)} weekday, ${one(p.weekend)} weekend`;
}

/** A tier's adult rule (`TierAdultRule`, `same_as_kid` when absent) in the customer's words. */
function adultRuleText(rule: AdultRule): string {
  if (rule?.kind === 'set_price') {
    const price = ww(rule.price);
    return price ? adultPriceText(price) : 'the child price';
  }
  if (rule?.kind === 'free_adults') {
    const n = Math.max(0, rule.freeAdults ?? 0);
    const then = rule.overflow === 'set_price' ? ww(rule.price) : null;
    const rest = then ? adultPriceText(then) : 'the child price';
    return n > 0 ? `first ${n === 1 ? 'adult' : `${n} adults`} free, then ${rest}` : rest;
  }
  return 'the child price';
}

/** A catalogue row as the price fact reads it (`pos.ticket_package`). */
export interface PricedPackageRow {
  name: string;
  hours: number;
  prices: unknown;
  adultRules: unknown;
}

/**
 * The park's price fact, every tier: one sentence per tier with its packages,
 * then its starts-from, then its adults (the most common adult price, with
 * any package that differs named after it).
 */
export function priceFactText(parkName: string, rows: readonly PricedPackageRow[]): string {
  const packages = [...rows]
    .map((r) => ({ ...r, name: oneLine(r.name), table: (r.prices ?? {}) as Record<string, unknown> }))
    .sort((a, b) => a.hours - b.hours || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tiers = tierOrder([...new Set(packages.flatMap((p) => Object.keys(p.table)))]);
  const sentences: string[] = [];
  for (const tier of tiers) {
    const sold: Array<{ name: string; kid: WW; kidText: string; adultText: string }> = [];
    for (const p of packages) {
      const kid = ww(p.table[tier]);
      const kidText = kid ? kidPriceText(kid) : null;
      if (!kid || !kidText) continue;
      sold.push({ name: p.name, kid, kidText, adultText: adultRuleText(adultRuleOf(p.adultRules, tier)) });
    }
    if (sold.length === 0) continue;
    const label = tierLabel(tier);
    const parts = [`${label}: ${sold.map((s) => `${s.name} ${s.kidText}`).join('; ')}.`];

    // Starts from: the lowest weekday child price (the weekend's when nothing sells on weekdays).
    const weekdays = sold.filter((s) => s.kid.weekday > 0);
    const pool = weekdays.length > 0 ? weekdays : sold;
    const at = (s: (typeof sold)[number]) => (weekdays.length > 0 ? s.kid.weekday : s.kid.weekend);
    const cheapest = pool.reduce((min, s) => (at(s) < at(min) ? s : min));
    const varies = cheapest.kid.weekday !== cheapest.kid.weekend;
    const day = varies ? (weekdays.length > 0 ? ', weekday' : ', weekend') : '';
    parts.push(`${label} starts from ${formatTHB(at(cheapest))} (${cheapest.name}${day}).`);

    // Adults: the most common rule, then the packages that differ.
    const counts = new Map<string, number>();
    for (const s of sold) counts.set(s.adultText, (counts.get(s.adultText) ?? 0) + 1);
    const common = [...counts.entries()].reduce((best, e) => (e[1] > best[1] ? e : best))[0];
    const others = sold.filter((s) => s.adultText !== common).map((s) => `${s.name} ${s.adultText}`);
    parts.push(`${label} adults: ${common}${others.length > 0 ? ` (${others.join('; ')})` : ''}.`);
    sentences.push(parts.join(' '));
  }
  if (sentences.length === 0) return `${parkName} ticket prices: not set (do not state prices)`;
  return `${parkName} ticket prices per child (weekday = Mon–Fri; weekend = Sat, Sun and park holidays). ${sentences.join(' ')}`;
}

/** The parks whose price facts replace the standard-only line. */
export interface ParkPrices {
  key: AiBranchKey;
  name: string;
  rows: readonly PricedPackageRow[];
}

/**
 * `buildKnowledge`, with each park's `fact.prices.<park>` line and grounding
 * source said by `priceFactText` (every tier). Same key, same topic, same
 * place in the block; the version is the hash of the text the model reads.
 */
export function knowledgeWithTierPrices(input: KnowledgeInput, parks: readonly ParkPrices[]): KnowledgeBlock {
  const built = buildKnowledge(input);
  const grounding = new Map(built.grounding);
  const lines = built.text.split('\n');
  for (const park of parks) {
    const key = `fact.prices.${park.key}`;
    const prefix = `[${key}] `;
    const at = lines.findIndex((l) => l.startsWith(prefix));
    if (at === -1) continue;
    const text = priceFactText(oneLine(park.name), park.rows);
    lines[at] = `${prefix}${text}`;
    grounding.set(key, { key, topic: 'prices', text });
  }
  const text = lines.join('\n');
  return { text, version: createHash('sha256').update(text).digest('hex').slice(0, 16), grounding };
}

function openingHoursOf(raw: unknown): OpeningHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: OpeningHours = {};
  const r = raw as Record<string, unknown>;
  for (const day of WEEKDAY_KEYS) {
    const v = r[day];
    if (v === null || v === undefined) {
      out[day] = null;
      continue;
    }
    if (typeof v !== 'object') return null;
    const { open, close } = v as Record<string, unknown>;
    if (typeof open !== 'string' || typeof close !== 'string') return null;
    out[day] = { open, close };
  }
  return out;
}

export interface TurnKnowledge {
  knowledge: KnowledgeBlock;
  /** branch id → the key the model knows it by. */
  keyOfBranch: ReadonlyMap<string, AiBranchKey>;
  /** the key → branch id. */
  branchOfKey: ReadonlyMap<AiBranchKey, string>;
  priceModeToday: Partial<Record<AiBranchKey, 'weekday' | 'weekend'>>;
}

export async function loadTurnKnowledge(db: Exec, operatorId: string, now: Date): Promise<TurnKnowledge> {
  const branches = await db
    .select()
    .from(branch)
    .where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt)))
    .orderBy(branch.createdAt);
  const keyOfBranch = new Map<string, AiBranchKey>();
  const branchOfKey = new Map<AiBranchKey, string>();
  for (const b of branches) {
    const key = aiBranchKeyOf(b.code);
    // The first branch of each park wins; a second with the same key is not the brief's park.
    if (key && !branchOfKey.has(key)) {
      keyOfBranch.set(b.id, key);
      branchOfKey.set(key, b.id);
    }
  }
  const mapped = branches.filter((b) => keyOfBranch.has(b.id));
  const ids = mapped.map((b) => b.id);

  const packages =
    ids.length === 0
      ? []
      : await db
          .select({
            branchId: ticketPackage.branchId,
            name: ticketPackage.name,
            hours: ticketPackage.hours,
            prices: ticketPackage.prices,
            adultRules: ticketPackage.adultRules,
          })
          .from(ticketPackage)
          .where(and(inArray(ticketPackage.branchId, ids), eq(ticketPackage.active, true), isNull(ticketPackage.archivedAt)))
          .orderBy(ticketPackage.name);
  const holidays =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(branchHoliday)
          .where(and(inArray(branchHoliday.branchId, ids), isNull(branchHoliday.archivedAt)));

  const facts: BranchFacts[] = [];
  const parks: ParkPrices[] = [];
  const priceModeToday: Partial<Record<AiBranchKey, 'weekday' | 'weekend'>> = {};
  for (const b of mapped) {
    const key = keyOfBranch.get(b.id)!;
    parks.push({ key, name: b.name, rows: packages.filter((p) => p.branchId === b.id) });
    facts.push({
      key,
      name: b.name,
      address: b.address,
      openingHours: openingHoursOf(b.openingHours),
      packages: packages
        .filter((p) => p.branchId === b.id)
        .map(packageFact)
        .filter((p): p is TicketPackageFact => p !== null),
    });
    priceModeToday[key] = rateModeToday(
      b.timezone,
      holidays.filter((h) => h.branchId === b.id).map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
      now,
      parseDayStart(b.businessDayStart),
    ).mode;
  }

  const kbRows = await db
    .select()
    .from(kbEntry)
    .where(and(eq(kbEntry.operatorId, operatorId), eq(kbEntry.status, 'approved')));
  const kb: KbEntryInput[] = [];
  for (const r of kbRows) {
    let key: AiBranchKey | null = null;
    if (r.branchId !== null) {
      key = keyOfBranch.get(r.branchId) ?? null;
      // An entry for a park the assistant does not know stays out, rather than becoming "both parks".
      if (key === null) continue;
    }
    kb.push({
      key: r.key,
      topic: r.topic,
      language: r.language,
      branch: key,
      question: r.question,
      body: r.body,
      needsTranslation: r.needsTranslation,
    });
  }

  const exampleRows = await db
    .select()
    .from(aiExample)
    .where(and(eq(aiExample.operatorId, operatorId), eq(aiExample.status, 'approved')))
    .orderBy(desc(aiExample.approvedAt), desc(aiExample.id))
    .limit(60);
  const intents = new Set<string>(AI_INTENTS);
  const examples: ExampleInput[] = exampleRows
    .filter((e) => intents.has(e.intent))
    .slice(0, 30)
    .map((e) => ({
      intent: e.intent as AiIntent,
      language: e.language,
      customerText: e.customerText,
      goodReply: e.goodReply ?? '',
      verdict: e.verdict,
    }));

  return {
    knowledge: knowledgeWithTierPrices({ kb, branches: facts, examples }, parks),
    keyOfBranch,
    branchOfKey,
    priceModeToday,
  };
}
