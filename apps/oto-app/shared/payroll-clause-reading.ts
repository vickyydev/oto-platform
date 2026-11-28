/**
 * SCRUM-1075: an employee's incentive clause read in payroll's OWN incentive
 * terms. The clause is the free text "Incentive / Commission Clause
 * (Optional)" on the HR profile (employees.incentive_clause_text). The AI
 * proposes a reading once, when a clause is new or changed; a person
 * approves, corrects or marks it not an incentive; approving turns each
 * bonus part into a dated incentive rule and assignment of the existing
 * payroll model (server/payroll/clause-rules.ts), and from then on the
 * payroll engine alone calculates it. The AI is never in the monthly path.
 *
 * A reading may only say what the engine can do: a percent of chosen sales
 * (one person's own, or a team pool shared by days worked), or a baht amount
 * per counted unit (a count typed for the team, or one typed per person),
 * with an optional sales threshold and cap. Anything else is a part that
 * "needs a person"; the parts that are not bonuses at all (service charge,
 * a salary change, a benefit such as housing) are kept and flagged, never
 * paid as a bonus.
 *
 * `checkReading` is the code's own guard on any reading, AI or person made:
 * numbers the AI used must be written in the clause, service charge can
 * never be a bonus part, and a rate that pays almost nothing at its own
 * threshold is raised as a question. It is pure, so the fixed test of the
 * park's real clauses (tests/payroll/cases/clause-readings.cases.ts) runs it.
 */
import { z } from "zod";

export const NOT_BONUS_KINDS = ["service-charge", "salary-change", "benefit", "other"] as const;
export type NotBonusKind = typeof NOT_BONUS_KINDS[number];

export interface ClauseBonusTerms {
  /** What the bonus is based on. */
  basis: "percent-of-revenue" | "baht-per-unit";
  /** percent-of-revenue: the percent (0.2 means 0.2 %). */
  percent: number | null;
  /** baht-per-unit: baht for each unit. */
  bahtPerUnit: number | null;
  /** percent-of-revenue: which sales, in the clause's words and as the park's stream keys. */
  revenue: { described: string; streams: string[]; branches: "all" | "home" } | null;
  /** baht-per-unit: what is counted and who types it each month. */
  unit: { described: string; inputKey: string; counted: "team-total" | "per-person" } | null;
  /** The sales (the same sales the percent is of) must EXCEED this amount, or nothing is paid. */
  threshold: number | null;
  /** The most it can pay in a month (for a team pool: the whole pool). */
  cap: number | null;
  /** The person's own bonus, or a pool shared with a team. */
  sharing: "own" | "team";
  team: string | null;
  /** How a team pool is shared. */
  split: "days-worked" | "equal" | null;
  /** An existing approved team pool this person joins, by its key (its terms then come from the pool). */
  joinPool: string | null;
}

export interface ClausePart {
  type: "bonus" | "not-a-bonus" | "needs-a-person";
  /** The clause's own words this part reads. */
  quote: string;
  /** What it means, in plain words. */
  plainWords: string;
  notBonusKind: NotBonusKind | null;
  needsPersonWhy: string | null;
  bonus: ClauseBonusTerms | null;
}

export interface ClauseReading {
  summary: string;
  parts: ClausePart[];
  questions: string[];
}

const nullableNumber = z.number().finite().nonnegative().nullable();
const bonusSchema = z.object({
  basis: z.enum(["percent-of-revenue", "baht-per-unit"]),
  percent: nullableNumber,
  bahtPerUnit: nullableNumber,
  revenue: z.object({ described: z.string().max(200), streams: z.array(z.string().max(40)).max(40), branches: z.enum(["all", "home"]) }).nullable(),
  unit: z.object({ described: z.string().max(200), inputKey: z.string().max(40), counted: z.enum(["team-total", "per-person"]) }).nullable(),
  threshold: nullableNumber,
  cap: nullableNumber,
  sharing: z.enum(["own", "team"]),
  team: z.string().max(120).nullable(),
  split: z.enum(["days-worked", "equal"]).nullable(),
  joinPool: z.string().max(400).nullable(),
});
const partSchema = z.object({
  type: z.enum(["bonus", "not-a-bonus", "needs-a-person"]),
  quote: z.string().max(1000),
  plainWords: z.string().max(1000),
  notBonusKind: z.enum(NOT_BONUS_KINDS).nullable(),
  needsPersonWhy: z.string().max(1000).nullable(),
  bonus: bonusSchema.nullable(),
});
export const clauseReadingSchema = z.object({
  summary: z.string().max(2000),
  parts: z.array(partSchema).min(1).max(12),
  questions: z.array(z.string().max(1000)).max(20),
});

