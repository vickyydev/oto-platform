import {
  Receipt,
  Baby,
  User,
  ChefHat,
  Wine,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import type { PrintTemplate, PrintTemplateType } from '@/types';

// A toggleable content section on a printout.
export type TemplateFieldKey = keyof PrintTemplate['fields'];

// Human labels + helper text for every field toggle.
export const FIELD_META: Record<
  TemplateFieldKey,
  { label: string; hint: string }
> = {
  itemizedLines: {
    label: 'Itemized lines',
    hint: 'List each item with quantity and price.',
  },
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
  qr: { label: 'Barcode', hint: 'Scannable barcode for entry / re-entry.' },
  allergyLine: {
    label: 'Allergy alert',
    hint: 'Prominent allergy / medical warning.',
  },
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
    hint: 'Show the assigned nanny\'s name (nanny-service children only).',
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

// Which field toggles are meaningful for each printout type (drives the editor
// AND which sections the preview considers). Only these are shown per type.
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
  kitchen_ticket: [
    'orderRefTime',
    'holderName',
    'allergyLine',
    'itemizedLines',
    'orderNotes',
  ],
  bar_ticket: [
    'orderRefTime',
    'holderName',
    'allergyLine',
    'itemizedLines',
    'orderNotes',
  ],
};

// Per-type display metadata for the templates list.
export const TEMPLATE_TYPE_META: Record<
  PrintTemplateType,
  { label: string; icon: LucideIcon; blurb: string }
> = {
  receipt: {
    label: 'Receipt',
    icon: Receipt,
    blurb: 'Customer receipt printed at checkout.',
  },
  kids_wristband: {
    label: 'Kids wristband',
    icon: Baby,
    blurb: 'Child entry band with barcode and allergy alert.',
  },
  adult_wristband: {
    label: 'Adult wristband',
    icon: User,
    blurb: 'Accompanying adult entry band.',
  },
  kitchen_ticket: {
    label: 'Kitchen ticket',
    icon: ChefHat,
    blurb: 'Food prep ticket routed to the kitchen.',
  },
  bar_ticket: {
    label: 'Bar ticket',
    icon: Wine,
    blurb: 'Drinks prep ticket routed to the bar.',
  },
  credit_voucher: {
    label: 'Credit voucher',
    icon: Ticket,
    blurb: 'Printed alongside the bracelet when credit is granted; QR resolves the same wallet.',
  },
};

/**
 * There is deliberately no sample printout content in this file.
 *
 * The editor's preview is a PNG the platform renders with `@oto/print`, which
 * uses that package's own committed fixtures as its sample — the same content
 * the Test print button puts on paper. A second set here, of the kind this
 * file used to hold, is how the preview and the paper stopped agreeing:
 * `packages/print/test/single-renderer.test.ts` now scans for one.
 */
