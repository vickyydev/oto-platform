import { z } from 'zod';

const id = z.string().min(1).max(200);
const requestId = z.string().min(1).max(64);
const guardianName = z.string().trim().max(100);

const promptObject = z.object({
  kind: z.literal('consent'), requestId, visitorId: id,
  slots: z.array(z.object({ id, name: z.string().trim().min(1).max(100),
    ageYears: z.number().int().min(0).max(17), requirement: z.enum(['nanny', 'drop_off', 'none']) })).min(1).max(50),
  guardianName, consentRequired: z.boolean(), consentAcknowledged: z.boolean(),
  confirmations: z.array(z.object({ id, text: z.string().min(1).max(1_000),
    required: z.boolean(), acknowledged: z.boolean() })).max(50),
  staffReady: z.boolean(), canContinue: z.boolean(), completed: z.boolean(),
});

function validatePrompt(value: z.infer<typeof promptObject>, ctx: z.RefinementCtx): void {
  if (new Set(value.slots.map(slot => slot.id)).size !== value.slots.length
    || new Set(value.confirmations.map(item => item.id)).size !== value.confirmations.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Consent rows must have distinct identities' });
  }
  if (!value.consentRequired && value.slots.some(slot => slot.requirement !== 'none')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consentRequired'], message: 'Supervised children require guardian consent' });
  }
  const ready = value.staffReady && (!value.consentRequired || !!value.guardianName && value.consentAcknowledged)
    && value.confirmations.every(item => !item.required || item.acknowledged);
  if (value.canContinue !== ready || value.completed && !ready) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['canContinue'], message: 'Consent completion requires the current acknowledgements and staff readiness' });
  }
}

/** Guardian acknowledgement only; private child details and policy decisions stay at the till. */
export const ConsentPromptSchema = promptObject.superRefine(validatePrompt);
export type ConsentPrompt = z.infer<typeof ConsentPromptSchema>;

const fence = z.object({ requestId, visitorId: id });
export const ConsentActionSchema = z.discriminatedUnion('action', [
  fence.extend({ action: z.literal('acknowledge'), guardianName, consentAcknowledged: z.boolean(),
    acknowledgedConfirmationIds: z.array(id).max(50).refine(value => new Set(value).size === value.length) }).strict(),
  fence.extend({ action: z.literal('done') }).strict(),
  fence.extend({ action: z.literal('staff_help') }).strict(),
]);
export type ConsentAction = z.infer<typeof ConsentActionSchema>;

/** Only declared visitor acknowledgements can cross the public handoff. */
export function consentActionAllowed(prompt: ConsentPrompt, action: ConsentAction): boolean {
  if (action.requestId !== prompt.requestId || action.visitorId !== prompt.visitorId || prompt.completed) return false;
  if (action.action === 'done') return prompt.canContinue;
  if (action.action === 'acknowledge') {
    return (!prompt.consentRequired || !action.consentAcknowledged || !!action.guardianName.trim())
      && action.acknowledgedConfirmationIds.every(id => prompt.confirmations.some(item => item.id === id));
  }
  return true;
}

export const ConsentAnswerSchema = z.object({ type: z.literal('consent'), actionId: requestId, payload: ConsentActionSchema });
export type ConsentAnswer = z.infer<typeof ConsentAnswerSchema>;
export const ConsentDocumentPromptSchema = promptObject.extend({
  answer: ConsentAnswerSchema.optional(), answeredAt: z.string().datetime().optional(),
}).superRefine(validatePrompt);
