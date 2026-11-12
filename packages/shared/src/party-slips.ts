import { z } from 'zod';
import { isIsoDate } from './dates';
import { PartyDetailAnswerSchema } from './parties';
import type { PartyCakeType, PartyKitchenPlan, PartyPlan, PartyPlanCake } from './party-settlement';
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
 *     every line of the bar plan but one whose till code prints in the kitchen.
 *   - A set-menu product whose prep station is `none` prints nowhere, as on a
 *     sale. A bar-plan line never vanishes: one whose product prints nowhere
 *     (a bottled water) is still the bar's to bring, so it is on the bar slip.
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
 *     then the plan marks the lines (`audience` and `adultsNote`, app
 *     migration 0048): a line the adults do not get prints "kids only"; a
 *     line the adults get as the same dish with another note prints once, with
 *     "adults: <note>" beside it ("adults: no note" when theirs was cleared) —
 *     the dish the till charges once; an adults' line of a name the slip
 *     already lists prints no second line but "kids N · adults M" beside the
 *     first (the counts are each side's own; their sum is what the till
 *     charges); an adults' line of a new name prints marked "adults only". The
 *     slip prints no separate totals: how the adults' portions are counted is
 *     the owner's open point, and these two counts are the simplest honest
 *     reading of it.
 *   - THE WHOLE KITCHEN PLAN (SCRUM-906; the owner's decisions of 12
 *     November): every line of the BEO's kitchen plan arrives, typed or
 *     coded. A line no live till product carries — typed by hand, or a code
 *     the till no longer sells — prints by its name, marked "not on the till
 *     menu" (decision 1). A chosen dish prints under its group's name,
 *     "Fried rice: Veggie", never a bare "Veggie". The bar plan's lines go to
 *     the bar with their note, unless their own till code prints in the
 *     kitchen (a dish the bar plan names goes to the kitchen). The cake
 *     prints on the kitchen slip as the BEO's cake choice says it — "Our
 *     Cake" or "Own Cake", its quantity, its time and its notes — and not
 *     at all when the BEO says no cake (decision 4).
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

/** SCRUM-906: beside a line no live till product carries (the owner's decision 1). */
export const PARTY_NOT_ON_TILL_MENU = 'not on the till menu';

/**
 * SCRUM-906: the slip composer's generation. A slip composed by an earlier
 * generation, or from a plan the OTO App published in an earlier shape, is
 * not compared line by line with one composed now: the api takes what the
 * plan composes now as what the station holds, and prints nothing for it
 * (`party-slips.ts` in the api: a release is not a change). Raise it when
 * the composer changes what an unchanged plan prints.
 *
 * 3 (SCRUM-951): the bar slip's time is the bar plan's own service time when
 * the BEO gives one, so a bar slip printed before this release under the
 * kitchen's READY BY is taken as the plan now composes it, and no VOID or
 * UPDATED slip goes to the bar for the release alone.
 */
export const PARTY_SLIP_COMPOSER = 3;

/** "Fried rice: Veggie": a chosen dish under its group's name. */
export const partyChoiceName = (group: string, choice: string): string => `${group.trim()}: ${choice.trim()}`;

/** The cake as the BEO names it. */
export const PARTY_CAKE_NAMES: Record<PartyCakeType, string> = { our: 'Our Cake', own: 'Own Cake' };

/** The cake's slip line: its name, quantity, time and notes, as the BEO's cake choice says them. */
export function partyCakeSlipLine(cake: PartyPlanCake): PartySlipLine {
  const notes = [cake.time?.trim() ? `Cake time ${cake.time.trim()}` : null, cake.note?.trim() || null].filter(
    (n): n is string => !!n,
  );
  return { qty: cake.qty, name: PARTY_CAKE_NAMES[cake.type], ...(notes.length ? { note: notes.join(' · ') } : {}) };
}

/** SCRUM-829: the adults' changes, marked on the one food list (the BEO PDF prints the same words). */
export const PARTY_KIDS_ONLY = 'kids only';
export const PARTY_ADULTS_ONLY = 'adults only';
/** Beside a kids' line with a note whose adults' copy has none. */
export const PARTY_ADULTS_NO_NOTE = 'adults: no note';
/** "adults: <note>", or the no-note mark when the adults' copy's note was cleared. */
export const partyAdultsNoteMark = (note: string): string => (note.trim() ? `adults: ${note.trim()}` : PARTY_ADULTS_NO_NOTE);
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

/**
 * SCRUM-951 — the bar slip's time: the bar plan's own service time when the
 * BEO gives one ("Bar service 19:15", as the BEO and the party page say it),
 * else the kitchen's READY BY as before (`partyReadyBy`); null when neither.
 */
