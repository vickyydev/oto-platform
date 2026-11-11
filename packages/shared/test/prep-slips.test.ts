import { describe, expect, it } from 'vitest';
import {
  PARTY_CANCELLED,
  PARTY_PLAN_CHANGED,
  partyPrepSlips,
  partySlipFingerprint,
  partySlipLinesRemoved,
  prepSlipTargets,
  prepSlipTitle,
  refundPrepSlips,
  type PartySlipDocument,
  type SalePrintSnapshot,
} from '../src/index';

/**
 * SCRUM-861 — what the void and updated slips say, composed from a sale's
 * snapshot and from a party's slips before and after a change.
 */

const line = (id: string, label: string, station: string | null, quantity = 1, note?: string): SalePrintSnapshot['lines'][number] => ({
  id,
  kind: 'fnb_item',
  label,
  quantity,
  grossSatang: 10_000,
  ticket: false,
  payload: { ...(station ? { prepStation: station } : {}), ...(note ? { note } : {}), pickupCode: '42' },
  stayHours: null,
  stayDurationLabel: null,
});

const snapshot = (): SalePrintSnapshot => ({
  saleId: 'sale-1',
  receiptNumber: 'T1-000001',
  at: '2026-11-12T07:30:00.000Z',
  timezone: 'Asia/Bangkok',
  operatorName: 'OTO',
  branchName: 'HKT Central',
  staffName: 'Nok',
  memberNickname: 'Mali',
  lines: [
    line('l1', 'Hot Dog', 'kitchen', 1, 'no onions'),
    line('l2', 'French Fries', null, 2),
    line('l3', 'Fresh Orange Juice', 'bar', 2),
    line('l4', 'Bottled Water', 'none', 1),
  ],
  subtotalSatang: 0,
  grossSatang: 0,
  taxBreakdown: { rows: [] } as never,
  tenders: [],
  bands: [],
  orderChildren: [{ name: 'Nam', allergies: 'Peanuts', medicalNotes: null }],
  note: 'Birthday table',
  discounts: [],
  credits: [],
});

