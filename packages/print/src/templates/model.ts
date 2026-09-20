/**
 * The print-template model, ported from the prototype rather than invented.
 *
 * Sources, all under `imports/oto-pos/artifacts/oto-till/src/`:
 *   `types.ts:373-411`                     PrintTemplateType and PrintTemplate
 *   `components/admin/templates/templateFields.ts:16-123`  labels, hints, applicability
 *   `components/admin/templates/TemplatesPanel.tsx:10-17`  the list order
 *   `store/catalogStore.ts:729-784`        the six seeded templates
 *   `store/catalogStore.ts:900`            a new branch gets none
 *   `store/catalogStore.ts:1159-1160`      lookup is by type, first match wins
 *
 * Three behaviours here are defined by the prototype's code rather than its
 * data, and all three are load-bearing:
 *
 *  1. **One active template per type per branch.** `getPrintTemplate` takes the
 *     *first* template matching a type even though the panel is a list and
 *     templates carry ids. Whether the table is unique on (branch, type) or
 *     allows several with one marked active is a schema decision S2-06 still
 *     has to make; this package behaves the way the prototype does.
 *  2. **A missing template means print everything.** Every consumer defaults to
 *     true when no template exists, and a new branch starts with none at all.
 *     The safe fallback is "print it", never "print nothing".
 *  3. **A field renders only if it is both applicable to the type and on.** A
 *     stale `true` on an inapplicable field is inert.
 */

export type PrintTemplateType =
  | 'receipt'
  | 'kids_wristband'
  | 'adult_wristband'
  | 'kitchen_ticket'
  | 'bar_ticket'
  | 'credit_voucher';

export interface PrintTemplate {
  id: string;
  type: PrintTemplateType;
  name: string;
  showLogo: boolean;
  /** e.g. branch name / tagline */
  headerText?: string;
  /** e.g. "Thank you · Tax ID 0105..." */
  footerText?: string;
  fields: PrintTemplateFields;
}

export interface PrintTemplateFields {
  itemizedLines?: boolean;
  taxServiceBreakdown?: boolean;
  voucherInfo?: boolean;
  holderName?: boolean;
  durationTime?: boolean;
  qr?: boolean;
  allergyLine?: boolean;
  orderNotes?: boolean;
  orderRefTime?: boolean;
  startEndTime?: boolean;
  partyName?: boolean;
  dietaryRequirement?: boolean;
  supervisionBadge?: boolean;
  assignedNannyName?: boolean;
  creditVoucherBalance?: boolean;
  creditVoucherQr?: boolean;
}

export type TemplateFieldKey = keyof PrintTemplateFields;

/** Editor labels and hints, verbatim from `templateFields.ts:16-81`. */
export const FIELD_META: Record<TemplateFieldKey, { label: string; hint: string }> = {
  itemizedLines: { label: 'Itemized lines', hint: 'List each item with quantity and price.' },
  taxServiceBreakdown: {
    label: 'Tax & service breakdown',
    hint: 'Subtotal, service charge, tax and total from the tax engine.',
  },
  voucherInfo: {
    label: 'Credit grants issued',
    hint: 'Summarize credit grants and item entitlements issued by this sale.',
  },
  holderName: {
    label: 'Holder name',
    hint: 'Print the child / guest name on the band or ticket.',
  },
  durationTime: {
    label: 'Play duration / valid-until',
    hint: 'Show how long the band is valid.',
  },
  // The label really is "Barcode", not "QR". S2-11 changes the band's mark to a
  // QR plus a short human-readable line because the signed band code does not
  // fit a 1D strip, so this visible label changes meaning — which is a design
  // change the owner has to see, and the plan routes it to CP3.
  qr: { label: 'Barcode', hint: 'Scannable barcode for entry / re-entry.' },
  allergyLine: { label: 'Allergy alert', hint: 'Prominent allergy / medical warning.' },
  startEndTime: {
    label: 'Start–end time',
    hint: 'Play window printed on the band, e.g. "10:00 – 11:00".',
  },
  partyName: {
    label: 'Party name',
    hint: 'Show the party name when the holder is a party guest.',
  },
  dietaryRequirement: {
    label: 'Dietary requirement',
    hint: 'Food restriction note (separate from the allergy alert).',
  },
  supervisionBadge: {
    label: 'Supervision badge',
    hint: 'Prominent DROP-OFF or NANNY marker for unaccompanied children.',
  },
  assignedNannyName: {
    label: 'Assigned nanny name',
    hint: "Show the assigned nanny's name (nanny-service children only).",
  },
  orderNotes: {
    label: 'Item & order notes',
    hint: 'Free-text prep notes for the kitchen / bar.',
  },
  orderRefTime: {
    label: 'Order ref & time',
    hint: 'Order number and timestamp at the top of the ticket.',
  },
  creditVoucherBalance: {
    label: 'Credit balance',
    hint: 'Show the credit amount loaded onto this voucher.',
  },
  creditVoucherQr: {
    label: 'QR code',
    hint: 'Scannable QR — staff or guest can scan this at the F&B station instead of the wristband.',
  },
};

/**
 * Which toggles are meaningful per type, in the order they appear on the
 * printout (`templateFields.ts:85-123`, `TemplateEditor.tsx:27,106-114`).
 *
 * `adult_wristband` has no `allergyLine`. That is the model, not an oversight.
 */
