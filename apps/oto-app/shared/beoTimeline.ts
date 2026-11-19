import { beoQuantityOf } from "./beoQuantity";
import { ADULTS_SAME_AS_KIDS, adultsDifferOf, kitchenLinesOf, type KitchenLineLike } from "./kitchenAdults";

/**
 * ONE TIMELINE, MADE BY THE SYSTEM (SCRUM-1027).
 *
 * The party's timeline is built from the stored BEO, never typed twice. Every
 * reader that shows a timeline builds it here: the BEO PDF, the editor's
 * preview, the Day-of view and the view-only BEO (through the server's
 * `GET /api/events/:eventId/beo/timeline/built`, server/lib/beoTimelineRead.ts),
 * and the generator that keeps the stored automatic rows in step with it
 * (`generateTimelineFromBeo` in server/beo-routes.ts, for the Day-of view's
 * ticks).
 *
 * What it merges, in time order:
 *   - the party's own times: setup ready-by, guests arrive at the start, the
 *     party ends at the end (and an old event's setup items at the offset
 *     its setup plan stores);
 *   - every food service time the BEO stores, with what is served: the kids'
 *     menu, the adults' menu (their own list, or the kids' menu at a time of
 *     their own), an old event's service blocks, the bar, the cake;
 *   - every Entertainment activity with its time and its person;
 *   - the rows typed by hand (or written by AI Fill): the "other timed steps".
 *
 * Nothing is invented: a step whose time the BEO does not store is not given
 * one; it is listed in `untimed` with the part of the BEO that shows it
 * (`home`). A dish with no count is one (`beoQuantityOf`, the owner's
 * answer). Times are the park's clock as stored: no time zone is applied.
 * Steps at the same time keep the order party, food, activity, other.
 *
 * "The same step" (shown once): the same minute and the same words, case,
 * spacing and punctuation aside. A row typed by hand that repeats a step the
 * system makes is not shown a second time; two rows typed by hand that are
 * the same step are shown once. Anything less than that is shown twice
 * rather than dropped.
 */

export type BeoTimelineKind = "party" | "food" | "activity" | "other";
/** Where a step with no time is shown instead of the timeline. */
export type BeoUntimedHome = "timeline" | "entertainment" | "setup" | "kitchen" | "bar";

export interface BeoTimelineStep {
  /** A step the system makes: the source key its stored row carries. A row typed by hand: "row:<id>". */
  key: string;
  /** HH:MM on the park's clock. */
  time: string;
  minuteOfDay: number;
  kind: BeoTimelineKind;
  label: string;
  /** What is served, for a food step. */
  detail: string | null;
  person: string | null;
  /** The stored row's role ("PARTY_HOST", "SETUP_RESPONSIBLE", "KITCHEN_RESPONSIBLE", ...). */
  assignedToType: string;
  generated: boolean;
  /** The stored `beo_timeline_items` row, for a tick or an edit; null for a step not stored yet. */
  rowId: string | null;
  isCompleted: boolean;
}

export interface BeoUntimedStep {
  key: string;
  kind: BeoTimelineKind;
  label: string;
  detail: string | null;
  person: string | null;
  home: BeoUntimedHome;
  rowId: string | null;
}

export interface BeoTimeline {
  steps: BeoTimelineStep[];
  untimed: BeoUntimedStep[];
}

export interface BeoTimelineActivity {
  id: string;
  customName?: string | null;
  startTime?: string | null;
  /** The activity's own person, as stored for it; never the party's other hosts. */
  person?: string | null;
}

export interface BeoTimelineRow {
  id: string;
  label: string;
  offsetFromStartMinutes: number;
  isSystemGenerated: boolean;
  sourceKey?: string | null;
  isCompleted?: boolean | null;
  assignedToType?: string | null;
  sortOrder?: number | null;
}

/** The stored BEO, as its tables hold it; every part may be missing. */
export interface BeoTimelineSource {
  startTime?: string | null;
  endTime?: string | null;
  /** `core_events.suppressed_timeline_sources`: automatic steps staff removed. */
  suppressedSources?: readonly string[] | null;
  setupPlan?: {
    setupRequired?: boolean | null;
    setupTasks?: unknown;
    setupItems?: readonly string[] | null;
    setupDeadlineOffsetMinutes?: number | null;
  } | null;
  kitchenPlan?: {
    foodRequired?: boolean | null;
    menus?: unknown;
    simplifiedMenus?: unknown;
    serviceSchedule?: unknown;
    cakeMode?: string | null;
    cakeTime?: string | null;
    cakeNotes?: string | null;
    cakeQuantity?: number | null;
  } | null;
  barPlan?: { serviceTime?: string | null; items?: unknown } | null;
  activities?: readonly BeoTimelineActivity[] | null;
  rows?: readonly BeoTimelineRow[] | null;
}

