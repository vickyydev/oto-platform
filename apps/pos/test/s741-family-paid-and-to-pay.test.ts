import React, { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { apiCheckinToCheckIn, type ApiCheckin, type ApiRegistration } from '@/api/checkin';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import { MobileChildDetail } from '@/components/mobile/dropoff/MobileChildDetail';
import { Button } from '@/components/ui/button';
import { childNames, familyCheckInNames } from '@/lib/dropoff';
import type { CheckIn } from '@/types';

/**
 * SCRUM-741 — A FAMILY WITH A CHILD PAID FOR AND A SIBLING STILL TO PAY SAYS
 * WHICH IS WHICH, AND NAMES EACH CHILD'S CHECK IN.
 *
 * SCRUM-730 split the family's Check in by path (the booking for a child paid
 * online, the till for a sibling added at the door), and the card then showed
 * one "Booked & paid · no payment needed" for the whole family over two
 * buttons both called Check in. A family with one Check in reads as before.
 */

// The card is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const REG = '0190a0a0-0000-7000-8000-00000000a741';
const SALE = '0190a0a0-0000-7000-8000-00000000b741';
const BOOKING = '0190a0a0-0000-7000-8000-00000000f741';
const OTHER_BOOKING = '0190a0a0-0000-7000-8000-00000000f742';
const BOOKED_AT = '2026-11-04T03:00:00.000Z';

const stay = (id: string, childName: string, over: Partial<ApiCheckin> = {}): ApiCheckin => ({
  id,
  registrationId: REG,
  childId: null,
  childName,
  childAgeYears: 6,
  dateOfBirth: null,
  allergies: null,
  foodRestrictions: null,
  mayOrderFood: false,
  foodProvision: null,
  service: 'drop_off',
  status: 'registered',
  scheduledFor: null,
  bookedMinutes: 60,
  nannyId: null,
  checkedInAt: null,
  saleId: null,
  bandId: null,
  visitId: null,
  photoFileId: null,
  ...over,
});

const registration = (children: ApiCheckin[]): ApiRegistration => ({
  id: REG,
  branchId: '0190a0a0-0000-7000-8000-0000000000b1',
  memberId: null,
  guardianName: 'Khun Ying',
  guardianPhone: '+66897301003',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-11-04T02:00:00.000Z',
  acknowledgedConfirmations: [],
  source: 'booking',
  photoFileId: null,
  createdAt: '2026-11-04T02:00:00.000Z',
  children,
});

const shape = (c: ApiCheckin): CheckIn => apiCheckinToCheckIn(c, registration([c]));
const paidOnline = (id: string, name: string, bookingId = BOOKING) =>
  shape(stay(id, name, { paidOnline: { bookingId, reference: 'OTO-AB12-3456' } }));
const walkUp = (id: string, name: string) => shape(stay(id, name));
const doorBooked = (id: string, name: string) => shape(stay(id, name, { saleId: SALE, scheduledFor: BOOKED_AT }));

const bua = paidOnline('c-bua', 'Bua');
const nok = walkUp('c-nok', 'Nok');

type Pressable = ReactElement<{ onClick?: () => void; children?: ReactNode }>;
const buttonsIn = (node: ReactNode): Pressable[] => {
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap(buttonsIn);
  if (!isValidElement(node)) return [];
  if (node.type === Button) return [node as Pressable];
  return buttonsIn((node.props as { children?: ReactNode }).children);
};
const textOf = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return (node as ReactNode[]).map(textOf).join('');
  if (!isValidElement(node)) return '';
  return textOf((node.props as { children?: ReactNode }).children);
};

/** Each press the card offers, by the words on it, wired to spies. */
function desktop(family: CheckIn[]) {
  const on = {
    onCheckIn: vi.fn<(c: CheckIn) => void>(),
    onCheckInBooked: vi.fn<(c: CheckIn[]) => void>(),
    onRedeemBooking: vi.fn<(c: CheckIn) => void>(),
  };
  const noop = () => undefined;
  const props = {
    family,
    onMessage: noop,
    onAssignNanny: noop,
    onCheckOut: noop,
    onEdit: noop,
    onResend: noop,
    onSimulateConfirm: noop,
    onMarkFailed: noop,
    onSaveAndResend: noop,
    onManagePickups: noop,
    ...on,
  };
  const presses = buttonsIn(FamilyCheckInCard(props)).map((b) => ({ label: textOf(b.props.children), press: () => b.props.onClick?.() }));
  return { html: renderToStaticMarkup(createElement(FamilyCheckInCard, props)), presses, on };
}

function phone(family: CheckIn[]) {
  const on = {
    onCheckIn: vi.fn<(c: CheckIn) => void>(),
    onMarkArrived: vi.fn<(c: CheckIn) => void>(),
    onRedeemBooking: vi.fn<(c: CheckIn) => void>(),
  };
  const noop = () => undefined;
  const props = {
    family,
    onBack: noop,
    onMessage: noop,
    onAssignNanny: noop,
    onCheckOut: noop,
    onEdit: noop,
    onResend: noop,
    onSimulateConfirm: noop,
    onMarkFailed: noop,
    onSaveAndResend: noop,
    onManagePickups: noop,
    ...on,
  };
  const presses = buttonsIn(MobileChildDetail(props)).map((b) => ({ label: textOf(b.props.children), press: () => b.props.onClick?.() }));
  return { html: renderToStaticMarkup(createElement(MobileChildDetail, props)), presses, on };
}

