import { readFileSync } from 'node:fs';
import React, { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { boardChildToCheckIn, type ApiBoardChild, type ApiBoardFamily } from '@/api/checkin';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import { MobileChildCard } from '@/components/mobile/dropoff/MobileChildCard';
import { MobileChildDetail } from '@/components/mobile/dropoff/MobileChildDetail';
import { bookedForLabel, boardBookingOf, type CancellableBooking } from '@/components/dropoff/CancelBookingDialog';
import type { CheckIn } from '@/types';

/**
 * SCRUM-886 — WAITING BOOKINGS FROM EARLIER DAYS CAN BE CANCELLED FROM THE
 * CHECK-IN BOARD.
 *
 * SCRUM-862 gave the till's Add drop-off picker "Cancel booking" and made the
 * picker list today's waiting bookings only. The leftovers it no longer lists
 * still wait on the board's Upcoming tab, and the board had no cancel. Now the
 * board's family card (desk and phone) offers the picker's Cancel booking with
 * the picker's refusals — hidden when every waiting child is paid, disabled
 * with the same line while one is paid or a sibling is already checked in —
 * and opens the same confirm (CancelBookingDialog). After a cancel the board
 * is read again, so the card leaves and the counts follow. A family waiting
 * for another day says which: "Booked for 5 Oct".
 */

// The cards are compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const REG = '0190a0a0-0000-7000-8000-00000000a886';
const SALE = '0190a0a0-0000-7000-8000-00000000b886';

function apiChild(id: string, over: Partial<ApiBoardChild> = {}): ApiBoardChild {
  return {
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
    nannyName: null,
    checkedOutAt: null,
    ...over,
  };
}

const apiFamily = (children: ApiBoardChild[]): ApiBoardFamily => ({
  registrationId: REG,
  branchId: '0190a0a0-0000-7000-8000-0000000000b1',
  memberId: null,
  guardianName: 'ZZ TEST Ploy',
  guardianPhone: '+66812345678',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-10-05T03:00:00Z',
  source: 'till',
  photoFileId: null,
  createdAt: '2026-10-05T03:00:00Z',
  contact: { status: 'confirmed', sentAt: null, confirmedAt: null },
  tab: 'registered',
  children,
});

/** The board's family, as `pages/DropOff.tsx` hands it to the card. */
const boardFamily = (children: ApiBoardChild[]): CheckIn[] => children.map((c) => boardChildToCheckIn(c, apiFamily(children)));

const noop = () => {};
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
  renderToStaticMarkup(
    createElement(MobileChildDetail, { ...cardProps(family, onCancelBooking), onBack: noop, onMarkArrived: noop }),
  );

/** The one `<button>` whose text is "Cancel booking", or null. */
function cancelButton(markup: string): string | null {
  const match = /<button(?:(?!<\/button>)[\s\S])*Cancel booking<\/button>/.exec(markup);
  return match ? match[0] : null;
}

/** The `disabled` attribute itself — every button's class list carries `disabled:` variants. */
function isDisabled(button: string | null): boolean {
  return /<button[^>]*\sdisabled=""[^>]*>/.test(button ?? '');
}

type Pressable = { props: { children?: ReactNode; onClick?: () => void; disabled?: boolean } };
function words(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? words(node.props.children) : '';
}
/** The element tree's "Cancel booking" button (the card is called as a function, so its own handlers are reachable). */
function cancelElement(node: ReactNode): Pressable | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = cancelElement(item);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  if (node.props.onClick && words(node.props.children).trim() === 'Cancel booking') return node as Pressable;
  return cancelElement(node.props.children);
}

const PAID_ONLINE = { bookingId: SALE, reference: 'OTO-AB12-3456' };
const PAID_AT_TILL = { saleId: SALE, receiptNumber: 'T1-000086' };

