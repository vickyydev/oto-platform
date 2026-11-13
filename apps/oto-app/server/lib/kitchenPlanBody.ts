import { z } from "zod";

/**
 * SCRUM-978 (SCRUM-966 point 5) — WHAT A WRITE OF A PARTY'S KITCHEN PLAN MAY
 * HOLD, checked before anything is written.
 *
 * `PUT /api/events/:eventId/beo/kitchen-plan` (the BEO day-of view's door:
 * its food lists, the kids' and adults' service times, "Kitchen needed", the
 * set menu switch and template) took its body with no check at all and
 * spread it into the row: a list that was no list, a count of "two", a price
 * that was an object, even the row's own id, were written as sent. Now the
 * body is read against this shape first and one no reader can read is
 * refused with 400 and the reason in staff words, nothing written; only the
 * plan's own fields are kept (the row's id, event, timestamps and the kitchen
 * sign-off, which has its own route, are never taken from a body).
 *
 * THE DAY-OF VIEW SENDS THE WHOLE STORED LIST ON EVERY CHANGE
 * (client/src/components/beo/beo-day-of-view.tsx, buildMenusPayload: the
 * plan's stored `menus` spread, both lists, the switch, the two times), so a
 * value the app stored and reads is never refused here: one stored line the
 * check refused would refuse every day-of change of that party. What every
 * reader reads is taken as they read it, and only a shape no reader can read
 * is refused. The readers: the day-of view (a line's count shown and stepped
 * by +/-), the BEO editor's `mapMenu` (`quantity || 1`, `price || 0`,
 * `itemName || ""`), shared/kitchenAdults.ts (a count that is no number from
 * 1 is 1), server/pdf.ts with shared/beoExtras.ts (a count that is no number
 * from 1 is 1; a price that is no number above 0 is none), the till's plan
 * view (app migration 0050: a count is its text when that is a whole number
 * from 1, else 1; a price only when it is a number above 0; a line with no
 * name is skipped; a time is its text) and the till's kitchen edit
 * (server/lib/tillKitchenEdit.ts: a count that is no number from 1 is 1).
 * So, on a line of either list:
 *   - a count that is absent, null or "" stays so (every reader reads 1);
 *     the day-of +/- on a line with no count sends NaN, which arrives as
 *     null. A count of 0 stays 0 (read as 1); any other count from 0 stays
 *     as it came. A count given as numeric text ("2") is taken as its number
 *     (the till's plan view reads it so; the others read it as 1).
 *   - a price that is absent, null or "" stays so (none); one given as
 *     numeric text ("120") is taken as its number.
 *   - a line with no name, or an empty one, stays as it is (a line just
 *     added and not named yet; the till skips it).
 *   - every other key of a line (its id, note, badge, set-menu group, till
 *     code, "included") is kept exactly as it came.
 * Still refused: a list that is no list, a line that is no object, a count or
 * a price that is text but no number ("two"), a negative count or price, a
 * field of the wrong kind (an object where text belongs), absurd sizes.
 *
 * A service or cake time is a clock time as the app's pickers and the AI fill
 * write it ("14:00", "9:30", "14:00:00"), or empty. The cake's price and the
 * cake count given as numeric text are their numbers. The cake's price may be
 * any number: the editor's box writes `Number(v) || 0`, with no floor.
 */

/** A count of portions on a line: SCRUM-906's bound, the till's kitchen edit's. */
const COUNT_MAX = 999_999;
/** A line's price, in baht for each item. */
const PRICE_MAX = 1_000_000;
/** The cake's price, in baht. */
const CAKE_PRICE_MAX = 100_000_000;
/** How many cakes, as the editor and the AI fill write it. */
export const CAKE_COUNT_MAX = 99;

/** Numeric text as the app has written it ("2", "120", "99.5"); never "two", "1e3" or "0x10". */
const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * A figure as it came: absent; none (null, or text that is empty); a number (a number, or numeric
 * text read as its number); or no figure at all (text that is no number, or a value of another kind).
 * NaN, which JSON cannot carry, is absent.
 */
type Figure = { kind: "absent" } | { kind: "none" } | { kind: "number"; value: number } | { kind: "wrong" };
function figureOf(value: unknown): Figure {
  if (value === undefined) return { kind: "absent" };
  if (value === null) return { kind: "none" };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { kind: "absent" };
    return Number.isFinite(value) ? { kind: "number", value } : { kind: "wrong" };
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return { kind: "none" };
    return NUMERIC_TEXT.test(text) ? { kind: "number", value: Number(text) } : { kind: "wrong" };
  }
  return { kind: "wrong" };
}

