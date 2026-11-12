import React, { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  apiCheckinToCheckIn,
  boardChildToCheckIn,
  type ApiBoardChild,
  type ApiBoardFamily,
  type ApiCheckin,
  type ApiRegistration,
} from '@/api/checkin';
import { WaitingFamily, type RegistrationGroup } from '@/components/till/AddDropOffModal';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import { MobileChildDetail } from '@/components/mobile/dropoff/MobileChildDetail';
import {
  boardCancelAloneOf,
  cancelAloneLabel,
  cancelAloneOf,
  cancelBookingBlockedBy,
  type CancellableBooking,
} from '@/components/dropoff/CancelBookingDialog';
import type { CheckIn } from '@/types';

/**
 * SCRUM-909 — A CHILD WHO WENT HOME IS CANCELLED ON THEIR OWN.
 *
 * Two siblings on one booking, both paid on one sale, and one refunded by item
 * from History (or never paid for): "Cancel booking" stays refused over the
 * sibling who is paid for or already in the park (SCRUM-862's rule, with its
 * line), and beside it "Cancel <child>'s booking" takes only the unpaid child
 * off the list. The picker, the desk board and the phone board all offer it;
 * the confirm then cancels only those children (`checkinIds`).
 */

// The cards are compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const REG = '0190a0a0-0000-7000-8000-00000000a909';
const SALE = '0190a0a0-0000-7000-8000-00000000b909';
const PAID_AT_TILL = { saleId: SALE, receiptNumber: 'T1-000909' };

const stay = (id: string, over: Partial<ApiCheckin> = {}): ApiCheckin => ({
  id,
  registrationId: REG,
  childId: null,
  childName: 'ZZ TEST Mint',
  childAgeYears: 6,
  dateOfBirth: null,
  allergies: null,
  foodRestrictions: null,
  mayOrderFood: false,
  foodProvision: null,
  service: 'drop_off',
  status: 'registered',
  scheduledFor: null,
  bookedMinutes: 120,
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
  guardianName: 'ZZ TEST Ploy',
  guardianPhone: '+66812345678',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-11-12T02:00:00.000Z',
  acknowledgedConfirmations: [],
  source: 'till',
  photoFileId: null,
  createdAt: '2026-11-12T02:00:00.000Z',
  children,
});

const group = (children: ApiCheckin[], checkedIn?: string[]): RegistrationGroup => ({
  registrationId: REG,
  parentName: 'ZZ TEST Ploy',
  phone: '+66812345678',
  children: children.map((c) => apiCheckinToCheckIn(c, registration(children))),
  ...(checkedIn ? { checkedIn } : {}),
});

function boardChild(id: string, over: Partial<ApiBoardChild> = {}): ApiBoardChild {
  return { ...stay(id), nannyName: null, checkedOutAt: null, ...over } as ApiBoardChild;
}
const boardFamily = (children: ApiBoardChild[]): CheckIn[] => {
  const fam: ApiBoardFamily = {
    registrationId: REG,
    branchId: '0190a0a0-0000-7000-8000-0000000000b1',
    memberId: null,
    guardianName: 'ZZ TEST Ploy',
    guardianPhone: '+66812345678',
    contactChannel: 'whatsapp',
    consentRecordedAt: '2026-11-12T02:00:00Z',
    source: 'till',
    photoFileId: null,
    createdAt: '2026-11-12T02:00:00Z',
    contact: { status: 'confirmed', sentAt: null, confirmedAt: null },
    tab: 'registered',
    children,
  };
  return children.map((c) => boardChildToCheckIn(c, fam));
};

const noop = () => {};
const pickerCard = (g: RegistrationGroup, onCancel?: (g: RegistrationGroup) => void, attached: string[] = []) =>
  renderToStaticMarkup(createElement(WaitingFamily, { group: g, attached: new Set(attached), onAddToSale: noop, onCancel }));