describe('s886 — the board card offers the picker’s Cancel booking', () => {
  it('on a waiting, unpaid family: enabled, beside its Check in', () => {
    const markup = deskCard(boardFamily([apiChild('c1'), apiChild('c2', { childName: 'ZZ TEST Bua' })]), noop);
    const button = cancelButton(markup);
    expect(button).not.toBeNull();
    expect(isDisabled(button)).toBe(false);
    expect(markup).toContain('Check in');
    expect(markup).not.toContain('handled through its sale');
  });

  it('is not offered where the board gives no cancel path', () => {
    expect(cancelButton(deskCard(boardFamily([apiChild('c1')])))).toBeNull();
  });

  it('pressing it hands the confirm the booking and its waiting children', () => {
    const onCancel = vi.fn<(b: CancellableBooking) => void>();
    const family = boardFamily([apiChild('c1'), apiChild('c2', { childName: 'ZZ TEST Bua' })]);
    const button = cancelElement(FamilyCheckInCard(cardProps(family, onCancel)));
    expect(button).not.toBeNull();
    button!.props.onClick?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    const booking = onCancel.mock.calls[0]![0];
    expect(booking.registrationId).toBe(REG);
    expect(booking.parentName).toBe('ZZ TEST Ploy');
    expect(booking.children.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('is hidden on a family every waiting child of which is paid (online or at the till)', () => {
    expect(cancelButton(deskCard(boardFamily([apiChild('c1', { paidOnline: PAID_ONLINE })]), noop))).toBeNull();
    expect(
      cancelButton(deskCard(boardFamily([apiChild('c1', { paidAtTill: PAID_AT_TILL, scheduledFor: '2026-11-12T03:00:00Z' })]), noop)),
    ).toBeNull();
  });

  it('is disabled with the picker’s line when a paid child has an unpaid sibling waiting', () => {
    const markup = deskCard(
      boardFamily([apiChild('c1', { paidOnline: PAID_ONLINE }), apiChild('c2', { childName: 'ZZ TEST Nok' })]),
      noop,
    );
    expect(isDisabled(cancelButton(markup))).toBe(true);
    expect(markup).toContain('ZZ TEST Mint is paid for — a paid booking is handled through its sale.');
  });

  it('is disabled with the picker’s line when a sibling was already checked in and collected today', () => {
    const markup = deskCard(
      boardFamily([
        apiChild('c1', { status: 'out', checkedInAt: '2026-11-12T03:00:00Z', checkedOutAt: '2026-11-12T05:00:00Z' }),
        apiChild('c2', { childName: 'ZZ TEST Nok' }),
      ]),
      noop,
    );
    expect(isDisabled(cancelButton(markup))).toBe(true);
    expect(markup).toContain('ZZ TEST Mint is already checked in — a checked-in booking is handled through its sale.');
  });

  it('is not offered on a family with a child in the park (the In Park tab’s card)', () => {
    const markup = deskCard(
      boardFamily([
        apiChild('c1', { status: 'in_park', checkedInAt: new Date().toISOString() }),
        apiChild('c2', { childName: 'ZZ TEST Nok' }),
      ]),
      noop,
    );
    expect(cancelButton(markup)).toBeNull();
  });
});

describe('s886 — an earlier day’s booking says which day', () => {
  it('the platform’s bookedForDate rides onto the board row', () => {
    const [row] = boardFamily([apiChild('c1', { bookedForDate: '2026-10-05' })]);
    expect(row!.bookedForDate).toBe('2026-10-05');
    const [today] = boardFamily([apiChild('c1', { bookedForDate: null })]);
    expect(today!.bookedForDate).toBeUndefined();
    // An older box copy carries no field at all: nothing is shown.
    const [old] = boardFamily([apiChild('c1')]);
    expect(old!.bookedForDate).toBeUndefined();
  });

  it('labels the day short, with the year only when it is not this year', () => {
    const now = new Date('2026-11-12T05:00:00Z');
    expect(bookedForLabel(boardFamily([apiChild('c1', { bookedForDate: '2026-10-05' })]), now)).toBe('Booked for 5 Oct');
    expect(bookedForLabel(boardFamily([apiChild('c1', { bookedForDate: '2025-12-30' })]), now)).toBe('Booked for 30 Dec 2025');
    expect(bookedForLabel(boardFamily([apiChild('c1')]), now)).toBeNull();
    expect(
      bookedForLabel(
        boardFamily([apiChild('c1', { bookedForDate: '2026-10-06' }), apiChild('c2', { bookedForDate: '2026-10-05' })]),
        now,
      ),
    ).toBe('Booked for 5 Oct, 6 Oct');
  });

  it('the desk card and the phone card show it, and a today’s family shows none', () => {
    const old = boardFamily([apiChild('c1', { bookedForDate: '2026-10-05' })]);
    expect(deskCard(old, noop)).toContain('Booked for 5 Oct');
    expect(renderToStaticMarkup(createElement(MobileChildCard, { family: old, onTap: noop }))).toContain('Booked for 5 Oct');
    expect(phoneDetail(old, noop)).toContain('Booked for 5 Oct');
    expect(deskCard(boardFamily([apiChild('c1')]), noop)).not.toContain('Booked for');
  });

  it('an earlier day’s waiting, unpaid booking can be cancelled from the card', () => {
    const markup = deskCard(boardFamily([apiChild('c1', { bookedForDate: '2026-10-05' })]), noop);
    expect(isDisabled(cancelButton(markup))).toBe(false);
  });
});

describe('s886 — the phone till’s board offers the same', () => {
  it('on the family screen: enabled for a waiting unpaid family, hidden when paid, disabled with the line when mixed', () => {
    expect(isDisabled(cancelButton(phoneDetail(boardFamily([apiChild('c1')]), noop)))).toBe(false);
    expect(cancelButton(phoneDetail(boardFamily([apiChild('c1')])))).toBeNull();
    expect(cancelButton(phoneDetail(boardFamily([apiChild('c1', { paidAtTill: PAID_AT_TILL })]), noop))).toBeNull();
    const mixed = phoneDetail(
      boardFamily([apiChild('c1', { paidAtTill: PAID_AT_TILL }), apiChild('c2', { childName: 'ZZ TEST Nok' })]),
      noop,
    );
    expect(isDisabled(cancelButton(mixed))).toBe(true);
    expect(mixed).toContain('ZZ TEST Mint is paid for — a paid booking is handled through its sale.');
  });
});

describe('s886 — boardBookingOf', () => {
  it('names the waiting children and the collected ones; nothing for a family in the park or with no one waiting', () => {
    const booking = boardBookingOf(
      boardFamily([
        apiChild('c1', { status: 'out', checkedInAt: '2026-11-12T03:00:00Z', checkedOutAt: '2026-11-12T05:00:00Z' }),
        apiChild('c2', { childName: 'ZZ TEST Nok' }),
      ]),
    );
    expect(booking?.children.map((c) => c.id)).toEqual(['c2']);
    expect(booking?.checkedIn).toEqual(['ZZ TEST Mint']);
    expect(boardBookingOf(boardFamily([apiChild('c1', { status: 'out' })]))).toBeNull();
    expect(boardBookingOf(boardFamily([apiChild('c1', { status: 'in_park' }), apiChild('c2')]))).toBeNull();
    expect(boardBookingOf(boardFamily([apiChild('c1', { paidOnline: PAID_ONLINE })]))).toBeNull();
  });
});

describe('s886 — after the cancel the board is read again', () => {
  const desk = readFileSync(new URL('../src/pages/DropOff.tsx', import.meta.url), 'utf8');
  const phone = readFileSync(new URL('../src/components/mobile/dropoff/MobileDropOffBoard.tsx', import.meta.url), 'utf8');

  it('the desk board opens the shared confirm and re-reads the board (the card leaves, the counts follow)', () => {
    expect(desk).toContain('onCancelBooking={setCancelFor}');
    expect(desk).toContain('<CancelBookingDialog booking={cancelFor} onClose={() => setCancelFor(null)} onCancelled={refresh} />');
    // The counts are the board answer's own children, read again by `refresh`.
    expect(desk).toContain('}, [loadBoard, version]);');
  });

  it('the phone board closes the family screen and re-reads the board', () => {
    expect(phone).toContain('onCancelBooking={setCancelFor}');
    const dialog = phone.slice(phone.indexOf('<CancelBookingDialog'));
    expect(dialog.slice(0, dialog.indexOf('/>'))).toMatch(/onCancelled=\{\(\) => \{\s*closeDetail\(\);\s*refresh\(\);\s*\}\}/);
  });
});