export const STEP_GUESTS_ARRIVE = "Guests arrive";
export const STEP_SETUP_READY = "Setup ready";
export const STEP_PARTY_ENDS = "Party ends";
export const STEP_KIDS_MENU = "Kids' menu served";
export const STEP_ADULTS_MENU = "Adults' menu served";
export const STEP_FOOD_SERVICE = "F&B Service";
export const STEP_DRINKS = "Drinks Service";
export const STEP_CAKE = "Cake moment";
export const STEP_ACTIVITY = "Entertainment";

const KIND_ORDER: Record<BeoTimelineKind, number> = { party: 0, food: 1, activity: 2, other: 3 };
const DAY = 24 * 60;

/** A stored clock time ("9:30", "09:30", "14:00:00") as HH:MM and its minute of the day; null when it is none. */
export function beoClockOf(value: unknown): { time: string; minute: number } | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { time: clockAt(h * 60 + min), minute: h * 60 + min };
}

/** A minute of the day as HH:MM, wrapped onto the clock as the stored offsets always were. */
function clockAt(minute: number): string {
  const m = ((minute % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const minuteAt = (minute: number) => ((minute % DAY) + DAY) % DAY;

/** A step's words as compared: case, spacing and punctuation aside. */
export function foldStepWords(words: unknown): string {
  return typeof words === "string"
    ? words.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim()
    : "";
}

/** Two steps are the same when they are at the same minute and say the same thing. */
export function sameTimelineStep(a: { minuteOfDay: number; label: string }, b: { minuteOfDay: number; label: string }): boolean {
  const words = foldStepWords(a.label);
  return a.minuteOfDay === b.minuteOfDay && words !== "" && words === foldStepWords(b.label);
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** What is served: "3x Margherita, 1x French fries" (a line with no count is one). */
export function servedOf(lines: readonly KitchenLineLike[]): string | null {
  const said = lines
    .filter((l) => text(l.itemName))
    .map((l) => `${beoQuantityOf(l.quantity)}x ${text(l.itemName)}`);
  return said.length > 0 ? said.join(", ") : null;
}

interface MadeStep {
  key: string;
  kind: BeoTimelineKind;
  label: string;
  detail: string | null;
  person: string | null;
  assignedToType: string;
  clock: { time: string; minute: number } | null;
  home: BeoUntimedHome;
}

/**
 * The steps the system makes from the BEO's own fields, timed or not, in the
 * order they are made (party, food, activity). Suppression and the stored
 * rows play no part here: `buildBeoTimeline` applies them, and the generator
 * that stores the automatic rows applies suppression its own way.
 */
export function beoMadeSteps(src: BeoTimelineSource): MadeStep[] {
  const made: MadeStep[] = [];
  const start = beoClockOf(src.startTime);
  const atOffset = (offset: unknown) =>
    start && typeof offset === "number" && Number.isFinite(offset) ? { time: clockAt(start.minute + offset), minute: minuteAt(start.minute + offset) } : null;

  // The party's own times. The setup comes first at an equal time: it is ready before the guests arrive.
  const setup = src.setupPlan;
  if (setup?.setupRequired) {
    const raw = setup.setupTasks;
    const plan = asObject(raw);
    const tasks: unknown[] = Array.isArray(raw) ? raw : Array.isArray(plan.simplifiedTasks) ? plan.simplifiedTasks : [];
    const readyBy = Array.isArray(raw) ? "" : text(plan.readyBy);
    if (readyBy) {
      const clock = beoClockOf(readyBy);
      made.push({ key: "setup_ready", kind: "party", label: STEP_SETUP_READY, detail: null, person: null, assignedToType: "SETUP_RESPONSIBLE", clock, home: "setup" });
    }
    if (tasks.length > 0) {
      tasks.forEach((task, idx) => {
        const t = asObject(task);
        const label = text(t.itemLabel) || text(t.itemKey) || "Setup task";
        // A task is timed only by a deadline stored on it; none is given one (it prints in the setup plan).
        const deadline = typeof t.deadlineOffsetMin === "number" ? -t.deadlineOffsetMin : null;
        made.push({ key: `setup_task::${idx}`, kind: "party", label, detail: null, person: null, assignedToType: "SETUP_RESPONSIBLE", clock: atOffset(deadline), home: "setup" });
      });
    } else if (!readyBy) {
      // An old setup plan's items, at the offset before the start its plan stores.
      const items = Array.isArray(setup.setupItems) ? setup.setupItems : [];
      const offset = typeof setup.setupDeadlineOffsetMinutes === "number" ? -setup.setupDeadlineOffsetMinutes : null;
      items.forEach((name, idx) => {
        made.push({ key: `setup_item::${idx}`, kind: "party", label: text(name), detail: null, person: null, assignedToType: "SETUP_RESPONSIBLE", clock: atOffset(offset), home: "setup" });
      });
    }
  }
  if (start) {
    made.push({ key: "guests_arrive", kind: "party", label: STEP_GUESTS_ARRIVE, detail: null, person: null, assignedToType: "PARTY_HOST", clock: start, home: "timeline" });
  }
  const end = beoClockOf(src.endTime);
  if (end) {
    made.push({ key: "party_end", kind: "party", label: STEP_PARTY_ENDS, detail: null, person: null, assignedToType: "PARTY_HOST", clock: end, home: "timeline" });
  }

  // Food: the kids' menu, the adults', an old event's service blocks, the bar, the cake.
  const kitchen = src.kitchenPlan;
  if (kitchen?.foodRequired) {
    const menus = asObject(kitchen.menus);
    const kids = kitchenLinesOf(Array.isArray(menus.kids) ? menus.kids : asObject(kitchen.simplifiedMenus).kids);
    const kidsAt = beoClockOf(menus.kidsFoodTime);
    if (kidsAt || kids.length > 0) {
      made.push({ key: "kids_food", kind: "food", label: STEP_KIDS_MENU, detail: servedOf(kids), person: null, assignedToType: "KITCHEN_RESPONSIBLE", clock: kidsAt, home: "kitchen" });
    }
    const adultsAt = beoClockOf(menus.adultsFoodTime);
    const differ = adultsDifferOf({ ...menus, kids });
    if (differ) {
      made.push({ key: "adults_food", kind: "food", label: STEP_ADULTS_MENU, detail: servedOf(kitchenLinesOf(menus.adults)), person: null, assignedToType: "KITCHEN_RESPONSIBLE", clock: adultsAt, home: "kitchen" });
    } else if (adultsAt && adultsAt.minute !== kidsAt?.minute) {
      // The adults eat the kids' menu, at a time of their own.
      made.push({ key: "adults_food", kind: "food", label: STEP_ADULTS_MENU, detail: ADULTS_SAME_AS_KIDS, person: null, assignedToType: "KITCHEN_RESPONSIBLE", clock: adultsAt, home: "kitchen" });
    }
    const schedule = Array.isArray(kitchen.serviceSchedule) ? kitchen.serviceSchedule : [];
    const seenBlocks = new Set<string>();
    schedule.forEach((block, idx) => {
      const b = asObject(block);
      if (!b.label && !b.time) return;
      const dedupeKey = `${b.label || ""}::${b.time || ""}`;
      if (seenBlocks.has(dedupeKey)) return;
      seenBlocks.add(dedupeKey);
      made.push({
        key: `kitchen_service::${idx}`,
        kind: "food",
        label: text(b.label) || STEP_FOOD_SERVICE,
        detail: servedOf(kitchenLinesOf(b.items)),
        person: null,
        assignedToType: "KITCHEN_RESPONSIBLE",
        clock: beoClockOf(b.time),
        home: "kitchen",
      });
    });
  }
  const bar = src.barPlan;
  if (bar) {
    const drinks = kitchenLinesOf(bar.items);
    const barAt = beoClockOf(bar.serviceTime);
    if (barAt || drinks.length > 0) {
      made.push({ key: "bar_service", kind: "food", label: STEP_DRINKS, detail: servedOf(drinks), person: null, assignedToType: "PARTY_HOST", clock: barAt, home: "bar" });
    }
  }
  if (kitchen?.cakeMode && kitchen.cakeMode !== "NONE") {
    const count = beoQuantityOf(kitchen.cakeQuantity);
    const notes = text(kitchen.cakeNotes);
    const cake = `${kitchen.cakeMode === "EXTERNAL" ? "Own cake" : "Our cake"}${count > 1 ? ` x${count}` : ""}${notes ? `: ${notes}` : ""}`;
    made.push({ key: "cake", kind: "food", label: STEP_CAKE, detail: cake, person: null, assignedToType: "PARTY_HOST", clock: beoClockOf(kitchen.cakeTime), home: "kitchen" });
  }

  // Every activity of Entertainment, with its time and its person.
  for (const act of src.activities ?? []) {
    made.push({
      key: `entertainment::${act.id}`,
      kind: "activity",
      label: text(act.customName) || STEP_ACTIVITY,
      detail: null,
      person: text(act.person) || null,
      assignedToType: "PARTY_HOST",
      clock: beoClockOf(act.startTime),
      home: "entertainment",
    });
  }
  return made;
}

/** The steps the system makes that have a time, for the generator that stores them as rows. */
export function beoTimedMadeSteps(src: BeoTimelineSource): Array<MadeStep & { clock: { time: string; minute: number } }> {
  return beoMadeSteps(src).filter((s): s is MadeStep & { clock: { time: string; minute: number } } => s.clock !== null);
}

/** The party's one timeline, from the stored BEO. */
export function buildBeoTimeline(src: BeoTimelineSource): BeoTimeline {
  const suppressed = new Set(src.suppressedSources ?? []);
  const rows = [...(src.rows ?? [])];
  const storedAuto = new Map<string, BeoTimelineRow>();
  for (const row of rows) if (row.isSystemGenerated && row.sourceKey) storedAuto.set(row.sourceKey, row);

  const steps: BeoTimelineStep[] = [];
  const untimed: BeoUntimedStep[] = [];
  for (const s of beoMadeSteps(src)) {
    if (suppressed.has(s.key)) continue;
    const row = storedAuto.get(s.key) ?? null;
    if (!s.clock) {
      untimed.push({ key: s.key, kind: s.kind, label: s.label, detail: s.detail, person: s.person, home: s.home, rowId: null });
      continue;
    }
    steps.push({
      key: s.key,
      time: s.clock.time,
      minuteOfDay: s.clock.minute,
      kind: s.kind,
      label: s.label,
      detail: s.detail,
      person: s.person,
      assignedToType: s.assignedToType,
      generated: true,
      rowId: row?.id ?? null,
      isCompleted: !!row?.isCompleted,
    });
  }

  // The other timed steps: every row typed by hand (or written by AI Fill), in their stored order.
  const start = beoClockOf(src.startTime);
  const typed = rows
    .map((row, at) => ({ row, at }))
    .filter(({ row }) => !row.isSystemGenerated)
    .sort((a, b) => (a.row.sortOrder ?? 0) - (b.row.sortOrder ?? 0) || a.at - b.at)
    .map(({ row }) => row);
  const made = [...steps];
  const kept: BeoTimelineStep[] = [];
  for (const row of typed) {
    const offset = Number(row.offsetFromStartMinutes);
    if (!start || !Number.isFinite(offset)) {
      // A row is stored as minutes from the start: with no start its clock time is not known.
      untimed.push({ key: `row:${row.id}`, kind: "other", label: row.label, detail: null, person: null, home: "timeline", rowId: row.id });
      continue;
    }
    const step: BeoTimelineStep = {
      key: `row:${row.id}`,
      time: clockAt(start.minute + offset),
      minuteOfDay: minuteAt(start.minute + offset),
      kind: "other",
      label: row.label,
      detail: null,
      person: null,
      assignedToType: row.assignedToType || "PARTY_HOST",
      generated: false,
      rowId: row.id,
      isCompleted: !!row.isCompleted,
    };
    if (made.some((m) => sameTimelineStep(m, step)) || kept.some((k) => sameTimelineStep(k, step))) continue;
    kept.push(step);
  }

  const all = [...steps, ...kept]
    .map((step, at) => ({ step, at }))
    .sort((a, b) => a.step.minuteOfDay - b.step.minuteOfDay || KIND_ORDER[a.step.kind] - KIND_ORDER[b.step.kind] || a.at - b.at)
    .map(({ step }) => step);
  return { steps: all, untimed };
}

/** The steps with no time that no other part of the BEO shows: listed beside the timeline, never given a time. */
export function untimedBesideTimeline(timeline: BeoTimeline): BeoUntimedStep[] {
  return timeline.untimed.filter((u) => u.home === "timeline" || u.home === "entertainment");
}

/** A step in one line, as the readers print it: "Kids' menu served: 3x Margherita" or "Bubble show · Party host". */
export function timelineStepLine(step: { label: string; detail: string | null; person: string | null }): string {
  return `${step.label}${step.detail ? `: ${step.detail}` : ""}${step.person ? ` · ${step.person}` : ""}`;
}
