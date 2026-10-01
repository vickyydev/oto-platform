import { z } from 'zod';

/**
 * The print contract (S2-06): what can be printed, what a branch may edit
 * about it, and what the record of a print attempt looks like.
 *
 * **Why this vocabulary is here and not only in `@oto/print`.** The renderer
 * package is Node-only — it reads bundled font files with `node:fs` and
 * compresses the preview PNG with `node:zlib` — so no browser bundle can
 * import it. The Console's Print Templates panel nevertheless has to know which
 * toggles apply to which printout in order to draw the editor, and the POS has
 * to know what a job's status means in order to show it. So the vocabulary
 * lives here, where every surface can reach it, and the renderer keeps its own
 * copy in `packages/print/src/templates/model.ts`.
 *
 * **That duplication is a drift risk and nothing in either package prevents
 * it.** The two lists must be compared by a test somewhere both packages are
 * importable, which is `apps/api/test` — `@oto/print` is Node-only and
 * `@oto/shared` is not, and the api depends on both. That test does not exist
 * yet; it is named in the S2-06 report as a required follow-up rather than
 * asserted here as though it did.
 *
 * Everything in this file is ported from the prototype through the renderer's
 * own port, which cites its sources line by line:
 *   `imports/oto-pos/artifacts/oto-till/src/types.ts:373-411`
 *   `.../components/admin/templates/templateFields.ts:16-123`
 *   `.../store/catalogStore.ts:729-784, 900, 1159-1160`
 */

// --- What can be printed -----------------------------------------------------

/**
 * The nine physical outputs the pipeline produces.
 *
 * Deliberately NOT the same list as `PRINT_TEMPLATE_TYPES` below: six of these
 * read an editable template, one borrows another's, and two have none at all.
 */
export const PRINT_KINDS = [
  'receipt',
  'kitchen_ticket',
  'bar_ticket',
  'kids_wristband',
  'adult_wristband',
  'credit_voucher',
  'item_voucher',
  'booth_voucher',
  'test_page',
] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

/** The six printouts a branch can edit the content of. */
export const PRINT_TEMPLATE_TYPES = [
  'receipt',
  'kids_wristband',
  'adult_wristband',
  'kitchen_ticket',
  'bar_ticket',
  'credit_voucher',
] as const;
export type PrintTemplateType = (typeof PRINT_TEMPLATE_TYPES)[number];

/**
 * Which editable template a printout reads, where there is one.
 *
 *  - `item_voucher` borrows the `credit_voucher` template and honours only its
 *    `creditVoucherQr` toggle (`printRouting.tsx:125-141`), so today it cannot
 *    carry its own header, footer or fields.
 *  - `booth_voucher` has no template: the booth is a lifted app and its content
 *    is fixed by `DEVICE_INVENTORY.md` §7.
 *  - `test_page` has none and deliberately never will — its job is to prove the
 *    renderer, and an editable test page can be edited into passing.
 *
 * Whether the first two should get template types of their own is an open
 * decision for the owner, recorded in the S2-06 report.
 */
export const TEMPLATE_FOR_KIND: Record<PrintKind, PrintTemplateType | undefined> = {
  receipt: 'receipt',
  kitchen_ticket: 'kitchen_ticket',
  bar_ticket: 'bar_ticket',
  kids_wristband: 'kids_wristband',
  adult_wristband: 'adult_wristband',
  credit_voucher: 'credit_voucher',
  item_voucher: 'credit_voucher',
  booth_voucher: undefined,
  test_page: undefined,
};

/** Admin list order (`TemplatesPanel.tsx:10-17`). */
export const PRINT_TEMPLATE_TYPE_ORDER: readonly PrintTemplateType[] = [
  'receipt',
  'kids_wristband',
  'adult_wristband',
  'kitchen_ticket',
  'bar_ticket',
  'credit_voucher',
];

// --- What a branch may edit --------------------------------------------------

