import { z } from 'zod';
import { isIsoDate } from './dates';
import { PartyDetailAnswerSchema } from './parties';
import type { PartyPlan } from './party-settlement';
import { PREP_TICKET_TITLE, PRINT_JOB_STATUSES, type PrintingPrepStation } from './print';

/**
 * SCRUM-805 — A PARTY'S KITCHEN AND BAR SLIPS AT A SET TIME (birthday plan §5;
 * the owner's decision 3 of 2026-11-09).
 *
 * Plan in the OTO App, execute in the POS: the BEO plans the party's set menu,
 * its bar items and its food times, and at the party's slip time (its own, the
 * BEO's default 11:00) the POS prints one kitchen slip and one bar slip for it,
 * to the kitchen and bar printers of the station the park names. This file is
 * the slip itself — what goes on which slip, in which words — composed by a
 * pure function from the plan, so the api's job, its reprint and a test all
 * read the same paper.
 *
 *   - The KITCHEN slip: every set-menu line whose till product prints in the
 *     kitchen, and every line the till catalogue cannot place — no product code
 *     (the printed menus name dishes the catalogue lacks: Fruit skewers), or a
 *     code no live product carries — by the plan's own name. A line nobody has
 *     placed goes to the kitchen, as `groupPrepTickets` sends one.
 *   - The BAR slip: the set-menu lines whose product prints at the bar, and
 *     every line of the bar plan.
 *   - A product whose prep station is `none` prints nowhere, as on a sale.
 *   - A choice group prints the dish chosen for this party; one still open
 *     prints the group's name, marked as not chosen (the view names no options
 *     for an open group).
 *   - Each slip is headed "Birthday party" with the party's name, its room, the
 *     number of children and READY BY: the kitchen plan's kids' food time less
 *     its ready offset (§5). When the kitchen plan has no kids' food time the
 *     slip prints no READY BY time, only that the OTO App has none: which time
 *     the kitchen works to then is a question for the owner, not a rule here.
 *   - ONE food list, the adults' changes marked (SCRUM-829). The BEO's adults'
 *     menu mirrors the kids' unless its "Different for adults" switch is on;
 *     then the plan marks the lines (`audience`, app migration 0048): a line
 *     the adults do not get prints "kids only"; an adults' line of a name the
 *     slip already lists prints no second line but "kids N · adults M" beside
 *     the first (the counts are each side's own; their sum is what the till
 *     charges), or "adults: <note>" when only its note differs; an adults'
 *     line of a new name prints marked "adults only". The slip prints no
 *     separate totals: how the adults' portions are counted is the owner's
 *     open point, and these two counts are the simplest honest reading of it.
 */

/** The two slips, kitchen first: the prep stations that print (`print.ts`). */
export const PARTY_SLIP_STATIONS = ['kitchen', 'bar'] as const satisfies readonly PrintingPrepStation[];
export type PartySlipStation = (typeof PARTY_SLIP_STATIONS)[number];

export const PARTY_SLIP_STATUSES = ['printed', 'no_printer', 'nothing_to_print'] as const;
export type PartySlipStatus = (typeof PARTY_SLIP_STATUSES)[number];

export const PARTY_SLIP_TRIGGERS = ['schedule', 'reprint'] as const;
export type PartySlipTrigger = (typeof PARTY_SLIP_TRIGGERS)[number];

/** The slip time when the BEO names none (the owner's decision 3). */
export const PARTY_SLIPS_DEFAULT_TIME = '11:00';

/** The heading every party slip carries. */
export const PARTY_SLIP_HEADING = 'Birthday party';

/** What the slip says in place of READY BY when the kitchen plan has no kids' food time. */
export const PARTY_NO_KIDS_FOOD_TIME = "No kids' food time in the OTO App";

/** What the slip says under an open choice group. */
export const PARTY_CHOICE_NOT_MADE = 'Choice not made in the OTO App';

/** SCRUM-829: the adults' changes, marked on the one food list (the BEO PDF prints the same words). */
export const PARTY_KIDS_ONLY = 'kids only';
export const PARTY_ADULTS_ONLY = 'adults only';
/** "kids N · adults M": a dish both eat, in different counts. */
export const partyCountsMark = (kidsQty: number | null, adultsQty: number): string =>
  kidsQty === null ? `adults ${adultsQty}` : `kids ${kidsQty} · adults ${adultsQty}`;

/** A dish's name as the kitchen reads it: case and spacing aside. */
const foldName = (name: string): string => name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

