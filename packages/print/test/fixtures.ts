/**
 * The fixture set: nine printouts, four device profiles, one sample of data
 * each.
 *
 * Every fixture carries `สวัสดี OTO Park` and `Привет` somewhere, because those
 * are the two strings S2-06's acceptance criterion names; the test page also
 * carries `欢迎光临`, because PROJECT_CONTEXT §7.3 and the ticket text both name
 * Chinese while the criterion does not.
 *
 * Money strings are exactly what `formatTHB` in `@oto/shared` emits —
 * `฿1,090` whole, `฿1,090.50` otherwise. `money-contract.test.ts` asserts that
 * against the real function so the two cannot drift.
 */

import type { DeviceProfile, PrintJob, PrintTemplate } from '../src/index';
import { escposProfile, seedPrintTemplates, tsplProfile } from '../src/index';

/**
 * Four profiles, chosen so the fixtures pin the cases that actually differ.
 *
 * 576 and 512 because the XP-80 family ships as both and `GS v 0` discards the
 * overflow without an error (D6). 400 and 200 dots of band because §9.1's
 * `SIZE 50 mm,250 mm` is explicitly a placeholder and the note says the park's
 * stock may be 25 x 254 mm — whichever the tape measure says, the fixture
 * already exists.
 */
export const PROFILES: Record<string, DeviceProfile> = {
  escpos576: escposProfile({
    id: 'dev-counter-1',
    label: 'Main counter',
    model: 'Welltech G4 (XP-C260 family)',
    widthDots: 576,
    hasDrawer: true,
  }),
  escpos512: escposProfile({
    id: 'dev-counter-2',
    label: 'Secondary counter',
    model: 'XP-80C',
    widthDots: 512,
  }),
  tspl400: tsplProfile({
    id: 'dev-band-kids',
    label: 'Kids band printer',
    model: '4B-2082A',
    widthDots: 400,
    media: { widthMm: 50, lengthMm: 250, gapMm: 3, sensing: 'gap' },
  }),
  tspl200: tsplProfile({
    id: 'dev-band-adult',
    label: 'Adult band printer',
    model: '4B-2082A',
    widthDots: 200,
    media: { widthMm: 25, lengthMm: 254, gapMm: 3, sensing: 'gap' },
  }),
};

export const TEMPLATES: readonly PrintTemplate[] = seedPrintTemplates;

const THAI_HELLO = 'สวัสดี OTO Park';
const CYRILLIC_HELLO = 'Привет';
/** Nong Mai — a mixed-script line of the kind a member nickname produces. */
const MIXED_NAME = 'Nong Mai · น้องใหม่';

export interface Fixture {
  name: string;
  job: PrintJob;
  profiles: string[];
}