/** Every toggle the editor knows about (`types.ts:392-411`). */
export const PRINT_TEMPLATE_FIELD_KEYS = [
  'itemizedLines',
  'taxServiceBreakdown',
  'voucherInfo',
  'holderName',
  'durationTime',
  'qr',
  'allergyLine',
  'orderNotes',
  'orderRefTime',
  'startEndTime',
  'partyName',
  'dietaryRequirement',
  'supervisionBadge',
  'assignedNannyName',
  'creditVoucherBalance',
  'creditVoucherQr',
] as const;
export type PrintTemplateFieldKey = (typeof PRINT_TEMPLATE_FIELD_KEYS)[number];

/**
 * Which toggles are meaningful per type, in the order they appear on the
 * printout (`templateFields.ts:85-123`).
 *
 * `adult_wristband` has no `allergyLine`. That is the model, not an oversight.
 */
export const APPLICABLE_FIELDS: Record<PrintTemplateType, readonly PrintTemplateFieldKey[]> = {
  receipt: ['itemizedLines', 'taxServiceBreakdown', 'voucherInfo'],
  credit_voucher: ['creditVoucherBalance', 'creditVoucherQr'],
  kids_wristband: [
    'holderName',
    'startEndTime',
    'durationTime',
    'partyName',
    'dietaryRequirement',
    'allergyLine',
    'supervisionBadge',
    'assignedNannyName',
    'qr',
  ],
  adult_wristband: [
    'holderName',
    'startEndTime',
    'durationTime',
    'partyName',
    'dietaryRequirement',
    'supervisionBadge',
    'assignedNannyName',
    'qr',
  ],
  kitchen_ticket: ['orderRefTime', 'holderName', 'allergyLine', 'itemizedLines', 'orderNotes'],
  bar_ticket: ['orderRefTime', 'holderName', 'allergyLine', 'itemizedLines', 'orderNotes'],
};

/**
 * The stored `fields` document of `pos.print_template`.
 *
 * Every key optional, because that is what the prototype stores and because an
 * absent key and a `false` one are read the same way by `fieldOn`. A toggle
 * left `true` on a type it does not apply to is inert rather than an error —
 * the editor writes the whole document back, and a type can lose a field in a
 * later release without anybody having to clean the rows.
 */
export const PrintTemplateFieldsSchema = z
  .object(
    Object.fromEntries(PRINT_TEMPLATE_FIELD_KEYS.map((k) => [k, z.boolean().optional()])) as {
      [K in PrintTemplateFieldKey]: z.ZodOptional<z.ZodBoolean>;
    },
  )
  .strict();
export type PrintTemplateFields = z.infer<typeof PrintTemplateFieldsSchema>;

/**
 * A template as the Console edits it and the box caches it.
 *
 * `headerText` and `footerText` are printed verbatim, so they are length-capped
 * here rather than at the renderer: an 80 mm receipt is 42-48 characters wide
 * and a thousand-character footer is a paper-out incident, not a design choice.
 */
export const PrintTemplateSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(PRINT_TEMPLATE_TYPES),
  name: z.string().min(1).max(80),
  showLogo: z.boolean(),
  headerText: z.string().max(200).nullish(),
  footerText: z.string().max(400).nullish(),
  fields: PrintTemplateFieldsSchema,
  /** Bumped on every edit; the box's cache and `edge.sync_change.version` compare it. */
  version: z.number().int().min(1),
});
export type PrintTemplate = z.infer<typeof PrintTemplateSchema>;

/** The Console's edit body: the content only. Type and branch come from the route. */
export const PrintTemplateUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  showLogo: z.boolean().optional(),
  headerText: z.string().max(200).nullable().optional(),
  footerText: z.string().max(400).nullable().optional(),
  fields: PrintTemplateFieldsSchema.optional(),
});
export type PrintTemplateUpdate = z.infer<typeof PrintTemplateUpdateSchema>;