describe("a refund's slips", () => {
  it('the whole sale: a VOID slip per station of its own lines, the holder and allergy line kept, no UPDATED slip', () => {
    const slips = refundPrepSlips({
      snapshot: snapshot(),
      refund: { number: 'T1-R-000003', coveredLineIds: ['l1', 'l2', 'l3', 'l4'], earlierLineIds: [], full: true, byName: 'Som' },
      time: '14:52',
    });
    expect(slips.kitchen.void).toEqual({
      title: 'VOID — Kitchen',
      variant: 'void',
      orderRef: '42',
      time: '14:52',
      holderName: 'Mali',
      allergiesMedical: 'Nam: Peanuts',
      details: ['Voided by Som', 'Refund T1-R-000003'],
      lines: [
        { qty: 1, name: 'Hot Dog', note: 'no onions' },
        { qty: 2, name: 'French Fries', note: undefined },
      ],
      orderNote: 'Birthday table',
    });
    expect(slips.kitchen.updated).toBeNull();
    expect(slips.bar.void?.lines).toEqual([{ qty: 2, name: 'Fresh Orange Juice', note: undefined }]);
    expect(slips.bar.updated).toBeNull();
    expect(prepSlipTargets(slips).map((t) => [t.station, t.variant])).toEqual([
      ['kitchen', 'void'],
      ['bar', 'void'],
    ]);
  });

  it('chosen lines: the station loses them and gets an UPDATED slip of what no refund touched; the other station is silent', () => {
    const slips = refundPrepSlips({
      snapshot: snapshot(),
      refund: { number: 'T1-R-000004', coveredLineIds: ['l1'], earlierLineIds: [], full: false, byName: null },
      time: '14:53',
    });
    expect(slips.kitchen.void?.lines).toEqual([{ qty: 1, name: 'Hot Dog', note: 'no onions' }]);
    expect(slips.kitchen.void?.details).toEqual(['Voided by staff', 'Refund T1-R-000004']);
    expect(slips.kitchen.updated).toMatchObject({
      title: 'UPDATED — Kitchen',
      variant: 'updated',
      details: ['Still to make after refund T1-R-000004', 'Updated by staff'],
      lines: [{ qty: 2, name: 'French Fries' }],
    });
    expect(slips.bar).toEqual({ void: null, updated: null });
    // The next refund takes the fries: the kitchen has nothing left, so no UPDATED slip.
    const next = refundPrepSlips({
      snapshot: snapshot(),
      refund: { number: 'T1-R-000005', coveredLineIds: ['l2'], earlierLineIds: ['l1'], full: false, byName: 'Som' },
      time: '14:54',
    });
    expect(next.kitchen.void?.lines).toEqual([{ qty: 2, name: 'French Fries', note: undefined }]);
    expect(next.kitchen.updated).toBeNull();
  });

  it('a custom amount that leaves the sale open names no line and sends nothing; one that empties it voids what stands', () => {
    const open = refundPrepSlips({
      snapshot: snapshot(),
      refund: { number: 'R1', coveredLineIds: [], earlierLineIds: [], full: false, byName: 'Som' },
      time: '14:55',
    });
    expect(prepSlipTargets(open)).toEqual([]);
    const emptied = refundPrepSlips({
      snapshot: snapshot(),
      refund: { number: 'R2', coveredLineIds: [], earlierLineIds: ['l1'], full: true, byName: 'Som' },
      time: '14:56',
    });
    expect(emptied.kitchen.void?.lines).toEqual([{ qty: 2, name: 'French Fries', note: undefined }]);
    expect(emptied.bar.void?.lines).toEqual([{ qty: 2, name: 'Fresh Orange Juice', note: undefined }]);
  });

  it('the title carries the word for a renderer that predates the band', () => {
    expect(prepSlipTitle('kitchen', 'void')).toBe('VOID — Kitchen');
    expect(prepSlipTitle('bar', 'updated')).toBe('UPDATED — Bar');
  });
});

const partySlip = (lines: PartySlipDocument['lines'], over: Partial<PartySlipDocument> = {}): PartySlipDocument => ({
  title: 'Kitchen',
  heading: 'Birthday party',
  orderRef: "Mali's 6th",
  time: '11:00',
  details: ['Room: Party room 1', 'Children: 10'],
  readyBy: '13:40',
  lines,
  ...over,
});