export const FIXTURES: Fixture[] = [
  {
    name: 'receipt',
    profiles: ['escpos576', 'escpos512'],
    job: {
      kind: 'receipt',
      data: {
        title: 'Receipt',
        taxInvoiceLines: [
          'ใบกำกับภาษีอย่างย่อ',
          'Tax ID 0105500000000',
        ],
        receiptNumber: 'HKT1-000428',
        dateTime: '20 Sep 2026 14:32',
        staffName: `Nok · ${CYRILLIC_HELLO}`,
        memberNickname: MIXED_NAME,
        lines: [
          { qty: 2, name: '2hr Play — Child', price: '฿700' },
          { qty: 1, name: 'Adult Pass', price: '฿150' },
          { qty: 2, name: 'Grip Socks', price: '฿120', note: 'Size 24' },
          { qty: 1, name: THAI_HELLO, price: '฿120.50' },
        ],
        subtotal: '฿1,090.50',
        service: '฿0',
        vat: '฿71.32',
        total: '฿1,090.50',
        tenders: [{ label: 'Cash', amount: '฿1,100' }, { label: 'Change', amount: '฿9.50' }],
        bandCodes: ['HKT1-4821', 'HKT1-4822'],
        creditGrants: ['฿100 credit', '2× Grip socks to collect'],
      },
    },
  },
  {
    name: 'kitchen',
    profiles: ['escpos576', 'escpos512'],
    job: {
      kind: 'kitchen_ticket',
      data: {
        title: 'Kitchen',
        orderRef: 'F-2207',
        time: '14:41',
        holderName: `Mali (Band 3) · ${CYRILLIC_HELLO}`,
        allergiesMedical: `Peanuts, shellfish · ${THAI_HELLO}`,
        lines: [
          { qty: 1, name: 'Chicken Nuggets', note: 'No dip' },
          { qty: 1, name: 'Margherita Pizza' },
        ],
        orderNote: 'Bring everything out together, please.',
      },
    },
  },
  {
    name: 'bar',
    profiles: ['escpos576'],
    job: {
      kind: 'bar_ticket',
      data: {
        title: 'Bar',
        orderRef: 'F-2207',
        time: '14:41',
        holderName: `Mali (Band 3) · ${CYRILLIC_HELLO}`,
        allergiesMedical: THAI_HELLO,
        lines: [
          { qty: 2, name: 'Thai Iced Tea', note: 'Less sweet' },
          { qty: 1, name: 'Fresh Coconut' },
        ],
        orderNote: 'Bring everything out together, please.',
      },
    },
  },
  {
    name: 'kids-band',
    profiles: ['tspl400', 'tspl200'],
    job: {
      kind: 'kids_wristband',
      data: {
        holderName: `Mali · ${CYRILLIC_HELLO}`,
        supervisionMode: 'NANNY',
        startEndTime: '10:00 – 12:00',
        duration: '2 hours',
        partyName: "Ploy's Birthday",
        dietaryRequirement: THAI_HELLO,
        assignedNannyName: 'Fon',
        allergy: 'Peanuts, shellfish',
        // A station-prefixed ULID plus an HMAC, the shape D4 specifies.
        bandCode: 'HKT1:01J8Z4M2QR7V9XK3T0B5N6YWEA:9f2c41ab77d0e5',
        shortCode: 'HKT1-4821',
      },
    },
  },
  {
    name: 'adult-band',
    profiles: ['tspl400', 'tspl200'],
    job: {
      kind: 'adult_wristband',
      data: {
        // The seed has holderName off for the adult band, so this must not
        // appear on the printout; the fixture proves the toggle bites.
        holderName: `Guardian · ${CYRILLIC_HELLO}`,
        startEndTime: '10:00 – 12:00',
        duration: '2 hours',
        partyName: "Ploy's Birthday",
        dietaryRequirement: THAI_HELLO,
        // Not applicable to the adult type at all; must not print.
        allergy: 'Peanuts',
        bandCode: 'HKT1:01J8Z4M2QR7V9XK3T0B5N6YWEB:1d77c4a09b3fe2',
        shortCode: 'HKT1-4822',
      },
    },
  },
  {
    name: 'credit-voucher',
    profiles: ['escpos576'],
    job: {
      kind: 'credit_voucher',
      data: {
        balance: '฿150',
        qrCode: 'wb-walkin-S10428-0',
        holderName: MIXED_NAME,
      },
    },
  },
  {
    name: 'item-voucher',
    profiles: ['escpos576'],
    job: {
      kind: 'item_voucher',
      data: {
        label: `Free: Ice Cream Cone · ${THAI_HELLO}`,
        quantity: 2,
        qrCode: 'grant-S10428-item-1',
      },
    },
  },
  {
    /**
     * The booth voucher, on both receipt heads.
     *
     * **576 is an assumption** — the booth printer is in no section of
     * `DEVICE_INVENTORY.md` §2 and nobody has measured it; `templates/booth.ts`
     * carries the reasoning and the failure mode. It is rendered at 512 as well
     * so the narrower head can be looked at without hardware, which is the one
     * thing that is cheap to have ready if the measurement comes back 512.
     *
     * The code is one of the shape D8 settles: two characters of booth prefix
     * and eight from the unambiguous alphabet. §7's `LW-260917-0042` is the
     * sample's own placeholder — the outgoing booth prints nothing, so no
     * printed code exists to be faithful to — and the addendum in
     * `docs/features/booth.md` replaces that scheme with this one.
     */
    name: 'booth-voucher',
    profiles: ['escpos576', 'escpos512'],
    job: {
      kind: 'booth_voucher',
      data: {
        venueLine: 'Oto — Kids Play Park · Central Phuket',
        prizeLine: '150 THB VOUCHER',
        prizeLineThai: 'คูปอง 150 บาท',
        redemptionLine:
          'Show this QR at OTO Reception and get 150 THB off your ticket order.',
        terms: ['Cannot be combined with other offers.', 'ใช้ร่วมกับโปรโมชันอื่นไม่ได้'],
        voucherCode: 'B1RT7KMQ4X',
        issuedAt: '17 Sep 2026 15:04',
        booth: 'Central Phuket · G floor',
        staff: 'Nok (S-014)',
        // Fourteen days, which is what the seeded voucher definitions carry.
        expiresAt: '1 Oct 2026',
        footerLine: `Redeem at Oto Play Park, Central Phuket · ${CYRILLIC_HELLO}`,
      },
    },
  },
  {
    name: 'test-page',
    profiles: ['escpos576', 'escpos512', 'tspl400', 'tspl200'],
    job: {
      kind: 'test_page',
      data: {
        deviceLabel: 'Main counter',
        model: 'Welltech G4 (XP-C260 family)',
        address: '192.168.88.202:9100',
        transport: 'TCP 9100, one session',
        widthDots: 576,
        rendererVersion: 'oto-print/0.1.0',
        fontVersions: ['NotoSans', 'NotoSansThai', 'OtoPrintSC'],
        seededTemplates: seedPrintTemplates.map((t) => t.name),
        sampleCode: 'HKT1-4821',
      },
    },
  },
];