export const APPLICABLE_FIELDS: Record<PrintTemplateType, TemplateFieldKey[]> = {
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

/** Admin list order, from `TemplatesPanel.tsx:10-17`. */
export const TEMPLATE_TYPE_ORDER: PrintTemplateType[] = [
  'receipt',
  'kids_wristband',
  'adult_wristband',
  'kitchen_ticket',
  'bar_ticket',
  'credit_voucher',
];

/**
 * The nine physical outputs the print pipeline produces.
 *
 * Note that this is *not* `PrintTemplateType`: the prototype has six editable
 * template types and the pipeline produces nine printouts.
 *
 *  - `item_voucher` borrows the `credit_voucher` template and honours only its
 *    `creditVoucherQr` toggle (`printRouting.tsx:125-141`), so today it cannot
 *    have its own header, footer or fields.
 *  - `booth_voucher` has no template at all — the booth is a lifted app and its
 *    content is fixed by DEVICE_INVENTORY §7.
 *  - `test_page` has no template and deliberately never will: its job is to
 *    prove the renderer, and an editable test page can be edited into passing.
 *
 * Giving the first two real template types is a recommendation for S2-06, not
 * something this package decides on its own.
 */
export type PrintKind =
  | 'receipt'
  | 'kitchen_ticket'
  | 'bar_ticket'
  | 'kids_wristband'
  | 'adult_wristband'
  | 'credit_voucher'
  | 'item_voucher'
  | 'booth_voucher'
  | 'test_page';

/** Which editable template a printout reads, where there is one. */
export const TEMPLATE_FOR_KIND: Record<PrintKind, PrintTemplateType | undefined> = {
  receipt: 'receipt',
  kitchen_ticket: 'kitchen_ticket',
  bar_ticket: 'bar_ticket',
  kids_wristband: 'kids_wristband',
  adult_wristband: 'adult_wristband',
  credit_voucher: 'credit_voucher',
  // printRouting.tsx:127-128 — the item voucher reads the credit_voucher
  // template and honours only creditVoucherQr.
  item_voucher: 'credit_voucher',
  booth_voucher: undefined,
  test_page: undefined,
};

/**
 * Lookup by type, first match wins — `catalogStore.ts:1159-1160`.
 * Keeping the prototype's semantics means the same surprise, not a new one.
 */
export function resolveTemplate(
  templates: readonly PrintTemplate[],
  type: PrintTemplateType,
): PrintTemplate | undefined {
  return templates.find((t) => t.type === type);
}

/**
 * Is a field on? Applicable to the type **and** toggled on
 * (`PrintTemplatePreview.tsx:27-29`), with no template meaning everything is on
 * (`printRouting.tsx:91-92`, `:192-193`, `:326-327`).
 */
export function fieldOn(
  template: PrintTemplate | undefined,
  type: PrintTemplateType,
  key: TemplateFieldKey,
): boolean {
  if (!APPLICABLE_FIELDS[type].includes(key)) return false;
  if (!template) return true;
  return !!template.fields[key];
}

/**
 * The six seeded templates, from `catalogStore.ts:729-784`.
 *
 * Two values in here look like mistakes and are not: `tpl-adult-wristband` has
 * `holderName: false`, and the adult band has no allergy field to set.
 */
export const seedPrintTemplates: PrintTemplate[] = [
  {
    id: 'tpl-receipt',
    type: 'receipt',
    name: 'Standard receipt',
    showLogo: true,
    headerText: 'Oto Play Park',
    footerText: 'Thank you for visiting! · Tax ID 0105500000000',
    fields: { itemizedLines: true, taxServiceBreakdown: true, voucherInfo: true },
  },
  {
    id: 'tpl-kids-wristband',
    type: 'kids_wristband',
    name: 'Kids wristband',
    showLogo: false,
    fields: {
      holderName: true,
      durationTime: true,
      qr: true,
      allergyLine: true,
      startEndTime: true,
      partyName: true,
      dietaryRequirement: true,
      supervisionBadge: true,
      assignedNannyName: true,
    },
  },
  {
    id: 'tpl-adult-wristband',
    type: 'adult_wristband',
    name: 'Adult wristband',
    showLogo: false,
    fields: {
      holderName: false,
      durationTime: true,
      qr: true,
      startEndTime: true,
      partyName: true,
      dietaryRequirement: true,
      supervisionBadge: true,
      assignedNannyName: true,
    },
  },
  {
    id: 'tpl-kitchen',
    type: 'kitchen_ticket',
    name: 'Kitchen ticket',
    showLogo: false,
    fields: {
      itemizedLines: true,
      allergyLine: true,
      orderNotes: true,
      orderRefTime: true,
      holderName: true,
    },
  },
  {
    id: 'tpl-bar',
    type: 'bar_ticket',
    name: 'Bar ticket',
    showLogo: false,
    fields: {
      itemizedLines: true,
      allergyLine: true,
      orderNotes: true,
      orderRefTime: true,
      holderName: true,
    },
  },
  {
    id: 'tpl-credit-voucher',
    type: 'credit_voucher',
    name: 'Credit voucher',
    showLogo: true,
    headerText: 'Oto Play Park',
    footerText: 'Scan QR or wristband at the F&B or merch counter to spend.',
    fields: { creditVoucherBalance: true, creditVoucherQr: true },
  },
];