const checkIns = (presses: { label: string }[]) => presses.map((p) => p.label).filter((l) => /^Check in/i.test(l));

describe('s741 — names on a family card', () => {
  it('lists one, two and three children as a card says them', () => {
    expect(childNames([bua])).toBe('Bua');
    expect(childNames([bua, nok])).toBe('Bua & Nok');
    expect(childNames([bua, nok, walkUp('c-mai', 'Mai')])).toBe('Bua, Nok & Mai');
    expect(childNames([])).toBe('');
  });

  it('splits a family with a paid child and a sibling to pay, and no other family', () => {
    expect(familyCheckInNames([bua, nok]).split).toEqual({ paid: [bua], toPay: [nok] });
    expect(familyCheckInNames([bua]).split).toBeNull();
    expect(familyCheckInNames([nok, walkUp('c-mai', 'Mai')]).split).toBeNull();
    const tam = doorBooked('c-tam', 'Tam');
    expect(familyCheckInNames([tam, nok]).split).toEqual({ paid: [tam], toPay: [nok] });
  });

  it('names for the booking press only the children on the booking it opens', () => {
    const ploy = paidOnline('c-ploy', 'Ploy');
    const fon = paidOnline('c-fon', 'Fon', OTHER_BOOKING);
    expect(familyCheckInNames([bua, ploy, fon]).redeem).toEqual([bua, ploy]);
  });
});

describe('s741 — the check-in board card', () => {
  it('says which child is paid and which is to pay, not booked and paid for all', () => {
    const { html } = desktop([bua, nok]);
    expect(html).toContain('Booked &amp; paid · Bua');
    expect(html).toContain('To pay · Nok');
    expect(html).not.toContain('no payment needed');
  });

  it('names each Check in, and each goes where it went before', () => {
    const { presses, on } = desktop([bua, nok]);
    expect(checkIns(presses)).toEqual(['Check in Bua', 'Check in Nok']);
    presses.find((p) => p.label === 'Check in Bua')?.press();
    expect(on.onRedeemBooking).toHaveBeenCalledWith(bua);
    presses.find((p) => p.label === 'Check in Nok')?.press();
    expect(on.onCheckIn).toHaveBeenCalledWith(nok);
    expect(on.onCheckInBooked).not.toHaveBeenCalled();
  });

  it('names two paid presses too, and keeps the family-wide paid label', () => {
    const tam = doorBooked('c-tam', 'Tam');
    const { html, presses, on } = desktop([bua, tam]);
    expect(html).toContain('Booked &amp; paid · no payment needed');
    expect(html).not.toContain('To pay');
    expect(checkIns(presses)).toEqual(['Check in Bua', 'Check in Tam']);
    presses.find((p) => p.label === 'Check in Tam')?.press();
    expect(on.onCheckInBooked).toHaveBeenCalledWith([tam]);
  });

  it('names every walk-up sibling on the till press, as the till loads them all', () => {
    const mai = walkUp('c-mai', 'Mai');
    const { html, presses } = desktop([bua, nok, mai]);
    expect(html).toContain('To pay · Nok &amp; Mai');
    expect(checkIns(presses)).toEqual(['Check in Bua', 'Check in Nok & Mai']);
  });

  it('leaves a family with one Check in as it was', () => {
    const paid = desktop([bua]);
    expect(paid.html).toContain('Booked &amp; paid · no payment needed');
    expect(checkIns(paid.presses)).toEqual(['Check in']);
    const siblings = desktop([nok, walkUp('c-mai', 'Mai')]);
    expect(siblings.html).not.toContain('Booked &amp; paid');
    expect(siblings.html).not.toContain('To pay');
    expect(checkIns(siblings.presses)).toEqual(['Check in']);
  });
});

describe("s741 — the phone's family screen", () => {
  it('says which child is paid and which is to pay, and names each Check In', () => {
    const { html, presses, on } = phone([bua, nok]);
    expect(html).toContain('Booked &amp; paid · Bua');
    expect(html).toContain('To pay · Nok');
    expect(html).not.toContain('no payment needed');
    expect(checkIns(presses)).toEqual(['Check In Bua', 'Check In Nok']);
    presses.find((p) => p.label === 'Check In Bua')?.press();
    expect(on.onRedeemBooking).toHaveBeenCalledWith(bua);
    presses.find((p) => p.label === 'Check In Nok')?.press();
    expect(on.onCheckIn).toHaveBeenCalledWith(nok);
  });

  it('leaves a family who all paid online, and a booked family with a walk-up, as they were', () => {
    const paid = phone([bua]);
    expect(paid.html).toContain('Booked &amp; paid · no payment needed');
    expect(checkIns(paid.presses)).toEqual(['Check In']);
    const doorFamily = phone([doorBooked('c-tam', 'Tam'), nok]);
    expect(doorFamily.html).not.toContain('Booked &amp; paid');
    expect(doorFamily.html).not.toContain('To pay');
    expect(checkIns(doorFamily.presses)).toEqual(['Check In']);
    expect(doorFamily.presses.map((p) => p.label)).toContain('Mark Arrived');
  });
});