/**
 * Is a field on? Applicable to the type **and** toggled on, with no template at
 * all meaning everything applicable is on.
 *
 * The last part is the prototype's behaviour (`printRouting.tsx:91-92`) and it
 * is the safe direction: a branch that has never opened the editor prints a
 * full receipt rather than a blank one.
 */
export function printFieldOn(
  template: Pick<PrintTemplate, 'fields'> | undefined | null,
  type: PrintTemplateType,
  key: PrintTemplateFieldKey,
): boolean {
  if (!APPLICABLE_FIELDS[type].includes(key)) return false;
  if (!template) return true;
  return template.fields[key] === true;
}

// --- The record of a print attempt -------------------------------------------

/**
 * A print job's life, exactly the four states the ticket names.
 *
 * There is no `printing`: a job being sent right now is `queued` with
 * `started_at` set, which keeps "what is still outstanding" a single-value
 * comparison on the column the retry query and the heartbeat's queue depth both
 * read. `skipped` is its own outcome rather than a failure because a station
 * with no printer assigned is a configuration a person chose — the till says
 * "not printed" and carries on, and nothing raises an alert.
 */
export const PRINT_JOB_STATUSES = ['queued', 'printed', 'failed', 'skipped'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/**
 * What a printout is about, when it is about anything.
 *
 * One pair — `subjectType` + `subjectId` — rather than a nullable column per
 * entity, the same shape `edge.sync_change` uses for its feed. It answers
 * "was this receipt printed, and how many times" with one index, and a ticket
 * that prints something new adds a word here rather than a migration.
 *
 * `subjectId` is text, not a uuid, because a band code and a receipt number are
 * not uuids.
 */
export const PRINT_SUBJECT_TYPES = [
  'sale',
  'sale_line',
  'band',
  'voucher',
  'booking',
  'visit',
  'station',
  /** S2-14a — a credit voucher prints one wallet: its QR and its balance. */
  'wallet',
] as const;
export type PrintSubjectType = (typeof PRINT_SUBJECT_TYPES)[number];

/**
 * A job as the box queues it and the cloud records it.
 *
 * **The id is minted on the box**, in the same transaction that queues the job,
 * exactly as an outbox event's id is. That is what makes a re-pushed batch
 * cheap: the cloud inserts on conflict do nothing, and a lost acknowledgement
 * costs one failed insert rather than a duplicate receipt in the record.
 *
 * **There is no rendered document and no device bytes here, by design.** A
 * receipt carries a member's name and what they bought; a kids' band carries a
 * child's name and an allergy line. Keeping the rendered input would put that
 * on a telemetry-shaped table with a retention window and a Console page over
 * it. A reprint re-renders from the sale (S2-11), which is also the only way a
 * reprint can pick up a corrected price.
 */
export const PrintJobSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(PRINT_KINDS),
  status: z.enum(PRINT_JOB_STATUSES),
  stationId: z.string().uuid().nullish(),
  deviceId: z.string().uuid().nullish(),
  /** Which routing role picked the device, so "why did this go to the kitchen" has an answer. */
  role: z.string().nullish(),
  templateId: z.string().uuid().nullish(),
  templateVersion: z.number().int().min(1).nullish(),
  copies: z.number().int().min(1).max(10).default(1),
  subjectType: z.enum(PRINT_SUBJECT_TYPES).nullish(),
  subjectId: z.string().max(120).nullish(),
  attempts: z.number().int().min(0).default(0),
  errorCode: z.string().max(64).nullish(),
  errorMessage: z.string().max(500).nullish(),
  reprintOf: z.string().uuid().nullish(),
  reprintReason: z.string().max(200).nullish(),
  actionId: z.string().max(64).nullish(),
  queuedAt: z.string(),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
});
export type PrintJob = z.infer<typeof PrintJobSchema>;

