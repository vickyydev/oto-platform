import { z } from 'zod';

const id = z.string().min(1).max(200);
const requestId = z.string().min(1).max(64);
const name = z.string().trim().max(100);
const birthDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid date of birth');
const age = z.number().int().min(0).max(120);
const childAge = z.number().int().min(0).max(17);

/**
 * SCRUM-1014 — the oldest age the paired display offers for a child: the
 * till's own picker's (`MAX_CHILD_AGE` in the till's `lib/childDob.ts`, the
 * prototype's). A new child the family adds on the display is never older.
 */
export const DISPLAY_CHILD_MAX_AGE = 12;
const newChildAge = z.number().int().min(0).max(DISPLAY_CHILD_MAX_AGE);

/** A strict whole-years age against the staff-selected visit date, never host time. */
export function childReviewAge(dateOfBirth: string, referenceDate: string): number | null {
  if (!birthDate.safeParse(dateOfBirth).success || !birthDate.safeParse(referenceDate).success
    || dateOfBirth > referenceDate) return null;
  const years = Number(referenceDate.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  return years - (referenceDate.slice(5) < dateOfBirth.slice(5) ? 1 : 0);
}

const promptObject = z.object({
  kind: z.literal('child_review'), requestId, visitorId: id, referenceDate: birthDate,
  slots: z.array(z.object({ id, savedChildId: id.nullable(), name,
    dateOfBirth: birthDate.nullable(), ageYears: age.nullable(), confirmed: z.boolean() })).min(1).max(50),
  choices: z.array(z.object({ id, name: name.min(1), dateOfBirth: birthDate.nullable(), ageYears: age.nullable() })).max(100),
  save: z.object({ status: z.enum(['idle', 'saving', 'failed']), slotId: id.nullable(), actionId: requestId.nullable() }),
  canContinue: z.boolean(),
});

type PromptSlot = z.infer<typeof promptObject>['slots'][number];

/**
 * SCRUM-1014 — a place the family may go on from: a saved child they
 * confirmed, or a new child (no saved record) with a name and an age, as the
 * prototype's review lets them continue (`reviewCanContinue`).
 */
export function childReviewSlotReady(slot: Pick<PromptSlot, 'savedChildId' | 'name' | 'ageYears' | 'confirmed'>): boolean {
  return slot.savedChildId ? slot.confirmed : slot.name.trim().length > 0 && slot.ageYears !== null;
}

function validatePrompt(value: z.infer<typeof promptObject>, ctx: z.RefinementCtx): void {
  const slotIds = new Set(value.slots.map(slot => slot.id));
  const choiceIds = new Set(value.choices.map(choice => choice.id));
  const assigned = value.slots.flatMap(slot => slot.savedChildId ? [slot.savedChildId] : []);
  const issue = (path: string[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (slotIds.size !== value.slots.length || choiceIds.size !== value.choices.length
    || new Set(assigned).size !== assigned.length || assigned.some(choice => !choiceIds.has(choice))) {
    issue(['slots'], 'The child review assignments are not valid');
  }
  if (value.slots.some(slot => slot.confirmed && (!slot.savedChildId || !slot.name
    || slot.ageYears === null || slot.ageYears > 17
    || slot.dateOfBirth !== null && childReviewAge(slot.dateOfBirth, value.referenceDate) !== slot.ageYears))) {
    issue(['slots'], 'Confirmed child details must be complete');
  }
  if (value.save.status === 'idle' ? value.save.slotId !== null || value.save.actionId !== null
    : !value.save.slotId || !slotIds.has(value.save.slotId) || !value.save.actionId) {
    issue(['save'], 'The child save status is not valid');
  }
  if (value.canContinue !== (value.save.status === 'idle' && value.slots.every(childReviewSlotReady))) {
    issue(['canContinue'], 'Continue requires every child to be confirmed');
  }
}

/** Public review only; never a full child, supervision or registration record. */
export const ChildReviewPromptSchema = promptObject.superRefine(validatePrompt);
export type ChildReviewPrompt = z.infer<typeof ChildReviewPromptSchema>;

const fence = z.object({ requestId, visitorId: id });
export const ChildReviewActionSchema = z.discriminatedUnion('action', [
  fence.extend({ action: z.literal('select'), slotId: id, choiceId: id.nullable() }).strict(),
  fence.extend({ action: z.literal('confirm'), slotId: id, savedChildId: id, name: name.min(1), dateOfBirth: birthDate.nullable(), ageYears: childAge }).strict(),
  fence.extend({ action: z.literal('done') }).strict(),
  fence.extend({ action: z.literal('back') }).strict(),
  fence.extend({ action: z.literal('retry'), slotId: id, retryActionId: requestId }).strict(),
  fence.extend({ action: z.literal('staff_help') }).strict(),
  /**
   * SCRUM-1014 — the family's own changes to who is saved, as the prototype's
   * review makes them (`SavedChildrenReview.tsx`). `select` with no choice
   * already says "+ A new child": the place is emptied for a new child.
   * `remove` is "Remove from saved": the saved child comes off the family's
   * record (archived, never deleted) and the place is emptied the same way.
   * `new_child` is the name and age the family types into an empty place,
   * sent as they type it; the till holds it as a new child and saves it to
   * the family's record with the rest of the visit's children.
   */
  fence.extend({ action: z.literal('remove'), slotId: id, savedChildId: id }).strict(),
  fence.extend({ action: z.literal('new_child'), slotId: id, name: name.min(1), dateOfBirth: birthDate.nullable(), ageYears: newChildAge }).strict(),
]);
export type ChildReviewAction = z.infer<typeof ChildReviewActionSchema>;

export const ChildReviewAnswerSchema = z.object({
  type: z.literal('child_review'), actionId: requestId, payload: ChildReviewActionSchema,
});
export type ChildReviewAnswer = z.infer<typeof ChildReviewAnswerSchema>;

/** The box adds a typed answer; publishers cannot supply one themselves. */
export const ChildReviewDocumentPromptSchema = promptObject.extend({
  answer: ChildReviewAnswerSchema.optional(), answeredAt: z.string().datetime().optional(),
}).superRefine(validatePrompt);
export type ChildReviewDocumentPrompt = z.infer<typeof ChildReviewDocumentPromptSchema>;
