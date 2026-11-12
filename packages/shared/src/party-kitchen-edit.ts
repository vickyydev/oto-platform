import { z } from 'zod';
import { PARTY_PLAN_LINE_QTY_MAX } from './party-settlement';
import { PartyDetailWithSlipsAnswerSchema } from './party-slips';

/**
 * SCRUM-907 — A MANAGER CHANGES A PARTY'S KITCHEN PLAN ON THE TILL, AND THE BEO
 * IS CHANGED (the owner's decision 7 of 12 November: "Let it be edited with
 * right permission of admin or manager and update it in BEO as well").
 *
 * The OTO App owns the kitchen plan. The till's party Edit form fills its
 * kitchen section from the plan it already reads (SCRUM-906) and sends what a
 * manager changed as a short list of changes, each naming the BEO line it
 * touches by the line's own id (`lineId`, which the plan carries):
 *
 *   - `set`     a line's count and note;
 *   - `remove`  a line the BEO lets staff remove from the till (an EXTRA, not a
 *               set-menu dish: a set-menu dish comes back from the template);
 *   - `add`     a food or bar line, picked from the till's own menu (its name
 *               and code) or typed (a name, no code); never a price — where an
 *               EXTRA's price is entered is the owner's open question (SCRUM-949);
 *   - `choose`  a set-menu choice within its group (`choiceGroup`, the group's
 *               name as the plan gives it), on the line that holds it, or on an
 *               open group no line holds yet (`lineId` null);
 *   - `cake`    the cake's time and its note.
 *
 * The platform writes them to the BEO through the OTO App's directory
 * (`POST /api/directory/events/:id/kitchen-plan`, a key the app issued for one
 * park group), reads the party again from the app and answers what the BEO
 * now holds. Nothing of the plan is kept on the platform.
 */

/** The permission, by name: a branch manager's and an administrator's; reception see the plan read-only. */
export const PARTY_KITCHEN_EDIT_PERMISSION = 'pos:party:kitchen_update' as const;

/** What the form says to a role that may not change the plan. */
export const PARTY_KITCHEN_READ_ONLY = 'A manager changes the kitchen plan.';

const LineId = z.string().trim().min(1).max(200);
const Qty = z.number().int().min(1).max(PARTY_PLAN_LINE_QTY_MAX);
const Note = z.string().max(500);
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const PartyKitchenChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), lineId: LineId, qty: Qty.optional(), note: Note.nullable().optional() }).strict(),
  z.object({ op: z.literal('remove'), lineId: LineId }).strict(),
  z.object({
    op: z.literal('add'),
    /** The new line's id, minted by the till: the same change sent twice is one line. */
    id: z.string().uuid(),
    list: z.enum(['food', 'bar']),
    name: z.string().trim().min(1).max(200),
    /** The till item's code when it was picked from the till's menu; null for a typed line. */
    productCode: z.string().trim().min(1).max(64).nullable(),
    qty: Qty,
    note: Note.nullable().optional(),
  }).strict(),
  z.object({
    op: z.literal('choose'),
    choiceGroup: z.string().trim().min(1).max(200),
    /** The line that holds the group's choice now; null for an open group no line holds. */
    lineId: LineId.nullable(),
    option: z.string().trim().min(1).max(200),
  }).strict(),
  // Never a price: where an EXTRA's price is entered is the owner's open question (SCRUM-949).
  z.object({ op: z.literal('cake'), time: Clock.nullable().optional(), note: Note.nullable().optional() }).strict(),
]);
export type PartyKitchenChange = z.infer<typeof PartyKitchenChangeSchema>;

/** `PUT /parties/:id/kitchen-plan` — the changes of one press of Save, under the edit's own id. */
export const PartyKitchenEditBodySchema = z.object({
  branchId: z.string().uuid(),
  /** The edit's id, minted when Save is first pressed and kept for its retries. */
  editId: z.string().uuid(),
  stationId: z.string().uuid().optional(),
  actionId: z.string().min(1).max(200).optional(),
  changes: z.array(PartyKitchenChangeSchema).min(1).max(100),
});
export type PartyKitchenEditBody = z.infer<typeof PartyKitchenEditBodySchema>;

/** The party as the OTO App now holds it, read again after the write, and what came of the edit. */
export const PartyKitchenEditAnswerSchema = PartyDetailWithSlipsAnswerSchema.extend({
  kitchenEdit: z.object({
    id: z.string().uuid(),
    /** The same edit id was written before: nothing was written again. */
    replayed: z.boolean(),
  }),
});
export type PartyKitchenEditAnswer = z.infer<typeof PartyKitchenEditAnswerSchema>;

/** One set-menu choice group as the BEO's template names it. */
export const PartyKitchenChoiceGroupSchema = z.object({
  /** The group's name, as the plan's `choiceGroup` gives it. */
  label: z.string(),
  options: z.array(z.string()),
  allowMultiple: z.boolean(),
});
export type PartyKitchenChoiceGroup = z.infer<typeof PartyKitchenChoiceGroupSchema>;

/**
 * `GET /parties/:id/kitchen-plan/choices` — the set menu's choice groups and
 * their options, from the OTO App: "ok", or "unavailable" with why (the app
 * not answering, not configured), and then no groups, so the form offers no
 * choice it cannot check.
 */
export const PartyKitchenChoicesAnswerSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  message: z.string().nullable(),
  groups: z.array(PartyKitchenChoiceGroupSchema),
});
export type PartyKitchenChoicesAnswer = z.infer<typeof PartyKitchenChoicesAnswerSchema>;

export const PartyKitchenChoicesQuerySchema = z.object({ branchId: z.string().uuid() });