/**
 * Point a reprint at the ORIGINAL, never at the job it was copied from.
 *
 * A reprint of a reprint of a reprint would otherwise be a linked list that has
 * to be walked to answer "how many copies of this receipt exist", and each link
 * is a row a retention sweep may already have deleted — leaving a chain with a
 * hole in the middle and no way to tell how long it used to be.
 *
 * So the chain is flattened to depth one: `reprint_of` always holds the root,
 * every copy is a sibling, and the count is one indexed query. **The database
 * cannot enforce this** — a CHECK cannot read another row — so it is enforced
 * here, at the one place that decides what a new job's `reprint_of` should be,
 * and the schema claims only what it can keep: that a job is not a reprint of
 * itself.
 */
export function reprintRootOf(source: Pick<PrintJob, 'id' | 'reprintOf'>): string {
  return source.reprintOf ?? source.id;
}

/**
 * How long the print record is kept, in days.
 *
 * A park printing a few hundred receipts a day produces on the order of a
 * hundred thousand rows a year, which is small; the window is not about size.
 * It is about what the row is FOR. Every question asked of it — did this
 * print, why is the queue stuck, reprint the last receipt, which printer eats
 * paper — is asked within days, and the questions asked in a year's time are
 * asked of the sale, the band and the audit row, none of which is swept. Ninety
 * days covers a full quarter-end without keeping a device log for ever.
 *
 * The sweep belongs in `job:housekeeping.retention` in
 * `apps/api/src/services/jobs.ts`, beside `purgeOldSyncEvents`, deleting by
 * `queued_at`; `print_job_queued_idx` exists for that delete as much as for any
 * read. It is not wired yet — S2-06's API work does that.
 */
export const PRINT_JOB_RETENTION_DAYS = 90;

// --- Sale printing (S2-11) ------------------------------------------------------

/**
 * The two prep stations that print, in the order their tickets come out —
 * `PREP_TITLE` and the station list in the prototype's `lib/fnb.ts:204-235`.
 * `none` is a prep station that prints nothing (a bottled drink handed over at
 * the counter) and is not in this list on purpose.
 */
export const PRINTING_PREP_STATIONS = ['kitchen', 'bar'] as const;
export type PrintingPrepStation = (typeof PRINTING_PREP_STATIONS)[number];

/** The ticket title each station prints under (`lib/fnb.ts:204`). */
export const PREP_TICKET_TITLE: Record<PrintingPrepStation, string> = {
  kitchen: 'Kitchen',
  bar: 'Bar',
};

/**
 * One prep ticket per station that has lines — the prototype's
 * `buildPrepTickets` (`lib/fnb.ts:213-235`), ported. A line whose station is
 * `none` does not print; a station with no lines gets no ticket; the kitchen
 * ticket comes before the bar's. A line with no station recorded goes to the
 * kitchen, which is where `resolveItemPrepStations` sends it too.
 */
export function groupPrepTickets<T extends { prepStation?: string | null }>(
  lines: readonly T[],
): { station: PrintingPrepStation; title: string; lines: T[] }[] {
  const byStation: Record<PrintingPrepStation, T[]> = { kitchen: [], bar: [] };
  for (const line of lines) {
    const station = line.prepStation ?? 'kitchen';
    if (station === 'kitchen' || station === 'bar') byStation[station].push(line);
  }
  return PRINTING_PREP_STATIONS.filter((station) => byStation[station].length > 0).map((station) => ({
    station,
    title: PREP_TICKET_TITLE[station],
    lines: byStation[station],
  }));
}

/**
 * What History can ask to print again (`TransactionDetail.tsx:171-197`): the
 * full receipt, the kids' band group, the adults' band group, the F&B pick-up
 * ticket, and a shop sale's receipt — the till names the last one separately,
 * the paper is the same receipt.
 */
export const SALE_REPRINT_KINDS = ['receipt', 'kids_bands', 'adult_bands', 'prep', 'merch_receipt'] as const;
export type SaleReprintKind = (typeof SALE_REPRINT_KINDS)[number];