/**
 * A figure of a line or of the plan: null and "" kept as they came, numeric text taken as its
 * number, a number held to its bounds; text that is no number, or a value of another kind, refused.
 */
const figure = (words: { wrong: string; min: number | null; belowMin: string; max: number; aboveMax: string }) =>
  z.unknown().transform((value, ctx): number | string | null | undefined => {
    const read = figureOf(value);
    if (read.kind === "absent") return undefined;
    if (read.kind === "none") return value as string | null;
    if (read.kind === "wrong") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: words.wrong });
      return z.NEVER;
    }
    if (words.min !== null && read.value < words.min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: words.belowMin });
      return z.NEVER;
    }
    if (Math.abs(read.value) > words.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: words.aboveMax });
      return z.NEVER;
    }
    return read.value;
  });

/** A line's count: absent, null or "" kept (read as 1); 0 and upward kept; "2" is 2. */
const LineCount = figure({
  wrong: "the count is a number",
  min: 0,
  belowMin: "the count is 0 or more",
  max: COUNT_MAX,
  aboveMax: "the count is at most 999,999",
});
/** A line's price for each item: absent, null or "" kept (none); 0 and upward kept; "120" is 120. */
const LinePrice = figure({
  wrong: "the price is a number of baht",
  min: 0,
  belowMin: "the price is 0 or more",
  max: PRICE_MAX,
  aboveMax: "the price is at most 1,000,000 baht",
});
/** The cake's price: any number the editor's box writes; "800" is 800. */
const CakePrice = figure({
  wrong: "the cake's price is a number of baht",
  min: null,
  belowMin: "",
  max: CAKE_PRICE_MAX,
  aboveMax: "the cake's price is at most 100,000,000 baht",
});

/** How many cakes a value says: a whole number from 1 to 99, given as a number or as numeric text; else null. */
export function cakeCountOf(value: unknown): number | null {
  const read = figureOf(value);
  return read.kind === "number" && Number.isInteger(read.value) && read.value >= 1 && read.value <= CAKE_COUNT_MAX ? read.value : null;
}

/** Whether a value is a cake count the plan may hold (numeric text too: `cakeCountOf` gives its number). */
export const isCakeCount = (value: unknown): boolean => cakeCountOf(value) !== null;