describe("a party's slips after a change", () => {
  const held = (doc: PartySlipDocument | null) =>
    doc ? { fingerprint: partySlipFingerprint(doc), lines: doc.lines, orderRef: doc.orderRef } : null;

  it('lines removed: a dish gone whole, a count cut by the difference, a dish with no count that vanished; nothing for an addition', () => {
    expect(
      partySlipLinesRemoved(
        [{ qty: 3, name: 'Margherita' }, { qty: 2, name: 'French fries' }, { name: 'Hawaiian' }, { qty: 2, name: 'Fruit skewers' }],
        [{ qty: 1, name: 'Margherita' }, { qty: 2, name: 'french fries' }, { qty: 4, name: 'Fruit skewers' }, { qty: 2, name: 'Pasta' }],
      ),
    ).toEqual([{ qty: 2, name: 'Margherita' }, { name: 'Hawaiian' }]);
  });

  it('the fingerprint reads the lines, survives a jsonb round trip, and leaves the printed time out', () => {
    const a = partySlip([{ qty: 3, name: 'Margherita' }]);
    const b = partySlip([{ qty: 2, name: 'Margherita' }]);
    expect(partySlipFingerprint(a)).not.toBe(partySlipFingerprint(b));
    expect(partySlipFingerprint(JSON.parse(JSON.stringify(a)) as PartySlipDocument)).toBe(partySlipFingerprint(a));
    expect(partySlipFingerprint({ ...a, time: '12:00' })).toBe(partySlipFingerprint(a));
    expect(partySlipFingerprint(null)).toBe('none');
  });

  it('a dish taken off: VOID of it and UPDATED of the whole slip; the other station, unchanged, gets nothing', () => {
    const before = { kitchen: held(partySlip([{ qty: 3, name: 'Margherita' }, { qty: 2, name: 'French fries' }])), bar: held(partySlip([{ qty: 2, name: 'Juice pitcher' }], { title: 'Bar' })) };
    const after = { kitchen: partySlip([{ qty: 3, name: 'Hawaiian' }, { qty: 2, name: 'French fries' }], { time: '11:31' }), bar: partySlip([{ qty: 2, name: 'Juice pitcher' }], { title: 'Bar', time: '11:31' }) };
    const slips = partyPrepSlips({ before, after, cancelled: false, time: '11:31' });
    expect(slips.kitchen.void).toEqual({
      title: 'VOID — Kitchen',
      variant: 'void',
      heading: 'Birthday party',
      orderRef: "Mali's 6th",
      time: '11:31',
      details: [PARTY_PLAN_CHANGED],
      lines: [{ qty: 3, name: 'Margherita' }],
    });
    expect(slips.kitchen.updated).toEqual({
      ...after.kitchen,
      title: 'UPDATED — Kitchen',
      variant: 'updated',
      details: [PARTY_PLAN_CHANGED, 'Room: Party room 1', 'Children: 10'],
    });
    expect(slips.bar).toEqual({ void: null, updated: null });
  });

  it('a drink added is an UPDATED slip alone; a station given nothing before gets its first slip as UPDATED', () => {
    const slips = partyPrepSlips({
      before: { kitchen: null, bar: held(partySlip([{ qty: 2, name: 'Juice pitcher' }], { title: 'Bar' })) },
      after: { kitchen: null, bar: partySlip([{ qty: 2, name: 'Juice pitcher' }, { qty: 4, name: 'Mocktail' }], { title: 'Bar' }) },
      cancelled: false,
      time: '11:32',
    });
    expect(slips.bar.void).toBeNull();
    expect(slips.bar.updated?.lines).toEqual([{ qty: 2, name: 'Juice pitcher' }, { qty: 4, name: 'Mocktail' }]);
    const first = partyPrepSlips({
      before: { kitchen: null, bar: null },
      after: { kitchen: null, bar: partySlip([{ qty: 4, name: 'Mocktail' }], { title: 'Bar' }) },
      cancelled: false,
      time: '11:33',
    });
    expect(first.bar.void).toBeNull();
    expect(first.bar.updated?.title).toBe('UPDATED — Bar');
  });

  it('cancelled: every station holding lines gets a VOID slip of them all, and no UPDATED slip', () => {
    const slips = partyPrepSlips({
      before: { kitchen: held(partySlip([{ qty: 3, name: 'Margherita' }])), bar: null },
      after: { kitchen: partySlip([{ qty: 3, name: 'Margherita' }]), bar: null },
      cancelled: true,
      time: '11:34',
    });
    expect(slips.kitchen.void?.details).toEqual([PARTY_CANCELLED]);
    expect(slips.kitchen.void?.lines).toEqual([{ qty: 3, name: 'Margherita' }]);
    expect(slips.kitchen.updated).toBeNull();
    expect(slips.bar).toEqual({ void: null, updated: null });
  });

  it('nothing changed: nothing at all', () => {
    const doc = partySlip([{ qty: 3, name: 'Margherita' }]);
    const slips = partyPrepSlips({ before: { kitchen: held(doc), bar: null }, after: { kitchen: { ...doc, time: '12:00' }, bar: null }, cancelled: false, time: '12:00' });
    expect(prepSlipTargets(slips)).toEqual([]);
  });
});
