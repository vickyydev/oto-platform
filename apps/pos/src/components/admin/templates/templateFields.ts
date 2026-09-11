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

// The shape the preview renders. A normalized superset; the preview only shows
// the parts a template's type + toggles enable.
export interface TemplatePreviewData {
  title: string; // logo/header replacement when no logo, e.g. ticket title
  orderRef: string;
  time: string;
  holderName: string;
  duration: string;
  qrSeed: string;
  allergy: string;
  orderNote: string;
  lines: { id: string; qty: number; name: string; price?: number; note?: string }[];
  // Receipt money rows
  subtotal: number;
  service: number;
  tax: number;
  total: number;
  creditGrants: string[];
  // Bracelet extended fields
  startEndTime?: string; // e.g. "10:00 – 11:00"
  partyName?: string; // party guest's party name
  dietaryRequirement?: string; // food restriction note
  supervisionMode?: 'DROP-OFF' | 'NANNY'; // badge type; absent for accompanied
  assignedNannyName?: string; // nanny name when supervisionMode === 'NANNY'
}

// Extra data fields for the credit-voucher preview.
export interface CreditVoucherPreviewData {
  creditBalanceTHB: number;
  qrSeed: string;
}

// Realistic sample data per type for the admin live preview.
export function sampleDataFor(type: PrintTemplateType): TemplatePreviewData {
  if (type === 'credit_voucher') {
    return {
      title: 'Credit Voucher',
      orderRef: 'S-10428',
      time: '14:32',
      holderName: 'Mama Som',
      duration: '',
      qrSeed: 'QR-wb-sample-1',
      allergy: '',
      orderNote: '',
      lines: [],
      subtotal: 0,
      service: 0,
      tax: 0,
      total: 0,
      creditGrants: [],
      // Voucher-specific fields reuse existing shape:
      // creditBalanceTHB is communicated via `total` for sample display
    };
  }
  if (type === 'receipt') {
    return {
      title: 'Receipt',
      orderRef: 'S-10428',
      time: '14:32',
      holderName: '',
      duration: '',
      qrSeed: 'S-10428',
      allergy: '',
      orderNote: '',
      lines: [
        { id: 'l1', qty: 2, name: '2hr Play — Child', price: 700 },
        { id: 'l2', qty: 1, name: 'Adult Pass', price: 150 },
        { id: 'l3', qty: 2, name: 'Grip Socks', price: 120 },
      ],
      subtotal: 970,
      service: 0,
      tax: 63.46,
      total: 970,
      creditGrants: ['฿100 credit', '2× Grip socks to collect'],
    };
  }
  if (type === 'kids_wristband') {
    return {
      title: 'Kids Wristband',
      orderRef: 'S-10428',
      time: '14:32',
      holderName: 'Mali (age 5)',
      duration: '2 hours · valid until 16:32',
      qrSeed: 'band-mali-10428',
      allergy: 'Peanuts, shellfish',
      orderNote: '',
      lines: [],
      subtotal: 0,
      service: 0,
      tax: 0,
      total: 0,
      creditGrants: [],
      startEndTime: '10:00 – 12:00',
      partyName: "Ploy's Birthday Party",
      dietaryRequirement: 'Gluten-free',
      supervisionMode: 'NANNY',
      assignedNannyName: 'Nanny Fon',
    };
  }
  if (type === 'adult_wristband') {
    return {
      title: 'Adult Wristband',
      orderRef: 'S-10428',
      time: '14:32',
      holderName: 'Accompanying adult',
      duration: '2 hours · valid until 16:32',
      qrSeed: 'band-adult-10428',
      allergy: '',
      orderNote: '',
      lines: [],
      subtotal: 0,
      service: 0,
      tax: 0,
      total: 0,
      creditGrants: [],
      startEndTime: '10:00 – 12:00',
      partyName: "Ploy's Birthday Party",
      dietaryRequirement: 'Vegan',
    };
  }
  // kitchen / bar
  const isBar = type === 'bar_ticket';
  return {
    title: isBar ? 'Bar Ticket' : 'Kitchen Ticket',
    orderRef: 'F-2207',
    time: '14:41',
    holderName: 'Mali (Band 3)',
    duration: '',
    qrSeed: 'F-2207',
    allergy: 'Peanuts, shellfish',
    orderNote: 'Bring everything out together, please.',
    lines: isBar
      ? [
          { id: 'b1', qty: 2, name: 'Thai Iced Tea', note: 'Less sweet' },
          { id: 'b2', qty: 1, name: 'Fresh Coconut' },
        ]
      : [
          { id: 'k1', qty: 1, name: 'Chicken Nuggets', note: 'No dip' },
          { id: 'k2', qty: 1, name: 'Margherita Pizza' },
        ],
    subtotal: 0,
    service: 0,
    tax: 0,
    total: 0,
    creditGrants: [],
  };
}