/** Minutes past midnight of an "HH:MM" (or "HH:MM:SS") clock, or null. */
export function clockMinutes(value: string | null | undefined): number | null {
  const m = typeof value === 'string' ? /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim()) : null;
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** "HH:MM" of minutes past midnight, wrapped into the day. */
export function clockOf(minutes: number): string {
  const day = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`;
}

/** The party's slip time: the plan's, else the default. Always "HH:MM". */
export function partySlipsTime(plan: Pick<PartyPlan, 'kitchen'> | null | undefined): string {
  const own = clockMinutes(plan?.kitchen?.slipsTime ?? null);
  return own === null ? PARTY_SLIPS_DEFAULT_TIME : clockOf(own);
}

/**
 * READY BY: the kitchen plan's kids' food time less its ready offset, "HH:MM";
 * null when the kitchen plan has no kids' food time.
 */
export function partyReadyBy(plan: Pick<PartyPlan, 'kitchen'>): string | null {
  const food = clockMinutes(plan.kitchen?.kidsFoodTime ?? null);
  return food === null ? null : clockOf(food - (plan.kitchen?.readyOffsetMinutes ?? 0));
}

/** One line of a party slip. No quantity when the plan prints none. */
export interface PartySlipLine {
  qty?: number;
  name: string;
  note?: string;
}

/**
 * A party's slip, as the prep ticket's document (`PrepTicketData` in
 * `@oto/print`) with the party's heading, its details and READY BY. The
 * renderer draws `heading`, `details` and `readyBy` on a prep ticket that
 * carries them, and a box released before them prints the rest.
 */
export interface PartySlipDocument {
  /** `Kitchen` or `Bar`, as a sale's prep ticket is titled. */
  title: string;
  heading: string;
  /** The party's name, as the party page shows it. */
  orderRef: string;
  /** When the slip was printed, "HH:MM" on the park's clock. */
  time: string;
  /** Room and children: what the plan knows of them. */
  details: string[];
  readyBy?: string;
  /** In place of READY BY when the kitchen plan has no kids' food time. */
  readyByNote?: string;
  lines: PartySlipLine[];
}

/** What the slips are composed from: the plan, the party as the page shows it, the catalogue. */
export interface PartySlipInput {
  plan: Pick<PartyPlan, 'setMenu' | 'barItems' | 'kitchen' | 'counts'>;
  /** The party's name and room as the party page shows them. */
  partyName: string;
  location: string | null;
  /** Where a till product prints, by its code; null when no live product carries the code. */
  prepStationOf: (productCode: string) => 'kitchen' | 'bar' | 'none' | null;
  /** "HH:MM" on the park's clock. */
  printedAt: string;
}

/** A slip line with the marks a note is built from, before the note is joined. */
interface SlipLineDraft {
  qty: number | null;
  name: string;
  notes: string[];
}

const draftToLine = (d: SlipLineDraft): PartySlipLine => ({
  ...(d.qty === null ? {} : { qty: d.qty }),
  name: d.name,
  ...(d.notes.length ? { note: d.notes.join(' · ') } : {}),
});

/**
 * The party's two slips; null for a station the plan has nothing for. Lines
 * keep the plan's order: the set menu, then the bar plan. An adults' line
 * (SCRUM-829) of a name the station's slip already lists folds into that
 * line, as the file's header says; one of a new name is its own line.
 */
export function composePartySlips(input: PartySlipInput): Record<PartySlipStation, PartySlipDocument | null> {
  const drafts: Record<PartySlipStation, SlipLineDraft[]> = { kitchen: [], bar: [] };
  for (const item of input.plan.setMenu) {
    const station = item.productCode ? (input.prepStationOf(item.productCode) ?? 'kitchen') : 'kitchen';
    if (station === 'none') continue;
    const name = (item.chosenOption ?? item.name).trim();
    if (!name) continue;
    const note = item.note?.trim() || null;
    if (item.audience === 'adults') {
      const held = drafts[station].find((d) => foldName(d.name) === foldName(name) && !d.notes.includes(PARTY_ADULTS_ONLY));
      if (held) {
        const adultsQty = item.qty ?? 1;
        if (held.qty !== adultsQty) {
          held.notes.push(partyCountsMark(held.qty, adultsQty));
          held.qty = null;
        } else if (note) {
          held.notes.push(`adults: ${note}`);
        }
        continue;
      }
      drafts[station].push({ qty: item.qty, name, notes: [PARTY_ADULTS_ONLY, ...(note ? [note] : [])] });
      continue;
    }
    const notes = [
      item.choiceGroup && !item.chosenOption ? PARTY_CHOICE_NOT_MADE : null,
      note,
      item.audience === 'kids' ? PARTY_KIDS_ONLY : null,
    ].filter((n): n is string => !!n);
    drafts[station].push({ qty: item.qty, name, notes });
  }
  const lines: Record<PartySlipStation, PartySlipLine[]> = {
    kitchen: drafts.kitchen.map(draftToLine),
    bar: drafts.bar.map(draftToLine),
  };
  for (const item of input.plan.barItems) {
    const name = item.name.trim();
    if (name) lines.bar.push({ qty: item.qty, name });
  }

  const ready = partyReadyBy(input.plan);
  const details = [
    ...(input.location?.trim() ? [`Room: ${input.location.trim()}`] : []),
    ...(input.plan.counts.kidsExpected === null ? [] : [`Children: ${input.plan.counts.kidsExpected}`]),
  ];
  const slip = (station: PartySlipStation): PartySlipDocument | null =>
    lines[station].length === 0
      ? null
      : {
          title: PREP_TICKET_TITLE[station],
          heading: PARTY_SLIP_HEADING,
          orderRef: input.partyName,
          time: input.printedAt,
          details,
          ...(ready ? { readyBy: ready } : { readyByNote: PARTY_NO_KIDS_FOOD_TIME }),
          lines: lines[station],
        };
  return { kitchen: slip('kitchen'), bar: slip('bar') };
}

// --- The api's words --------------------------------------------------------------

const IsoDate = z.string().refine(isIsoDate, 'yyyy-MM-dd');

/** One slip of one run, as the party page and the print answer show it. */
export const PartySlipRecordViewSchema = z.object({
  id: z.string().uuid(),
  station: z.enum(PARTY_SLIP_STATIONS),
  run: z.number().int().min(1),
  trigger: z.enum(PARTY_SLIP_TRIGGERS),
  status: z.enum(PARTY_SLIP_STATUSES),
  /** "HH:MM" on the park's clock: when it was queued, or recorded when it was not. */
  at: z.string(),
  printJobId: z.string().uuid().nullable(),
  /** The print job's own state (queued, printed, failed); null when nothing was queued. */
  jobStatus: z.enum(PRINT_JOB_STATUSES).nullable(),
  requestedByName: z.string().nullable(),
  createdAt: z.string(),
});
export type PartySlipRecordView = z.infer<typeof PartySlipRecordViewSchema>;

/** A party's slips on its day: the slip time, the station named, and every run, newest first. */
export const PartySlipsViewSchema = z.object({
  partyDate: IsoDate,
  /** "HH:MM": the party's own, else 11:00. */
  slipsTime: z.string(),
  /** The station the branch names for party slips; null until the park tags one. */
  station: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  /** The newest run's slip per station; null before anything was printed. */
  latest: z.object({
    kitchen: PartySlipRecordViewSchema.nullable(),
    bar: PartySlipRecordViewSchema.nullable(),
  }),
  records: z.array(PartySlipRecordViewSchema),
});
export type PartySlipsView = z.infer<typeof PartySlipsViewSchema>;

/**
 * `GET /parties/:id` with the party's slips (null for a party with no plan from
 * the OTO App: it has nothing to print). Optional so an answer from before
 * still reads.
 */
export const PartyDetailWithSlipsAnswerSchema = PartyDetailAnswerSchema.extend({
  slips: PartySlipsViewSchema.nullable().optional(),
});
export type PartyDetailWithSlipsAnswer = z.infer<typeof PartyDetailWithSlipsAnswerSchema>;

/** `POST /parties/:id/slips/print` — "Print party slips now". */
export const PartySlipsPrintBodySchema = z.object({
  branchId: z.string().uuid(),
  /** The press, kept for its retries: the same id again answers the run it made. */
  actionId: z.string().min(1).max(200).optional(),
});
export type PartySlipsPrintBody = z.infer<typeof PartySlipsPrintBodySchema>;

export const PartySlipsPrintAnswerSchema = z.object({
  /** This run's slips, kitchen then bar. */
  printed: z.array(PartySlipRecordViewSchema),
  slips: PartySlipsViewSchema,
  replayed: z.boolean(),
});
export type PartySlipsPrintAnswer = z.infer<typeof PartySlipsPrintAnswerSchema>;
