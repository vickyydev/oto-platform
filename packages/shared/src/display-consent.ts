import { z } from 'zod';

const id = z.string().min(1).max(200);
const requestId = z.string().min(1).max(64);
const guardianName = z.string().trim().max(100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const age = z.number().int().min(0).max(17);
/** SCRUM-764 — what the family types about each child on their own screen. */
const allergiesMedical = z.string().max(500);
const foodRestrictions = z.string().max(200);
/** SCRUM-863 — where the check-in confirmation goes: the family chooses it on the form, beside the number. */
const contactChannel = z.enum(['whatsapp', 'telegram', 'line']);

const promptObject = z.object({
  kind: z.literal('consent'), requestId, visitorId: id,
  slots: z.array(z.object({ id,
    /**
     * SCRUM-764 — the family types each child's name and age on the customer
     * screen, so a slot may be empty until they do: the drop-off and nanny
     * forms are shown from their first step, not once staff have filled them.
     */
    name: z.string().trim().max(100),
    ageYears: age.nullable(),
    requirement: z.enum(['nanny', 'drop_off', 'none']),
    dateOfBirth: isoDate.nullable().optional(),
    allergiesMedical: allergiesMedical.optional(),
    foodRestrictions: foodRestrictions.optional(),
    /**
     * A child from the family's saved profile: their care notes are not put on
     * the public screen (the profile is the record), and the screen says to
     * tell the team if anything has changed.
     */
    saved: z.boolean().optional(),
  })).min(1).max(50),
  guardianName, consentRequired: z.boolean(), consentAcknowledged: z.boolean(),
  confirmations: z.array(z.object({ id, text: z.string().min(1).max(1_000),
    required: z.boolean(), acknowledged: z.boolean() })).max(50),
  /**
   * SCRUM-863 — the parent's number and channel as the till holds them: the
   * ones given on the first screen to begin with. The form shows both for the
   * family to confirm or change, as the prototype's form does. A till that
   * sends the channel is one that takes both back from a filled step; a form
   * published without it (an older till, or a station that does not know the
   * field yet) is shown as before, the number fixed once one was given.
   */
  guardianPhone: z.string().max(32).optional(),
  contactChannel: contactChannel.optional(),
  /** What the drop-off service and a nanny cost, from the till's own drop-off pricing, for the requirement notes. */
  fees: z.object({ nannyHourlyTHB: z.number().nonnegative(), dropOffFeeTHB: z.number().nonnegative() }).optional(),
  staffReady: z.boolean(), canContinue: z.boolean(), completed: z.boolean(),
});

/** Every child named and aged — the form cannot be finished before. */
export function consentSlotsComplete(slots: readonly { name: string; ageYears: number | null }[]): boolean {
  return slots.every(slot => slot.name.trim().length > 0 && slot.ageYears !== null);
}

function validatePrompt(value: z.infer<typeof promptObject>, ctx: z.RefinementCtx): void {
  if (new Set(value.slots.map(slot => slot.id)).size !== value.slots.length
    || new Set(value.confirmations.map(item => item.id)).size !== value.confirmations.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Consent rows must have distinct identities' });
  }
  if (!value.consentRequired && value.slots.some(slot => slot.requirement !== 'none')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consentRequired'], message: 'Supervised children require guardian consent' });
  }
  const ready = value.staffReady && consentSlotsComplete(value.slots)
    && (!value.consentRequired || !!value.guardianName && value.consentAcknowledged)
    && value.confirmations.every(item => !item.required || item.acknowledged);
  if (value.canContinue !== ready || value.completed && !ready) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['canContinue'], message: 'Consent completion requires the current acknowledgements and staff readiness' });
  }
}

/**
 * The drop-off and nanny forms as the customer screen shows them: each child's
 * name, age and care notes as the family fills them in (SCRUM-764), the
 * guardian's name, their number and channel to confirm (SCRUM-863), the
 * consent and the confirmations. The child's photo, the food choice, waivers and every policy
 * decision stay at the till.
 */
export const ConsentPromptSchema = promptObject.superRefine(validatePrompt);
export type ConsentPrompt = z.infer<typeof ConsentPromptSchema>;

const fence = z.object({ requestId, visitorId: id });
const acknowledgedConfirmationIds = z.array(id).max(50).refine(value => new Set(value).size === value.length);
/** SCRUM-764 — one child as the family filled them in. */
const FilledSlotSchema = z.object({
  id, name: z.string().trim().max(100), dateOfBirth: isoDate.nullable(), ageYears: age.nullable(),
  allergiesMedical, foodRestrictions,
}).strict();
export type FilledConsentSlot = z.infer<typeof FilledSlotSchema>;

export const ConsentActionSchema = z.discriminatedUnion('action', [
  fence.extend({ action: z.literal('acknowledge'), guardianName, consentAcknowledged: z.boolean(),
    acknowledgedConfirmationIds }).strict(),
  /**
   * SCRUM-764 — a step of the form, as the family filled it: the children, the
   * guardian's name, their number and channel, and the ticks, which are theirs
   * alone to give. The till takes each step in as it arrives, so reception
   * follows the form and can help with it.
   *
   * SCRUM-863 — the number and the channel travel with every step from a form
   * that shows them (see the prompt above), so what the family confirmed or
   * changed is what the registration keeps. Both stay optional: an older
   * display sends a number only when none was given at the start, and never a
   * channel, and its steps are taken as they always were.
   */
  fence.extend({ action: z.literal('fill'), slots: z.array(FilledSlotSchema).max(50)
    .refine(value => new Set(value.map(slot => slot.id)).size === value.length),
  guardianName, guardianPhone: z.string().trim().max(32).optional(), contactChannel: contactChannel.optional(),
  consentAcknowledged: z.boolean(), acknowledgedConfirmationIds }).strict(),
  fence.extend({ action: z.literal('done') }).strict(),
  fence.extend({ action: z.literal('staff_help') }).strict(),
]);
export type ConsentAction = z.infer<typeof ConsentActionSchema>;

/** Only declared visitor acknowledgements can cross the public handoff. */
export function consentActionAllowed(prompt: ConsentPrompt, action: ConsentAction): boolean {
  if (action.requestId !== prompt.requestId || action.visitorId !== prompt.visitorId || prompt.completed) return false;
  if (action.action === 'done') return prompt.canContinue;
  if (action.action === 'acknowledge' || action.action === 'fill') {
    if (action.consentAcknowledged && !action.guardianName.trim() && (action.action === 'fill' || prompt.consentRequired)) {
      return false;
    }
    if (action.action === 'fill' && !action.slots.every(slot => prompt.slots.some(item => item.id === slot.id))) return false;
    return action.acknowledgedConfirmationIds.every(id => prompt.confirmations.some(item => item.id === id));
  }
  return true;
}

export const ConsentAnswerSchema = z.object({ type: z.literal('consent'), actionId: requestId, payload: ConsentActionSchema });
export type ConsentAnswer = z.infer<typeof ConsentAnswerSchema>;
export const ConsentDocumentPromptSchema = promptObject.extend({
  answer: ConsentAnswerSchema.optional(), answeredAt: z.string().datetime().optional(),
}).superRefine(validatePrompt);