/** The cake count a body sends: absent, null or "" is none sent (the plan keeps its own); else 1 to 99. */
const CakeQuantity = z.unknown().transform((value, ctx): number | undefined => {
  const read = figureOf(value);
  if (read.kind === "absent" || read.kind === "none") return undefined;
  const cakes = cakeCountOf(value);
  if (cakes === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the cake count is a whole number from 1 to ${CAKE_COUNT_MAX}` });
    return z.NEVER;
  }
  return cakes;
});

/** A clock time as the app's pickers and the AI fill write it: "14:00", "9:30", "14:00:00". */
const CLOCK = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const clockOrEmpty = (what: string) => {
  const words = `${what} is a time such as 14:00, or empty`;
  return z
    .string({ invalid_type_error: words })
    .refine((v) => v.trim() === "" || CLOCK.test(v.trim()), words)
    .nullable()
    .optional();
};

/** Text of a field, or none; `what` names it in staff words ("the note"). */
const textOf = (what: string, max: number) =>
  z
    .string({ invalid_type_error: `${what} is text` })
    .max(max, `${what} is at most ${max.toLocaleString("en-US")} characters`)
    .nullable()
    .optional();

/** A line of the kids' or the adults' food list. Its other keys (id, "included", ...) ride as they are. */
export const kitchenPlanLineSchema = z
  .object(
    {
      itemName: textOf("the name", 500),
      quantity: LineCount,
      price: LinePrice,
      notes: textOf("the note", 4000),
      productCode: textOf("the till code", 64),
      source: textOf("the SET or EXTRA mark", 40),
      groupId: textOf("the set-menu group", 200),
    },
    { invalid_type_error: "it is not a line of the menu" },
  )
  .passthrough();

/** A food list, named in staff words ("the kids' menu"). */
const linesOf = (list: string) =>
  z
    .array(kitchenPlanLineSchema, { invalid_type_error: `${list} is a list of lines` })
    .max(500, `${list} holds at most 500 lines`);

/** The plan's `menus`: the two lists, the adults' switch, the service times; its other keys ride along. */
export const kitchenPlanMenusSchema = z
  .object(
    {
      kids: linesOf("the kids' menu").optional(),
      adults: linesOf("the adults' menu").optional(),
      adultsDiffer: z.boolean({ invalid_type_error: "\"Different for adults\" is on or off" }).optional(),
      kidsFoodTime: clockOrEmpty("the kids' food time"),
      adultsFoodTime: clockOrEmpty("the adults' food time"),
      cakePrice: CakePrice,
      cakeIncluded: z.boolean({ invalid_type_error: "the cake's INCL or EXTRA is on or off" }).nullable().optional(),
    },
    { invalid_type_error: "the menus are not a kitchen menu" },
  )
  .passthrough();

/** A set-menu template's id: the column is a uuid (server/db/coreSchema.ts); "" is none, as every reader reads it. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TemplateId = z.unknown().transform((value, ctx): string | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "string" && UUID_TEXT.test(value.trim())) return value.trim();
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "the set menu template is not a set menu" });
  return z.NEVER;
});

/** What `PUT /api/events/:eventId/beo/kitchen-plan` takes. Keys of anything else are left out. */
export const kitchenPlanPutBodySchema = z
  .object(
    {
      foodRequired: z.boolean({ invalid_type_error: "\"Kitchen needed\" is on or off" }).optional(),
      setMenuEnabled: z.boolean({ invalid_type_error: "the set menu is on or off" }).optional(),
      setMenuTemplateId: TemplateId,
      setMenuSelectionSubmittedAt: textOf("the time of the family's set-menu answer", 100),
      menus: kitchenPlanMenusSchema.optional(),
      simplifiedMenus: z
        .object(
          { kids: linesOf("the kids' menu").optional(), adults: linesOf("the adults' menu").optional() },
          { invalid_type_error: "the menus are not a kitchen menu" },
        )
        .passthrough()
        .optional(),
      cakeMode: z
        .enum(["NONE", "INTERNAL", "EXTERNAL"], { errorMap: () => ({ message: "the cake is no cake, our cake or the family's own" }) })
        .optional(),
      cakeQuantity: CakeQuantity,
      cakeTime: clockOrEmpty("the cake time"),
      cakeNotes: textOf("the cake note", 4000),
      kitchenNotes: textOf("the kitchen note", 4000),
      dietaryNotes: textOf("the dietary note", 4000),
      dietaryTags: z
        .array(z.string({ invalid_type_error: "a dietary tag is text" }).max(100, "a dietary tag is at most 100 characters"), {
          invalid_type_error: "the dietary tags are a list",
        })
        .max(50, "the dietary tags are at most 50")
        .nullable()
        .optional(),
      serviceSchedule: z
        .array(z.unknown(), { invalid_type_error: "the service schedule is a list" })
        .max(100, "the service schedule holds at most 100 steps")
        .nullable()
        .optional(),
      kitchenReadyOffsetMinutes: z
        .number({ invalid_type_error: "the kitchen's ready time is a number of minutes" })
        .int("the kitchen's ready time is a whole number of minutes")
        .min(-1440, "the kitchen's ready time is within a day")
        .max(1440, "the kitchen's ready time is within a day")
        .optional(),
    },
    { invalid_type_error: "what was sent is not a kitchen plan" },
  )
  // A field with no value of its own (a cake count sent as null or "") is no field: the row keeps its own.
  .transform((body) => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as typeof body);
export type KitchenPlanPutBody = z.infer<typeof kitchenPlanPutBodySchema>;

/** A food list's name in staff words. */
const LIST_NAMES = new Map<unknown, string>([["kids", "the kids' menu"], ["adults", "the adults' menu"]]);

/**
 * The reason a body was refused, in staff words: "The kitchen plan was not saved: line 2 of the kids'
 * menu: the count is a number." for a line, the field's plain name for anything else ("The kitchen
 * plan was not saved: the kids' food time is a time such as 14:00, or empty.").
 */
export function kitchenPlanBodyRefusal(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "The kitchen plan was not saved: what was sent is not a kitchen plan.";
  const path = first.path;
  const at = path.findIndex((p, i) => typeof p === "number" && i > 0 && LIST_NAMES.has(path[i - 1]));
  const where = at >= 0 ? `line ${(path[at] as number) + 1} of ${LIST_NAMES.get(path[at - 1])}: ` : "";
  // Every message above is in staff words; one of zod's own ("Expected ...") never reaches the staff as it is.
  const words = /^[a-z"]/.test(first.message) ? first.message : "a value is not one the kitchen plan holds";
  return `The kitchen plan was not saved: ${where}${words}.`;
}
