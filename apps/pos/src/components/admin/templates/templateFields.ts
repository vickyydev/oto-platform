import {
  Receipt,
  Baby,
  User,
  ChefHat,
  Wine,
  Ticket,
  ListOrdered,
  Percent,
  Gift,
  UserRound,
  Hourglass,
  QrCode,
  TriangleAlert,
  Clock,
  PartyPopper,
  Salad,
  BadgeCheck,
  HeartHandshake,
  StickyNote,
  Hash,
  Wallet,
  PanelTop,
  Rows3,
  PanelBottom,
  IdCard,
  ShieldCheck,
  ScanLine,
  Stamp,
  Heading,
  TextQuote,
  type LucideIcon,
} from 'lucide-react';
import type { PrintTemplate, PrintTemplateType } from '@/types';

// A toggleable content section on a printout.
export type TemplateFieldKey = keyof PrintTemplate['fields'];

// Human labels + helper text for every field toggle, and the icon its row in
// the editor carries (SCRUM-472).
export const FIELD_META: Record<
  TemplateFieldKey,
  { label: string; hint: string; icon: LucideIcon }
> = {
  itemizedLines: {
    label: 'Itemized lines',
    hint: 'List each item with quantity and price.',
    icon: ListOrdered,
  },
  taxServiceBreakdown: {
    label: 'Tax & service breakdown',
    hint: 'Subtotal, service charge, tax and total from the tax engine.',
    icon: Percent,
  },
  voucherInfo: {
    label: 'Credit grants issued',
    hint: 'Summarize credit grants and item entitlements issued by this sale.',
    icon: Gift,
  },
  holderName: {
    label: 'Holder name',
    hint: 'Print the child / guest name on the band or ticket.',
    icon: UserRound,
  },
  durationTime: {
    label: 'Play duration / valid-until',
    hint: 'Show how long the band is valid.',
    icon: Hourglass,
  },
  qr: { label: 'Barcode', hint: 'Scannable barcode for entry / re-entry.', icon: QrCode },
  allergyLine: {
    label: 'Allergy alert',
    hint: 'Prominent allergy / medical warning.',
    icon: TriangleAlert,
  },
  startEndTime: {
    label: 'Start–end time',
    hint: 'Play window printed on the band, e.g. "10:00 – 11:00".',
    icon: Clock,
  },
  partyName: {
    label: 'Party name',
    hint: 'Show the party name when the holder is a party guest.',
    icon: PartyPopper,
  },
  dietaryRequirement: {
    label: 'Dietary requirement',
    hint: 'Food restriction note (separate from the allergy alert).',
    icon: Salad,
  },
  supervisionBadge: {
    label: 'Supervision badge',
    hint: 'Prominent DROP-OFF or NANNY marker for unaccompanied children.',
    icon: BadgeCheck,
  },
  assignedNannyName: {
    label: 'Assigned nanny name',
    hint: 'Show the assigned nanny\'s name (nanny-service children only).',
    icon: HeartHandshake,
  },
  orderNotes: {
    label: 'Item & order notes',
    hint: 'Free-text prep notes for the kitchen / bar.',
    icon: StickyNote,
  },
  orderRefTime: {
    label: 'Order ref & time',
    hint: 'Order number and timestamp at the top of the ticket.',
    icon: Hash,
  },
  creditVoucherBalance: {
    label: 'Credit balance',
    hint: 'Show the credit amount loaded onto this voucher.',
    icon: Wallet,
  },
  creditVoucherQr: {
    label: 'QR code',
    hint: 'Scannable QR — staff or guest can scan this at the F&B station instead of the wristband.',
    icon: QrCode,
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

// --- The editor's groups (SCRUM-472) ---------------------------------------

/**
 * Wristbands carry pre-printed OTO branding on the physical band, so the logo
 * and header do not apply to them, and the band layout does not print the
 * footer line either (`packages/print/src/templates/band.ts`).
 */
export function isBandType(type: PrintTemplateType): boolean {
  return type === 'kids_wristband' || type === 'adult_wristband';
}

/** One control in a group: a section's eye, the logo's eye, or a line of text. */
export type EditorRow =
  | { kind: 'logo' }
  | { kind: 'text'; which: 'headerText' | 'footerText' }
  | { kind: 'field'; key: TemplateFieldKey };

export interface EditorGroup {
  id: string;
  title: string;
  /** Where on the paper, or what it is for — the group's second line. */
  caption: string;
  icon: LucideIcon;
  rows: EditorRow[];
}

/** The logo and the two text lines, with the icon and words their rows carry. */
export const CHROME_META = {
  logo: { label: 'Logo', hint: 'Print the Oto mark at the top.', icon: Stamp },
  headerText: {
    label: 'Header text',
    hint: 'Printed large under the logo. Leave it empty to print none.',
    icon: Heading,
  },
  footerText: {
    label: 'Footer text',
    hint: 'Printed small under a dashed rule. Leave it empty to print none.',
    icon: TextQuote,
  },
} as const;

/**
 * A band's sections by what they are for, rather than where they sit: the
 * band is read by a person checking who it is, whether anything about the
 * child needs care, and whether it lets them in.
 */
const BAND_PURPOSES: ReadonlyArray<Omit<EditorGroup, 'rows'> & { keys: TemplateFieldKey[] }> = [
  {
    id: 'identity',
    title: 'Identity',
    caption: 'Who wears the band',
    icon: IdCard,
    keys: ['holderName', 'partyName'],
  },
  {
    id: 'safety',
    title: 'Safety',
    caption: 'What staff must know at a glance',
    icon: ShieldCheck,
    keys: ['allergyLine', 'dietaryRequirement', 'supervisionBadge', 'assignedNannyName'],
  },
  {
    id: 'entry',
    title: 'Entry',
    caption: 'When it is valid and how it scans',
    icon: ScanLine,
    keys: ['startEndTime', 'durationTime', 'qr'],
  },
];

/**
 * The editor's controls, grouped the way the paper is laid out: Top (logo,
 * header), Body (the type's sections, in the order they print), Bottom
 * (footer). A wristband has no top or bottom of its own, so its sections are
 * grouped by purpose instead. Only the type's applicable sections appear, and
 * a group with nothing in it is left out.
 */
export function editorGroups(type: PrintTemplateType): EditorGroup[] {
  const applicable = APPLICABLE_FIELDS[type];
  if (isBandType(type)) {
    const placed = new Set<TemplateFieldKey>();
    const groups: EditorGroup[] = BAND_PURPOSES.map(({ keys, ...group }) => {
      const rows = keys.filter((k) => applicable.includes(k));
      rows.forEach((k) => placed.add(k));
      return { ...group, rows: rows.map((key) => ({ kind: 'field' as const, key })) };
    });
    // A section added to a band type later still gets a row, even before
    // somebody decides which purpose it serves.
    const rest = applicable.filter((k) => !placed.has(k));
    if (rest.length > 0) {
      groups.push({
        id: 'other',
        title: 'Other',
        caption: 'Also on the band',
        icon: Rows3,
        rows: rest.map((key) => ({ kind: 'field' as const, key })),
      });
    }
    return groups.filter((g) => g.rows.length > 0);
  }
  return [
    {
      id: 'top',
      title: 'Top',
      caption: 'The head of the paper',
      icon: PanelTop,
      rows: [{ kind: 'logo' }, { kind: 'text', which: 'headerText' }],
    },
    {
      id: 'body',
      title: 'Body',
      caption: 'What this printout says, in print order',
      icon: Rows3,
      rows: applicable.map((key) => ({ kind: 'field' as const, key })),
    },
    {
      id: 'bottom',
      title: 'Bottom',
      caption: 'The foot of the paper',
      icon: PanelBottom,
      rows: [{ kind: 'text', which: 'footerText' }],
    },
  ].filter((g) => g.rows.length > 0) as EditorGroup[];
}

/**
 * What folds behind the editor's one "More options" row: the template's name,
 * which nobody reads on paper and few people change, and — on a band — the
 * footer line, which the band layout keeps but does not print.
 */
export function moreOptions(type: PrintTemplateType): Array<'name' | 'footerText'> {
  return isBandType(type) ? ['name', 'footerText'] : ['name'];
}

/**
 * There is deliberately no sample printout content in this file.
 *
 * The editor's preview is a PNG the platform renders with `@oto/print`, which
 * uses that package's own samples — the committed fixtures that the Test print
 * button puts on paper, and the named scenarios beside them. A second set here,
 * of the kind this file used to hold, is how the preview and the paper stopped
 * agreeing: `packages/print/test/single-renderer.test.ts` now scans for one.
 */