/** The reading's shape, or a list of what is wrong with it. */
export function parseReading(raw: unknown): { reading: ClauseReading } | { errors: string[] } {
  const parsed = clauseReadingSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join(".") || "reading"}: ${i.message}`).slice(0, 10) };
  return { reading: parsed.data as ClauseReading };
}

/**
 * The JSON schema the AI answers in (structured output): the same shape as
 * `clauseReadingSchema`, with the park's stream keys and the open pools as
 * the only values it may name. Kept free of number limits, which structured
 * output does not take; `parseReading` checks them after.
 */
export function readingJsonSchema(streamKeys: string[], poolKeys: string[]): Record<string, unknown> {
  const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
  const stringList = streamKeys.length ? { type: "array", items: { type: "string", enum: streamKeys } } : { type: "array", items: { type: "string" } };
  const bonus = {
    type: "object", additionalProperties: false,
    required: ["basis", "percent", "bahtPerUnit", "revenue", "unit", "threshold", "cap", "sharing", "team", "split", "joinPool"],
    properties: {
      basis: { type: "string", enum: ["percent-of-revenue", "baht-per-unit"] },
      percent: nullable({ type: "number" }),
      bahtPerUnit: nullable({ type: "number" }),
      revenue: nullable({ type: "object", additionalProperties: false, required: ["described", "streams", "branches"], properties: {
        described: { type: "string" }, streams: stringList, branches: { type: "string", enum: ["all", "home"] } } }),
      unit: nullable({ type: "object", additionalProperties: false, required: ["described", "inputKey", "counted"], properties: {
        described: { type: "string" }, inputKey: { type: "string" }, counted: { type: "string", enum: ["team-total", "per-person"] } } }),
      threshold: nullable({ type: "number" }),
      cap: nullable({ type: "number" }),
      sharing: { type: "string", enum: ["own", "team"] },
      team: nullable({ type: "string" }),
      split: nullable({ type: "string", enum: ["days-worked", "equal"] }),
      joinPool: poolKeys.length ? nullable({ type: "string", enum: poolKeys }) : { type: "null" },
    },
  };
  return {
    type: "object", additionalProperties: false, required: ["summary", "parts", "questions"],
    properties: {
      summary: { type: "string" },
      parts: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["type", "quote", "plainWords", "notBonusKind", "needsPersonWhy", "bonus"],
        properties: {
          type: { type: "string", enum: ["bonus", "not-a-bonus", "needs-a-person"] },
          quote: { type: "string" }, plainWords: { type: "string" },
          notBonusKind: nullable({ type: "string", enum: [...NOT_BONUS_KINDS] }),
          needsPersonWhy: nullable({ type: "string" }),
          bonus: nullable(bonus),
        } } },
      questions: { type: "array", items: { type: "string" } },
    },
  };
}

// ─── The code's own guards ────────────────────────────────────────────────────

/**
 * Every number written in a clause, as a value: a decimal comma is a decimal
 * ("0,2%" is 0.2, "0,002%" is 0.002, "4,5 mln" is 4,500,000), a comma or
 * space between groups of three is a thousands separator ("4,500,000",
 * "20 000"), and "mln", "million" or "m" after a number multiplies it by a
 * million, "k" by a thousand. A number that can be read both ways ("1,500")
 * gives both values; one that starts with 0 is never a thousands number.
 */
export function clauseNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:[ ,]\d{3})+(?![\d,])|\d+(?:[.,]\d+)?)\s*(mln|million|m\b|k\b)?/gi;
  for (const match of text.matchAll(re)) {
    const raw = match[1];
    const values: number[] = [];
    if (/^[1-9]\d{0,2}(?:[ ,]\d{3})+$/.test(raw)) values.push(Number(raw.replace(/[ ,]/g, "")));
    if (/^\d+,\d+$/.test(raw)) values.push(Number(raw.replace(",", ".")));
    if (/^\d+(?:\.\d+)?$/.test(raw)) values.push(Number(raw));
    const unit = match[2]?.toLowerCase();
    const times = unit === "mln" || unit === "million" || unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
    for (const value of values) if (Number.isFinite(value)) out.push(value * times);
  }
  return out;
}
const SERVICE_CHARGE = /service\s*charge/i;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
const baht = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });

/**
 * The guards, applied to every reading before it is saved. Returns the
 * reading with these changes, and says which were made:
 *   - an AI reading's bonus part using a number that is not written in the
 *     clause becomes a part that needs a person (a person's correction may
 *     bring in a number, so `source: "person"` skips this);
 *   - a bonus part whose words are about service charge becomes "not a
 *     bonus" (service charge is paid by the service-charge policy);
 *   - a percent that pays under 1,000 baht a month at its own threshold, and
 *     a joined pool or team pool without a team name, raise a question.
 * Running it again on its own output changes nothing.
 */
export function checkReading(clauseText: string, reading: ClauseReading, source: "ai" | "person"): { reading: ClauseReading; notes: string[] } {
  const numbers = clauseNumbers(clauseText);
  const written = (n: number) => numbers.some((x) => near(x, n));
  const notes: string[] = [];
  const questions = [...reading.questions];
  const ask = (q: string) => { if (!questions.includes(q)) questions.push(q); };
  const parts = reading.parts.map((part): ClausePart => {
    if (part.type !== "bonus" || !part.bonus) {
      if (part.type === "bonus") {
        notes.push(`"${part.quote}" had no terms, so it needs a person.`);
        return { ...part, type: "needs-a-person", needsPersonWhy: part.needsPersonWhy ?? "The reading named a bonus without saying how it is calculated.", bonus: null, notBonusKind: null };
      }
      return part;
    }
    const b = part.bonus;
    if (SERVICE_CHARGE.test(part.quote) && !b.joinPool && !/nanny|drop|birthday|event|flyer|revenue/i.test(part.quote.replace(SERVICE_CHARGE, ""))) {
      notes.push(`"${part.quote}" is service charge, which the service-charge policy pays; it is not paid as a bonus.`);
      return { ...part, type: "not-a-bonus", notBonusKind: "service-charge", bonus: null, needsPersonWhy: null,
        plainWords: "Service charge: paid by the branch's service-charge policy, not by this clause." };
    }
    if (source === "ai" && !b.joinPool) {
      const used = [b.percent, b.bahtPerUnit, b.threshold, b.cap].filter((n): n is number => n !== null);
      const missing = used.filter((n) => !written(n));
      if (missing.length) {
        notes.push(`"${part.quote}" used ${missing.map(baht).join(", ")}, which the clause does not say, so it needs a person.`);
        return { ...part, type: "needs-a-person", bonus: null, notBonusKind: null,
          needsPersonWhy: `The reading used ${missing.map(baht).join(", ")}, a number the clause does not write. A person must say the terms.` };
      }
    }
    if (b.basis === "percent-of-revenue" && b.percent !== null && b.threshold !== null && b.percent * b.threshold / 100 < 1000) {
      ask(`At exactly ${baht(b.threshold)} baht, ${baht(b.percent)}% pays ${baht(Math.round(b.percent * b.threshold) / 100)} baht a month. Please confirm the rate really is ${baht(b.percent)}%.`);
    }
    if (b.sharing === "team" && !b.joinPool && !b.team?.trim()) ask(`"${part.quote}" is shared by a team, but the clause does not name the team. Who shares it?`);
    return part;
  });
  return { reading: { summary: reading.summary, parts, questions }, notes };
}

/** True when the reading has at least one part a person must still settle. */
export const needsPerson = (reading: ClauseReading) => reading.parts.some((p) => p.type === "needs-a-person");
export const bonusParts = (reading: ClauseReading) => reading.parts.filter((p) => p.type === "bonus" && p.bonus);

// ─── What the screens read ────────────────────────────────────────────────────

export type ClauseState = "not-read" | "waiting" | "approved" | "not-incentive" | "changed" | "changed-waiting";
export const CLAUSE_STATE_LABEL: Record<ClauseState, string> = {
  "not-read": "Not read yet",
  waiting: "Waiting for approval — not paid yet",
  approved: "Approved — paid by payroll",
  "not-incentive": "Not an incentive — nothing paid",
  changed: "Clause changed — read it again (the approved reading keeps paying)",
  "changed-waiting": "Clause changed — new reading waiting (the approved reading keeps paying)",
};

export interface ClauseRuleRef { part: number; ruleId: string; poolKey: string; joined: boolean; name: string }
export interface ClauseReadingView {
  id: string; clauseText: string; clauseHash: string; reading: ClauseReading; source: "ai" | "person"; model: string | null;
  status: "pending" | "approved" | "not-incentive" | "replaced";
  rules: ClauseRuleRef[]; effectiveFrom: string | null; effectiveTo: string | null;
  decided: { reason: string; who: string; at: string } | null;
  reason: string; who: string; at: string;
}
export interface ClausePersonView {
  employeeId: string; name: string; jobTitle: string | null; employeeStatus: string; homeBranchId: string | null;
  hasProfile: boolean; clauseText: string; clauseHash: string; state: ClauseState;
  /** The newest reading of the clause as it is now (any status). */
  current: ClauseReadingView | null;
  /** The reading that pays now (approved or not an incentive), which may be of an older clause text. */
  decided: ClauseReadingView | null;
  /** Other people's clauses that name the same team at a different rate (a question for the owner). */
  teamRateQuestion: string | null;
}
export interface ClausePoolView { key: string; ruleId: string; name: string; kind: string; members: number }
export interface ClauseReadingsView {
  people: ClausePersonView[];
  streams: { key: string; label: string }[];
  branches: { id: string; name: string }[];
  pools: ClausePoolView[];
  countKeys: string[];
  aiConfigured: boolean;
  canManage: boolean;
}
export interface ClauseExampleView {
  readingId: string; month: string; employed: boolean;
  lines: { ruleName: string; amount: number; formula: string; targetMet: boolean; joined: boolean }[];
  total: number;
  problems: string[];
  /** Where the figures came from: the month's saved sales, counts and per-person numbers. */
  inputs: string[];
}
/** Per person on a month's screens: the clause's state and the rules its approved reading pays from. */
export interface ClauseMonthMark { employeeId: string; state: ClauseState; ruleIds: string[]; readingId: string | null; summary: string | null; clauseText: string }
