import { z } from 'zod';
import { InboxChannelSchema, InboxMessageSchema, InboxTemplateSchema } from './inbox';

/**
 * THE INBOX'S REPLY AND TEMPLATE SHAPES (S2-19 I2f, SCRUM-585; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.3 "POST …/messages", "POST/PATCH
 * /inbox/templates", §3.5 sending).
 *
 * The rules a staff reply is held to, said once so the api and the shell read
 * the same words:
 *
 *   - INSIDE the customer's free-text window (24 hours from their last
 *     message on WhatsApp; `@oto/messaging` `window.ts`) a reply is free text
 *     or a template.
 *   - OUTSIDE it only a template may be sent, and only one that QUALIFIES: an
 *     `approved` template, or one whose channel needs no approval
 *     (`not_required`). A `pending` or `rejected` one does not. The 409 that
 *     refuses free text carries the qualifying templates, so the composer can
 *     offer them without a second request.
 *
 * There are no staff-only notes (`docs/features/inbox.md`): every message a
 * reply writes is one the customer receives.
 *
 * TEMPLATE VARIABLES are `{{name}}` placeholders — letters, digits and
 * underscores, `{{1}}` included, which is WhatsApp's own positional form. A
 * reply names a value for each; the rendered words are what the message
 * stores and what a channel without approvals sends. For an approved
 * WhatsApp template the values travel as its body parameters, in the order
 * the placeholders appear.
 */

/** `inbox.template.key`'s CHECK — the same nine keys as `@oto/db` `INBOX_TEMPLATE_KEYS` (pinned in the reply test). */
export const INBOX_TEMPLATE_KEY_NAMES = [
  'welcome',
  'handover_birthday',
  'handover_events',
  'handover_complaint_online',
  'handover_complaint_onsite',
  'handover_lost_found',
  'handover_marketing',
  'out_of_hours',
  'handover_general',
] as const;
export type InboxTemplateKeyName = (typeof INBOX_TEMPLATE_KEY_NAMES)[number];

export const INBOX_TEMPLATE_APPROVALS = ['not_required', 'pending', 'approved', 'rejected'] as const;
export type InboxTemplateApproval = (typeof INBOX_TEMPLATE_APPROVALS)[number];

