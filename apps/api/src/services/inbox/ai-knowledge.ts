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
  type OpeningHours,
  type TicketPackageFact,
} from '@oto/assistant';
import { aiExample, branch, branchHoliday, kbEntry, ticketPackage } from '@oto/db';
import { parseDayStart, rateModeToday, type Satang } from '@oto/shared';
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
 *     STANDARD ticket prices from the active `pos.ticket_package` rows — the
 *     base (`tourist`) tier, weekday and weekend, as the till charges them.
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

/**
 * One package as the prompt states it: the child price, and the adult rule of
 * the base tier (`TierAdultRule`). A rule the fact shape cannot say exactly —
 * an overflow price that differs weekday to weekend — is left unsaid rather
 * than said wrong.
 */
export function packageFact(row: Pick<typeof ticketPackage.$inferSelect, 'name' | 'prices' | 'adultRules'>): TicketPackageFact | null {
  const prices = (row.prices ?? {}) as Record<string, unknown>;
  const kid = ww(prices[BASE_TIER]);
  if (!kid) return null;
  const rules = (row.adultRules ?? {}) as Record<string, unknown>;
  const rule = (rules[BASE_TIER] ?? null) as { kind?: string; price?: unknown; freeAdults?: number; overflow?: string } | null;
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
  return {
    name: row.name,
    kidWeekday: kid.weekday as Satang,
    kidWeekend: kid.weekend as Satang,
    adultWeekday: adult.weekday as Satang,
    adultWeekend: adult.weekend as Satang,
    includedAdults,
    overflowAdult: overflowAdult as Satang | null,
  };
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
          .select({ branchId: ticketPackage.branchId, name: ticketPackage.name, prices: ticketPackage.prices, adultRules: ticketPackage.adultRules })
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
  const priceModeToday: Partial<Record<AiBranchKey, 'weekday' | 'weekend'>> = {};
  for (const b of mapped) {
    const key = keyOfBranch.get(b.id)!;
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
    knowledge: buildKnowledge({ kb, branches: facts, examples }),
    keyOfBranch,
    branchOfKey,
    priceModeToday,
  };
}