function cardProps(family: CheckIn[], onCancelBooking?: (b: CancellableBooking) => void) {
  return {
    family,
    onMessage: noop,
    onAssignNanny: noop,
    onCheckIn: noop,
    onCheckOut: noop,
    onCheckInBooked: noop,
    onRedeemBooking: noop,
    onEdit: noop,
    onResend: noop,
    onSimulateConfirm: noop,
    onMarkFailed: noop,
    onSaveAndResend: noop,
    onManagePickups: noop,
    onCancelBooking,
  };
}
const deskCard = (family: CheckIn[], onCancelBooking?: (b: CancellableBooking) => void) =>
  renderToStaticMarkup(createElement(FamilyCheckInCard, cardProps(family, onCancelBooking)));
const phoneDetail = (family: CheckIn[], onCancelBooking?: (b: CancellableBooking) => void) =>
  renderToStaticMarkup(createElement(MobileChildDetail, { ...cardProps(family, onCancelBooking), onBack: noop, onMarkArrived: noop }));

/** The one `<button>` whose text ends with `label`, or null. */
function buttonNamed(markup: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '(?:\'|&#x27;)');
  return new RegExp(`<button(?:(?!</button>)[\\s\\S])*${escaped}</button>`).exec(markup)?.[0] ?? null;
}
const isDisabled = (button: string | null) => /<button[^>]*\sdisabled=""[^>]*>/.test(button ?? '');

type Pressable = { props: { children?: ReactNode; onClick?: () => void } };
function words(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? words(node.props.children) : '';
}
function pressable(node: ReactNode, label: string): Pressable | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pressable(item, label);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  if (node.props.onClick && words(node.props.children).trim() === label) return node as Pressable;
  return pressable(node.props.children, label);
}

const NOK = "Cancel ZZ TEST Nok's booking";

describe('s909 — cancelAloneOf', () => {
  const mixed = group([stay('c1', { paidAtTill: PAID_AT_TILL }), stay('c2', { childName: 'ZZ TEST Nok' })]);

  it('offers the unpaid child on their own beside a paid sibling, and only them', () => {
    const alone = cancelAloneOf(mixed, new Set());
    expect(alone?.alone).toBe(true);
    expect(alone?.children.map((c) => c.id)).toEqual(['c2']);
    expect(alone?.registrationId).toBe(REG);
    expect(cancelAloneLabel(alone!)).toBe(NOK);
    // The whole press keeps SCRUM-862's refusal and line.
    expect(cancelBookingBlockedBy(mixed, new Set())).toBe('ZZ TEST Mint is paid for — a paid booking is handled through its sale.');
  });

  it('offers them beside a sibling already checked in', () => {
    const alone = cancelAloneOf(group([stay('c2', { childName: 'ZZ TEST Nok' })], ['ZZ TEST Mint']), new Set());
    expect(alone?.children.map((c) => c.id)).toEqual(['c2']);
  });

  it('offers nothing when the whole press is open, every child is paid, or a child is on this sale', () => {
    expect(cancelAloneOf(group([stay('c1'), stay('c2', { childName: 'ZZ TEST Nok' })]), new Set())).toBeNull();
    expect(cancelAloneOf(group([stay('c1', { paidAtTill: PAID_AT_TILL })]), new Set())).toBeNull();
    expect(cancelAloneOf(mixed, new Set(['c2']))).toBeNull();
  });

  it('names two children together', () => {
    const two = cancelAloneOf(
      group([stay('c1', { paidAtTill: PAID_AT_TILL }), stay('c2', { childName: 'ZZ TEST Nok' }), stay('c3', { childName: 'ZZ TEST Bua' })]),
      new Set(),
    );
    expect(cancelAloneLabel(two!)).toBe("Cancel ZZ TEST Nok & ZZ TEST Bua's booking");
  });
});

