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
/**
 * SCRUM-857 — the three steps of the form on the family's screen, in order:
 * the children, their care, the agreements.
 */
export const CONSENT_FORM_STEPS = ['children', 'care', 'agreements'] as const;
export type ConsentFormStep = (typeof CONSENT_FORM_STEPS)[number];
const formStep = z.enum(CONSENT_FORM_STEPS);

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
    /**
     * SCRUM-857 — the family takes the child's photo on their own screen (the
     * owner's ruling of 8 November). Sent by a till that takes a photo from
     * the display, only for a child the photo is asked for: `needed` until
     * the till holds one, `taken` once it does (from the display or from
     * staff). Absent from an older till's form, and dropped by a station from
     * before this field, so the display then shows the form as it was — the
     * photo is taken at reception — and never sends a photo the station or
     * the till could not take.
     */
    photo: z.enum(['needed', 'taken']).optional(),
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
  /**
   * SCRUM-857 — whether the family has confirmed that this number is the one
   * for the chosen channel (the owner's ruling of 8 November). Sent by a till
   * that asks for it, as `false` until the family ticks it and `true` after;
   * a form that shows it takes the tick back with every step. Absent from an
   * older till's form, and dropped by a station from before this field, so a
   * form without it is shown as it was and asks for nothing. Deliberately NOT
   * part of `canContinue`: that cross-check is older than this field, and a
   * station that does not know it would refuse a form whose `canContinue`
   * waited on it. The tick gates `done` instead (`consentActionAllowed`).
   */
  contactConfirmed: z.boolean().optional(),
  /**
   * SCRUM-857 — the step the family is on, as the till last heard it from
   * their screen (the owner's ruling of 12 November: staff watch the form as
   * it is filled). Sent by a till that follows the family's step: a form that
   * sees it opens on that step (a display that re-paired mid-form comes back
   * where the family was) and sends its step with every `fill`. Absent from an
   * older till's form, and dropped by a station from before this field, so a
   * form without it sends no step and an older station's strict reading of
   * the `fill` is never tripped.
   */
  familyStep: formStep.optional(),
  /**
   * SCRUM-857 — the family's Done moves the sale on by itself (the owner's
   * ruling of 8 November: no staff confirmation once every check passes).
   * `finishing` is sent on the finished form while the till writes the
   * registration and moves to what follows, so the family's screen says so
   * instead of asking them to wait for the team. `notSaved` is sent on the
   * form again when that write was refused or could not be made (a form that
   * changed meanwhile, a child already registered, the connection): the
   * family's screen says the team is checking it with them. Both optional and
   * additive: an older till never sends them, and a station or display from
   * before them reads the form as it always did (the till still moves on).
   */
  finishing: z.boolean().optional(),
  notSaved: z.boolean().optional(),
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
  // SCRUM-857 — a form the till asks the number confirmation on is never
  // finished without it.
  if (value.completed && value.contactConfirmed === false) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contactConfirmed'], message: 'Consent completion requires the messaging number to be confirmed' });
  }
  // SCRUM-857 — only a finished form is being saved, and only an unfinished
  // one says its last Done was not saved.
  if (value.finishing && !value.completed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['finishing'], message: 'Only a finished form can be saving' });
  }
  if (value.notSaved && value.completed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notSaved'], message: 'A form whose Done was not saved is open again' });
  }
}

/**
 * The drop-off and nanny forms as the customer screen shows them: each child's
 * name, age and care notes as the family fills them in (SCRUM-764), the
 * guardian's name, their number and channel to confirm (SCRUM-863), the
 * consent and the confirmations. The child's photo, the food choice, waivers
 * and every policy decision stay at the till.
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
   *
   * SCRUM-857 — `contactConfirmed` travels with every step from a form whose
   * prompt carried it: the family's tick that this number is the one for the
   * chosen channel, cleared on their screen when either changes. Optional
   * for the same reason as the two above.
   */
  fence.extend({ action: z.literal('fill'), slots: z.array(FilledSlotSchema).max(50)
    .refine(value => new Set(value.map(slot => slot.id)).size === value.length),
  guardianName, guardianPhone: z.string().trim().max(32).optional(), contactChannel: contactChannel.optional(),
  contactConfirmed: z.boolean().optional(),
  /**
   * SCRUM-857 — the step the family is on, from a form whose prompt carried
   * `familyStep`; optional for the same reason as the fields above. A `fill`
   * now travels as the family types (debounced), not only when a step is
   * finished, so staff watch the form live; a step change alone sends one.
   */
  step: formStep.optional(),
  consentAcknowledged: z.boolean(), acknowledgedConfirmationIds }).strict(),
  fence.extend({ action: z.literal('done') }).strict(),
  fence.extend({ action: z.literal('staff_help') }).strict(),
  /**
   * SCRUM-857 — the family took a child's photo on their screen: the picture
   * went to the platform first (`POST /display/consent-photos`, the display's
   * own credential, refused unless the form on its station asks for that
   * photo), and this names the stored file for the till to collect. Sent only
   * for a slot whose prompt carries `photo`, so a station or till from
   * before it never receives one.
   */
  fence.extend({ action: z.literal('photo'), slotId: id, fileId: z.string().uuid() }).strict(),
]);
export type ConsentAction = z.infer<typeof ConsentActionSchema>;

/** Only declared visitor acknowledgements can cross the public handoff. */
export function consentActionAllowed(prompt: ConsentPrompt, action: ConsentAction): boolean {
  if (action.requestId !== prompt.requestId || action.visitorId !== prompt.visitorId || prompt.completed) return false;
  // SCRUM-857 — a till that asks the family to confirm their messaging number
  // takes no `done` before they have (`contactConfirmed` is `false` until then).
  if (action.action === 'done') return prompt.canContinue && prompt.contactConfirmed !== false;
  // SCRUM-857 — a photo only for a child whose form asks the display for one.
  if (action.action === 'photo') return prompt.slots.some(slot => slot.id === action.slotId && slot.photo !== undefined);
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

/**
 * SCRUM-857 — THE FAMILY'S PHOTO OF A CHILD, FROM THE PAIRED DISPLAY.
 *
 * The display downscales the picture before it sends it (the longest edge at
 * most `DISPLAY_CONSENT_PHOTO_EDGE` pixels), so a real photo is a few tens of
 * kilobytes; the cap refuses anything that is not one. `id` is minted on the
 * display for each picture taken, so a resend through a dropped connection
 * is the same file and is stored once. The form it belongs to is named by
 * the visitor and the child's slot: the platform takes it only while the
 * form on the display's own station asks for that photo.
 */
export const DISPLAY_CONSENT_PHOTO_EDGE = 720;
export const DISPLAY_CONSENT_PHOTO_MAX_BYTES = 512 * 1024;
export const DISPLAY_CONSENT_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const DisplayConsentPhotoUploadSchema = z.object({
  id: z.string().uuid(),
  visitorId: id,
  slotId: id,
  contentType: z.enum(DISPLAY_CONSENT_PHOTO_TYPES),
  data: z.string().min(4).max(Math.ceil(DISPLAY_CONSENT_PHOTO_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'The photo must be base64'),
}).strict();
export type DisplayConsentPhotoUpload = z.infer<typeof DisplayConsentPhotoUploadSchema>;
