import { describe, expect, it } from 'vitest';
import {
  formatDisplayPhone,
  mintBandCode,
  nameIsPhoneNumber,
  phoneAsName,
  saleBandDocument,
  salePrepDocument,
  saleReceiptDocument,
  ulidFromUuid,
  type SalePrintSnapshot,
} from '../src/index';

/**
 * SCRUM-1019, R1 — A NUMBER GIVEN WITH NO NAME (the owner's answer of 19
 * November 2026, docs/progress/plans/dropoff-beo-20261119/ANSWERS.md §8): the
 * customer is made with the number itself as the name until a name is given.
 *
 * - The name is the number in the form the till shows a number.
 * - A name written only as a number is recognised as one, and no other name.
 * - Paper never prints that number in a name's place: the receipt, a kitchen
 *   or bar slip and an adult's band print as a sale with no member name does.
 *
 * Demo data only: every number and name below is a ZZ TEST fixture.
 */

const TZ = 'Asia/Bangkok';
const KEY = 'zz-test-1019-band-key';
const ADULT_BAND = '018f0000-0000-7000-8000-0000001019a1';

const snapshot = (memberNickname: string | null): SalePrintSnapshot => ({
  saleId: '018f0000-0000-7000-8000-000000101901',
  receiptNumber: 'T1-001019',
  at: '2026-11-19T07:05:00.000Z',
  timezone: TZ,
  operatorName: 'OTO',
  branchName: 'HKT Central',
  staffName: 'ZZ TEST Nok',
  memberNickname,
  customerPhone: '+66619191101',
  lines: [
    { id: 'l-adult', kind: 'adults_paid', label: '2 Hours Play — Adults', quantity: 1, grossSatang: 20_000, ticket: true, payload: null, stayHours: 2, stayDurationLabel: '2 Hours' },
    {
      id: 'l-latte',
      kind: 'fnb_item',
      label: 'Latte',
      quantity: 1,
      grossSatang: 10_500,
      ticket: false,
      payload: { prepStation: 'bar', pickupCode: '19' },
      stayHours: null,
      stayDurationLabel: null,
    },
  ],
  subtotalSatang: 30_500,
  grossSatang: 30_500,
  taxBreakdown: {
    netSubtotal: 28_505,
    discountTotal: 0,
    serviceChargeTotal: 0,
    exclusiveTaxTotal: 0,
    inclusiveTaxTotal: 1_995,
    taxTotal: 1_995,
    categories: [],
    grandTotal: 30_500,
  } as never,
  tenders: [{ method: 'cash', last4: null, amountSatang: 30_500, tenderedSatang: 30_500, changeSatang: 0 }],
  bands: [
    {
      id: ADULT_BAND,
      kind: 'adult',
      code: mintBandCode('T1', ulidFromUuid(ADULT_BAND), KEY),
      saleLineId: 'l-adult',
      childName: null,
      allergies: null,
      medicalNotes: null,
      dietary: null,
    },
  ],
  orderChildren: [],
  note: null,
});

describe('the number as the name', () => {
  it('is the number as the till shows one, however it was typed', () => {
    expect(phoneAsName('0619191101')).toBe('+66 61 919 1101');
    expect(phoneAsName('+66 61-919-1101')).toBe('+66 61 919 1101');
    expect(phoneAsName('0619191101')).toBe(formatDisplayPhone('+66619191101'));
    expect(phoneAsName('not a number')).toBeNull();
    expect(phoneAsName('')).toBeNull();
  });

  it('is recognised as a number standing where a name would be; a name with a letter never is', () => {
    expect(nameIsPhoneNumber('+66 61 919 1101')).toBe(true);
    expect(nameIsPhoneNumber(' 061-919-1101 ')).toBe(true);
    expect(nameIsPhoneNumber('(061) 919 1101')).toBe(true);
    expect(nameIsPhoneNumber('ZZ TEST Mali')).toBe(false);
    expect(nameIsPhoneNumber('ZZ TEST Mali 0619191101')).toBe(false);
    expect(nameIsPhoneNumber('Room 12')).toBe(false);
    expect(nameIsPhoneNumber('007')).toBe(false);
    expect(nameIsPhoneNumber('')).toBe(false);
    expect(nameIsPhoneNumber(null)).toBe(false);
    expect(nameIsPhoneNumber(undefined)).toBe(false);
  });
});

describe('paper never prints the number in a name’s place', () => {
  const held = snapshot('+66 61 919 1101');
  const named = snapshot('ZZ TEST Mali');
  const adultBand = (s: SalePrintSnapshot) => saleBandDocument(s, s.bands[0]!);

  it('the receipt prints no member line for a member still held under their number', () => {
    expect(saleReceiptDocument(held).memberNickname).toBeUndefined();
    expect(JSON.stringify(saleReceiptDocument(held))).not.toContain('919 1101');
    expect(saleReceiptDocument(named).memberNickname).toBe('ZZ TEST Mali');
  });

  it('an adult’s band prints no holder name for them', () => {
    expect(adultBand(held).holderName).toBeUndefined();
    expect(JSON.stringify(adultBand(held))).not.toContain('919 1101');
    expect(adultBand(named).holderName).toBe('ZZ TEST Mali');
  });

  it('a kitchen or bar slip with no band holder prints no name for them', () => {
    expect(salePrepDocument(held, 'bar').holderName).toBeUndefined();
    expect(salePrepDocument(named, 'bar').holderName).toBe('ZZ TEST Mali');
  });

  it('a sale with no member prints as it did', () => {
    expect(saleReceiptDocument(snapshot(null)).memberNickname).toBeUndefined();
    expect(adultBand(snapshot(null)).holderName).toBeUndefined();
  });
});