export function partyBarReadyBy(plan: Pick<PartyPlan, 'kitchen'>): string | null {
  const bar = clockMinutes(plan.kitchen?.barServiceTime ?? null);
  return bar === null ? partyReadyBy(plan) : clockOf(bar);
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
  plan: Pick<PartyKitchenPlan, 'setMenu' | 'barItems' | 'kitchen' | 'counts' | 'cake'>;
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
  /** The dish the line is, as an adults' line of the same dish finds it (the chosen option, else the name). */
  dish: string;
  /** Where the line came from (SCRUM-906), so an adults' copy folds into the line it copies. */
  origin?: string | undefined;
  notes: string[];
}

const draftToLine = (d: SlipLineDraft): PartySlipLine => ({
  ...(d.qty === null ? {} : { qty: d.qty }),
  name: d.name,
  ...(d.notes.length ? { note: d.notes.join(' · ') } : {}),
});

/**
 * The party's two slips; null for a station the plan has nothing for. Lines
 * keep the plan's order: the set menu and the food lists, then the bar plan,
 * then the cake. An adults' line (SCRUM-829) of a dish the station's slip
 * already lists folds into that line, as the file's header says; one of a new
 * dish is its own line.
 */
export function composePartySlips(input: PartySlipInput): Record<PartySlipStation, PartySlipDocument | null> {
  const drafts: Record<PartySlipStation, SlipLineDraft[]> = { kitchen: [], bar: [] };
  for (const item of input.plan.setMenu) {
    // Where the till product prints; null when no live product carries the code, or there is none.
    const place = item.productCode ? input.prepStationOf(item.productCode) : null;
    if (place === 'none') continue;
    const station = place ?? 'kitchen';
    const dish = (item.chosenOption ?? item.name).trim();
    if (!dish) continue;
    const group = (item.choiceGroup ?? item.name).trim();
    const name = item.chosenOption && group ? partyChoiceName(group, item.chosenOption) : dish;
    const note = item.note?.trim() || null;
    const open = !!item.choiceGroup && !item.chosenOption;
    // SCRUM-906: no till product makes it (an open choice is no dish yet).
    const offMenu = place === null && !open ? PARTY_NOT_ON_TILL_MENU : null;
    if (item.audience === 'adults') {
      // The line of that dish it copies: one from the same list first (a set-menu copy into the set
      // menu's line, an extra's into the extra), else the first of that dish.
      const foldable = drafts[station].filter((d) => foldName(d.dish) === foldName(dish) && !d.notes.includes(PARTY_ADULTS_ONLY));
      const held = foldable.find((d) => d.origin === item.origin) ?? foldable[0];
      if (held) {
        const adultsQty = item.qty ?? 1;
        if (held.qty !== adultsQty) {
          held.notes.push(partyCountsMark(held.qty, adultsQty));
          held.qty = null;
        } else if (note) {
          held.notes.push(partyAdultsNoteMark(note));
        }
        continue;
      }
      drafts[station].push({
        qty: item.qty,
        name,
        dish,
        origin: item.origin,
        notes: [PARTY_ADULTS_ONLY, ...(note ? [note] : []), ...(offMenu ? [offMenu] : [])],
      });
      continue;
    }
    const notes = [
      open ? PARTY_CHOICE_NOT_MADE : null,
      note,
      item.audience === 'kids' ? PARTY_KIDS_ONLY : null,
      // The same dish for the adults with another note: one line, their note beside it.
      item.adultsNote === undefined ? null : partyAdultsNoteMark(item.adultsNote),
      offMenu,
    ].filter((n): n is string => !!n);
    drafts[station].push({ qty: item.qty, name, dish, origin: item.origin, notes });
  }
  const lines: Record<PartySlipStation, PartySlipLine[]> = {
    kitchen: drafts.kitchen.map(draftToLine),
    bar: drafts.bar.map(draftToLine),
  };
  // SCRUM-906: every bar-plan line prints. It goes to the kitchen when its own till code prints there
  // (decision 7), and to the bar otherwise: a drink, a line with no code, and one whose till item
  // prints nowhere on a sale (a bottled water), which the bar still has to bring.
  for (const item of input.plan.barItems) {
    const name = item.name.trim();
    if (!name) continue;
    const place = item.productCode ? input.prepStationOf(item.productCode) : null;
    const notes = [item.note?.trim() || null, place === null ? PARTY_NOT_ON_TILL_MENU : null].filter(
      (n): n is string => !!n,
    );
    const station: PartySlipStation = place === 'kitchen' ? 'kitchen' : 'bar';
    lines[station].push({ qty: item.qty, name, ...(notes.length ? { note: notes.join(' · ') } : {}) });
  }
  // SCRUM-906: the cake, as the BEO's cake choice says it (decision 4).
  if (input.plan.cake) lines.kitchen.push(partyCakeSlipLine(input.plan.cake));

  // SCRUM-951: the bar slip says the bar's own service time when the BEO gives one; the kitchen's is unchanged.
  const ready: Record<PartySlipStation, string | null> = {
    kitchen: partyReadyBy(input.plan),
    bar: partyBarReadyBy(input.plan),
  };
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
          ...(ready[station] ? { readyBy: ready[station] } : { readyByNote: PARTY_NO_KIDS_FOOD_TIME }),
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
