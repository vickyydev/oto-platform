import { z } from "zod";

/**
 * SCRUM-978 (SCRUM-966 point 5) — WHAT A WRITE OF A PARTY'S KITCHEN PLAN MAY
 * HOLD, checked before anything is written.
 *
 * `PUT /api/events/:eventId/beo/kitchen-plan` (the BEO day-of view's door:
 * its food lists, the kids' and adults' service times, "Kitchen required",
 * the set menu switch and template) took its body with no check at all and
 * spread it into the row: a list that was no list, a count of 0 or "two", a
 * price that was text, even the row's own id, were written as sent. Now the
 * body is read against this shape first and a malformed one is refused with
 * 400 and the reason, nothing written; only the plan's own fields are kept
 * (the row's id, event, timestamps and the kitchen sign-off, which has its
 * own route, are never taken from a body).
 *
 * The shape is what every writer of the plan sends today (the checks of
 * those lanes are the proof, tests/beo-left-978.check.ts parses each):
 *   - the BEO day-of view (client/src/components/beo/beo-day-of-view.tsx):
 *     `menus` (the plan's own keys spread, the lists, the switch, the two
 *     times), `foodRequired`, `setMenuEnabled`, `setMenuTemplateId`, and
 *     `setMenuSelectionSubmittedAt`;
 *   - the BEO editor's Save (`kitchenPlan` of PUT /api/events/:eventId/beo);
 *   - the AI fill's approval (server/lib/beoAiApprove.ts) and the till's
 *     kitchen edit (server/lib/tillKitchenEdit.ts), which write through the
 *     same writers without this door.
 *
 * A line: a name (text; a line just added and not named yet is "") and,
 * when it says one, a whole count from 1 (a line from before counts that
 * gave none is read as 1 everywhere, so it is not refused); a price, when it
 * has one, a number of baht for each item from 0. A service or cake time is
 * a clock time ("14:00", "9:30") or empty, as the editor's picker writes it.
 */

/** A whole count of portions, 1 to 999,999 (SCRUM-906's bound, the till's kitchen edit's). */
const Count = z
  .number({ invalid_type_error: "a count is a whole number" })
  .int("a count is a whole number")
  .min(1, "a count is 1 or more")
  .max(999_999, "a count is at most 999,999");

/** How many cakes, as the editor and the AI fill write it. */
export const CAKE_COUNT_MAX = 99;
const CakeCount = z
  .number({ invalid_type_error: "the cake count is a whole number" })
  .int("the cake count is a whole number")
  .min(1, "the cake count is 1 or more")
  .max(CAKE_COUNT_MAX, `the cake count is at most ${CAKE_COUNT_MAX}`);

/** Whether a value is a cake count the plan may hold. */
export const isCakeCount = (value: unknown): value is number => CakeCount.safeParse(value).success;

/** A clock time as the editor's picker writes it ("14:00"; "9:30" from before), or empty. */
const ClockOrEmpty = z
  .union([z.literal(""), z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "a time is written as HH:mm")], {
    errorMap: () => ({ message: "a time is written as HH:mm, or left empty" }),
  })
  .nullable()
  .optional();

/** A line of the kids' or the adults' food list. Its other keys (id, notes, badge, group, till code) ride as they are. */
export const kitchenPlanLineSchema = z
  .object({
    itemName: z.string({ required_error: "each line has a name", invalid_type_error: "a line's name is text" }).max(500, "a line's name is at most 500 characters"),
    quantity: Count.optional(),
    price: z
      .number({ invalid_type_error: "a price is a number of baht" })
      .finite("a price is a number of baht")
      .min(0, "a price is 0 or more")
      .max(1_000_000, "a price is at most 1,000,000 baht")
      .nullable()
      .optional(),
    notes: z.string({ invalid_type_error: "a line's note is text" }).max(2000).nullable().optional(),
    productCode: z.string({ invalid_type_error: "a till code is text" }).max(64).nullable().optional(),
    source: z.string({ invalid_type_error: "a line's badge is text" }).max(40).nullable().optional(),
    groupId: z.string({ invalid_type_error: "a set-menu group is text" }).max(200).nullable().optional(),
  })
  .passthrough();

const Lines = z.array(kitchenPlanLineSchema, { invalid_type_error: "a food list is a list of lines" }).max(500, "a food list holds at most 500 lines");

/** The plan's `menus`: the two lists, the adults' switch, the service times; the plan's other keys (the cake's price and badge) ride along. */
export const kitchenPlanMenusSchema = z
  .object(
    {
      kids: Lines.optional(),
      adults: Lines.optional(),
      adultsDiffer: z.boolean({ invalid_type_error: "\"Different for adults\" is on or off" }).optional(),
      kidsFoodTime: ClockOrEmpty,
      adultsFoodTime: ClockOrEmpty,
      cakePrice: z.number({ invalid_type_error: "the cake's price is a number of baht" }).finite().min(0).max(100_000_000).nullable().optional(),
      cakeIncluded: z.boolean().nullable().optional(),
    },
    { invalid_type_error: "the menus are an object" },
  )
  .passthrough();

/** What `PUT /api/events/:eventId/beo/kitchen-plan` takes. Keys of anything else are left out. */
export const kitchenPlanPutBodySchema = z.object(
  {
    foodRequired: z.boolean({ invalid_type_error: "\"Kitchen required\" is on or off" }).optional(),
    setMenuEnabled: z.boolean({ invalid_type_error: "the set menu is on or off" }).optional(),
    setMenuTemplateId: z.string().uuid("the set menu is named by its id").nullable().optional(),
    setMenuSelectionSubmittedAt: z.string().max(40).nullable().optional(),
    menus: kitchenPlanMenusSchema.optional(),
    simplifiedMenus: z.object({ kids: Lines.optional(), adults: Lines.optional() }).passthrough().optional(),
    cakeMode: z.enum(["NONE", "INTERNAL", "EXTERNAL"], { errorMap: () => ({ message: "the cake is NONE, INTERNAL or EXTERNAL" }) }).optional(),
    cakeQuantity: CakeCount.optional(),
    cakeTime: ClockOrEmpty,
    cakeNotes: z.string().max(2000).nullable().optional(),
    kitchenNotes: z.string().max(4000).nullable().optional(),
    dietaryNotes: z.string().max(4000).nullable().optional(),
    dietaryTags: z.array(z.string().max(100)).max(50).nullable().optional(),
    serviceSchedule: z.array(z.unknown()).max(100).nullable().optional(),
    kitchenReadyOffsetMinutes: z.number().int().min(-1440).max(1440).optional(),
  },
  { invalid_type_error: "the kitchen plan is an object" },
);
export type KitchenPlanPutBody = z.infer<typeof kitchenPlanPutBodySchema>;

/** The reason a body was refused, in words: where in it, and what is wrong ("menus.kids.0.quantity: a count is 1 or more"). */
export function kitchenPlanBodyRefusal(error: z.ZodError): string {
  const first = error.issues[0];
  const where = first?.path.length ? `${first.path.join(".")}: ` : "";
  return `The kitchen plan was not saved: ${where}${first?.message ?? "the body is not a kitchen plan"}.`;
}