/** May this template be sent outside the free-text window? */
export function templateQualifiesOutsideWindow(approvalStatus: InboxTemplateApproval): boolean {
  return approvalStatus === 'approved' || approvalStatus === 'not_required';
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g;
const VARIABLE_NAME = /^[A-Za-z0-9_]{1,40}$/;

/** The variables a template body names, each once, in the order they first appear. */
export function templateVariables(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export interface RenderedTemplate {
  /** The words the customer receives. */
  text: string;
  /** Placeholders with no value given. A reply with any is refused. */
  missing: string[];
  /** One value per placeholder occurrence, in order — WhatsApp's body parameters. */
  parameters: string[];
}

/** Fill a template's placeholders. Values are inserted as given; nothing in them is read as a placeholder. */
export function renderTemplate(body: string, variables: Readonly<Record<string, string>> = {}): RenderedTemplate {
  const missing: string[] = [];
  const parameters: string[] = [];
  const text = body.replace(PLACEHOLDER, (whole, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    parameters.push(value);
    return value;
  });
  return { text, missing, parameters };
}

/**
 * The body parameters of a message rendered from `templateBody`, read back
 * from the stored words — or null when the words no longer match the
 * template (it was edited after the message was queued).
 */
export function templateParameters(templateBody: string, rendered: string): string[] | null {
  const parts = templateBody.split(PLACEHOLDER);
  // split() with one capture group alternates literal, name, literal, …
  let pattern = '^';
  for (let i = 0; i < parts.length; i += 1) {
    pattern += i % 2 === 0 ? parts[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '([\\s\\S]*?)';
  }
  const m = new RegExp(`${pattern}$`).exec(rendered);
  return m ? m.slice(1) : null;
}

const Uuid = z.string().uuid();
const Iso = z.string();

/** `POST /inbox/conversations/{id}/messages`. Exactly one of `text` and `templateId`. */
export const InboxReplyBodySchema = z
  .object({
    /** Caller-named (UUIDv7): a retried send under the same id is the same message, never a second one. */
    id: Uuid.optional(),
    text: z.string().trim().min(1).max(4096).optional(),
    templateId: Uuid.optional(),
    /** A value for each `{{name}}` in the template. */
    variables: z
      .record(z.string().regex(VARIABLE_NAME), z.string().min(1).max(1024))
      .optional(),
  })
  .refine((b) => (b.text === undefined) !== (b.templateId === undefined), {
    message: 'send either text or a template, not both and not neither',
  });
export type InboxReplyBody = z.infer<typeof InboxReplyBodySchema>;

/** Where the thread stands against the free-text window, as the reply saw it. */
export const InboxReplyWindowSchema = z.object({
  /** Free text may be sent now. */
  open: z.boolean(),
  /** The channel's window in hours; null when it has none. */
  hours: z.number().int().nullable(),
  lastCustomerMessageAt: Iso.nullable(),
  /** When the window closes (or closed); null with no window or no customer message. */
  closesAt: Iso.nullable(),
});

/** The answer to a reply: the message as it stands after the first send attempt. */
export const InboxReplySchema = z.object({
  conversationId: Uuid,
  message: InboxMessageSchema,
  /**
   * The refusal word when the channel refused the send: `RATE_LIMITED` and
   * `UNREACHABLE` keep it queued for the send job; any other word marked it
   * failed, and the thread's timeline carries a `send_failed` event.
   */
  refusal: z.string().nullable(),
  window: InboxReplyWindowSchema,
});
export type InboxReply = z.infer<typeof InboxReplySchema>;

/** A template the composer may offer outside the window. */
export const InboxQualifyingTemplateSchema = InboxTemplateSchema.pick({
  id: true,
  key: true,
  language: true,
  channel: true,
  branchId: true,
  body: true,
  approvalStatus: true,
}).extend({ variables: z.array(z.string()) });

/**
 * The 409 a reply can answer. `TEMPLATE_REQUIRED` (free text outside the
 * window) and `TEMPLATE_NOT_APPROVED` (a template that may not open the
 * window) carry `window` and `qualifyingTemplates`; `CONVERSATION_HANDLED`,
 * `CHANNEL_CANNOT_REPLY`, `CHANNEL_NOT_CONNECTED`, `ID_IN_USE` and the
 * idempotency refusals carry no more than a code and a sentence.
 */
export const InboxReplyRefusalSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .object({
        window: InboxReplyWindowSchema.optional(),
        qualifyingTemplates: z.array(InboxQualifyingTemplateSchema).optional(),
      })
      .passthrough()
      .optional(),
  }),
});
export type InboxReplyRefusal = z.infer<typeof InboxReplyRefusalSchema>;

// --- Template management (inbox:template:manage) --------------------------------------------

const Language = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'a language code such as en, th, ru or pt-BR');
const ProviderTemplateName = z
  .string()
  .regex(/^[a-z0-9_]{1,512}$/, 'lower-case letters, digits and underscores, as Meta names a template');

export const InboxTemplateCreateSchema = z.object({
  /** Caller-named; absent, the platform names it. */
  id: Uuid.optional(),
  key: z.enum(INBOX_TEMPLATE_KEY_NAMES),
  language: Language,
  /** Null or absent: every channel. */
  channel: InboxChannelSchema.nullable().optional(),
  /** Null or absent: every branch. */
  branchId: Uuid.nullable().optional(),
  body: z.string().trim().min(1).max(4096),
  providerTemplateName: ProviderTemplateName.nullable().optional(),
  approvalStatus: z.enum(INBOX_TEMPLATE_APPROVALS).optional(),
  active: z.boolean().optional(),
  needsTranslation: z.boolean().optional(),
});
export type InboxTemplateCreate = z.infer<typeof InboxTemplateCreateSchema>;

export const InboxTemplatePatchSchema = InboxTemplateCreateSchema.omit({ id: true, key: true })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'name at least one field to change' });
export type InboxTemplatePatch = z.infer<typeof InboxTemplatePatchSchema>;

export const InboxTemplateManageQuerySchema = z.object({
  key: z.enum(INBOX_TEMPLATE_KEY_NAMES).optional(),
  language: Language.optional(),
  /** Archived rows too. */
  archived: z.enum(['true', 'false']).optional(),
});

export const InboxManagedTemplateSchema = InboxTemplateSchema.extend({
  providerTemplateName: z.string().nullable(),
  active: z.boolean(),
  /** The `{{name}}` placeholders the body names, in order. */
  variables: z.array(z.string()),
  updatedByAccountId: Uuid.nullable(),
  updatedAt: Iso,
  archivedAt: Iso.nullable(),
});
export type InboxManagedTemplate = z.infer<typeof InboxManagedTemplateSchema>;

export const InboxManagedTemplateListSchema = z.object({ templates: z.array(InboxManagedTemplateSchema) });