describe('s909 — the picker card', () => {
  const mixed = group([stay('c1', { paidAtTill: PAID_AT_TILL }), stay('c2', { childName: 'ZZ TEST Nok' })]);

  it('keeps Cancel booking disabled with its line, and offers the unpaid child on their own', () => {
    const markup = pickerCard(mixed, noop);
    expect(isDisabled(buttonNamed(markup, 'Cancel booking'))).toBe(true);
    expect(markup).toContain('ZZ TEST Mint is paid for — a paid booking is handled through its sale.');
    const alone = buttonNamed(markup, NOK);
    expect(alone).not.toBeNull();
    expect(isDisabled(alone)).toBe(false);
  });

  it('pressing it hands the confirm only that child, marked to be cancelled alone', () => {
    const onCancel = vi.fn<(g: RegistrationGroup) => void>();
    const press = pressable(WaitingFamily({ group: mixed, attached: new Set(), onAddToSale: noop, onCancel }), NOK);
    expect(press).not.toBeNull();
    press!.props.onClick?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    const handed = onCancel.mock.calls[0]![0] as CancellableBooking;
    expect(handed.alone).toBe(true);
    expect(handed.children.map((c) => c.id)).toEqual(['c2']);
  });

  it('is not offered on an unpaid family (the whole press is open) nor where the picker gives no cancel path', () => {
    expect(buttonNamed(pickerCard(group([stay('c1'), stay('c2', { childName: 'ZZ TEST Nok' })]), noop), NOK)).toBeNull();
    expect(buttonNamed(pickerCard(mixed), NOK)).toBeNull();
  });
});

describe('s909 — the board, desk and phone', () => {
  it('a paid sibling: Cancel booking stays disabled, the unpaid child is offered on their own', () => {
    const family = boardFamily([
      boardChild('c1', { paidAtTill: PAID_AT_TILL, scheduledFor: '2026-11-12T03:00:00Z' }),
      boardChild('c2', { childName: 'ZZ TEST Nok' }),
    ]);
    for (const markup of [deskCard(family, noop), phoneDetail(family, noop)]) {
      expect(isDisabled(buttonNamed(markup, 'Cancel booking'))).toBe(true);
      expect(isDisabled(buttonNamed(markup, NOK))).toBe(false);
      expect(buttonNamed(markup, NOK)).not.toBeNull();
    }
  });

  it('a sibling in the park: no Cancel booking (as before), but the child who went home is offered on their own', () => {
    const family = boardFamily([
      boardChild('c1', { status: 'in_park', checkedInAt: new Date().toISOString(), saleId: SALE }),
      boardChild('c2', { childName: 'ZZ TEST Nok' }),
    ]);
    const markup = deskCard(family, noop);
    expect(buttonNamed(markup, 'Cancel booking')).toBeNull();
    expect(buttonNamed(markup, NOK)).not.toBeNull();
    expect(boardCancelAloneOf(family)?.children.map((c) => c.id)).toEqual(['c2']);
  });

  it('pressing it on the desk card hands the confirm only that child', () => {
    const onCancel = vi.fn<(b: CancellableBooking) => void>();
    const family = boardFamily([boardChild('c1', { paidAtTill: PAID_AT_TILL }), boardChild('c2', { childName: 'ZZ TEST Nok' })]);
    const press = pressable(FamilyCheckInCard(cardProps(family, onCancel)), NOK);
    expect(press).not.toBeNull();
    press!.props.onClick?.();
    const handed = onCancel.mock.calls[0]![0];
    expect(handed).toMatchObject({ registrationId: REG, alone: true });
    expect(handed.children.map((c) => c.id)).toEqual(['c2']);
  });

  it('is not offered on an unpaid family, a paid one, or where the board gives no cancel path', () => {
    expect(buttonNamed(deskCard(boardFamily([boardChild('c1'), boardChild('c2', { childName: 'ZZ TEST Nok' })]), noop), NOK)).toBeNull();
    expect(boardCancelAloneOf(boardFamily([boardChild('c1', { paidAtTill: PAID_AT_TILL })]))).toBeNull();
    const mixed = boardFamily([boardChild('c1', { paidAtTill: PAID_AT_TILL }), boardChild('c2', { childName: 'ZZ TEST Nok' })]);
    expect(buttonNamed(deskCard(mixed), NOK)).toBeNull();
  });
});
