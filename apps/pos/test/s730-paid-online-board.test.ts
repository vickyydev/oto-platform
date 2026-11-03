import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React, { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCheckinToCheckIn,
  waitingStaysOf,
  type ApiCheckin,
  type ApiRegistration,
} from '@/api/checkin';
import { BOOKING_QR_SIGNATURE_INVALID } from '@/api/bookings';
import { ApiError, NetworkError } from '@/api/client';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import { WaitingFamily, type RegistrationGroup } from '@/components/till/AddDropOffModal';
import { openedBookingFailure } from '@/components/till/RedeemBookingModal';
import { Button } from '@/components/ui/button';
import { familyCheckInActions } from '@/lib/dropoff';
import {
  setBookingRedeemHandoff,
  setDropOffHandoff,
  takeBookingRedeemHandoff,
  takeDropOffHandoff,
} from '@/lib/dropoffHandoff';
import type { CheckIn } from '@/types';

/**
 * SCRUM-730 — A FAMILY WHO PAID ONLINE IS NEVER A LINE TO CHARGE.
 *
 * The prototype took no payment for a child booked and paid online
 * (`checkInFamilyBooked`, and `createBooking`'s booked time at mockApi.ts:1147).
 * Here that child waits with no sale until the booking is redeemed, so the
 * board's choice and the till's load path both read the platform's `paidOnline`:
 * the board sends staff to the booking, and the till never loads the child.
 * `fetch` is stubbed at the boundary, as `s494-checkin-mobile.test.ts` does.
 */

// The card is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const BRANCH = '0190a0a0-0000-7000-8000-0000000000b1';
const REG = '0190a0a0-0000-7000-8000-00000000a001';
const SALE = '0190a0a0-0000-7000-8000-00000000b001';
const BOOKING = '0190a0a0-0000-7000-8000-00000000f001';
const PAID = { bookingId: BOOKING, reference: 'OTO-AB12-3456' };

const stay = (id: string, over: Partial<ApiCheckin> = {}): ApiCheckin => ({
  id,
  registrationId: REG,
  childId: null,
  childName: 'Ploy',
  childAgeYears: 6,
  dateOfBirth: null,
  allergies: 'Peanuts',
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
  branchId: BRANCH,
  memberId: null,
  guardianName: 'Khun Mali',
  guardianPhone: '+66812345678',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-11-03T02:00:00.000Z',
  acknowledgedConfirmations: [],
  source: 'booking',
  photoFileId: null,
  createdAt: '2026-11-03T02:00:00.000Z',
  children,
});

const shape = (c: ApiCheckin): CheckIn => apiCheckinToCheckIn(c, registration([c]));

describe("s730 — the till's load path", () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          registrations: [
            registration([
              stay('c-online', { paidOnline: PAID }),
              stay('c-online-nanny', { paidOnline: PAID, service: 'nanny', scheduledFor: '2026-11-04T03:00:00.000Z' }),
              stay('c-sibling', { childName: 'Nok', paidOnline: null }),
              stay('c-door-booked', { childName: 'Tam', saleId: SALE, scheduledFor: '2026-11-04T03:00:00.000Z' }),
            ]),
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never loads a child paid for online as a line to charge, and still loads the sibling at the door', async () => {
    const lines = await waitingStaysOf(BRANCH, REG);
    expect(lines.map((c) => c.id)).toEqual(['c-sibling']);
  });
});

describe('s730 — what the board offers', () => {
  it('sends a paid online drop-off child to the booking', () => {
    const child = shape(stay('c1', { paidOnline: PAID }));
    expect(child.paidOnline).toEqual({ ...PAID, redeemed: false });
    expect(familyCheckInActions([child])).toEqual({ toRedeem: [child], booked: [], walkUp: [] });
  });

  it('sends a paid online nanny child, who has a booked time, to the booking too', () => {
    const child = shape(stay('c1', { paidOnline: PAID, service: 'nanny', scheduledFor: '2026-11-04T03:00:00.000Z' }));
    expect(familyCheckInActions([child])).toEqual({ toRedeem: [child], booked: [], walkUp: [] });
  });

  it('checks a child in with no payment once the redemption filed them on its sale', () => {
    const child = shape(stay('c1', { paidOnline: PAID, saleId: SALE, scheduledFor: '2026-11-04T03:00:00.000Z' }));
    expect(child.paidOnline?.redeemed).toBe(true);
    expect(familyCheckInActions([child])).toEqual({ toRedeem: [], booked: [child], walkUp: [] });
  });

  it('leaves a walk-up and a door-booked child exactly as they were', () => {
    const walkUp = shape(stay('c1'));
    const doorBooked = shape(stay('c2', { saleId: SALE, scheduledFor: '2026-11-04T03:00:00.000Z' }));
    expect(familyCheckInActions([walkUp, doorBooked])).toEqual({ toRedeem: [], booked: [doorBooked], walkUp: [walkUp] });
  });

  it('splits a family with a paid child and a sibling added at the door', () => {
    const paid = shape(stay('c1', { paidOnline: PAID }));
    const sibling = shape(stay('c2', { childName: 'Nok', paidOnline: null }));
    expect(familyCheckInActions([paid, sibling])).toEqual({ toRedeem: [paid], booked: [], walkUp: [sibling] });
  });

  it('offers nothing for a child already in the park', () => {
    const inPark = shape(stay('c1', { paidOnline: PAID, status: 'in_park', saleId: SALE }));
    expect(familyCheckInActions([inPark])).toEqual({ toRedeem: [], booked: [], walkUp: [] });
  });
});

describe('s730 — the card a person sees', () => {
  const noop = () => undefined;
  const card = (family: CheckIn[]) =>
    renderToStaticMarkup(
      createElement(FamilyCheckInCard, {
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
      }),
    );

  it('says booked and paid on a paid online drop-off child, with one Check in', () => {
    const html = card([shape(stay('c1', { paidOnline: PAID }))]);
    expect(html).toContain('Booked &amp; paid · no payment needed');
    expect(html.match(/Check in/g)).toHaveLength(1);
  });

  it('does not say booked and paid on a walk-up', () => {
    const html = card([shape(stay('c1'))]);
    expect(html).not.toContain('Booked &amp; paid');
    expect(html).toContain('Check in');
  });
});

describe('s730 — the hand-over', () => {
  it('names the booking once, apart from the registration hand-over', () => {
    setBookingRedeemHandoff(BOOKING);
    expect(takeDropOffHandoff()).toBeNull();
    expect(takeBookingRedeemHandoff()).toBe(BOOKING);
    expect(takeBookingRedeemHandoff()).toBeNull();
    setDropOffHandoff(REG);
    expect(takeBookingRedeemHandoff()).toBeNull();
    expect(takeDropOffHandoff()).toBe(REG);
  });

  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it.each([
    ['../src/pages/Till.tsx', 'openScannedBooking({ bookingId })'],
    ['../src/components/mobile/MobileTill.tsx', 'setHandedBooking({ bookingId })'],
  ])('%s opens the redeem dialog on the handed booking', (path, opens) => {
    const src = source(path);
    expect(src).toContain('takeBookingRedeemHandoff()');
    expect(src).toContain(opens);
  });

  it.each(['../src/pages/DropOff.tsx', '../src/components/mobile/dropoff/MobileDropOffBoard.tsx'])(
    '%s hands the booking over, not the registration, for a family who paid online',
    (path) => {
      const src = source(path);
      const press = src.slice(src.indexOf('const handleRedeemBooking'));
      expect(press.slice(0, press.indexOf('};'))).toContain('setBookingRedeemHandoff(c.paidOnline.bookingId)');
      expect(press.slice(0, press.indexOf('};'))).not.toContain('setDropOffHandoff');
      expect(src).toContain('onRedeemBooking={handleRedeemBooking}');
    },
  );
});

describe('s730 — the Add drop-off picker', () => {
  const paid = shape(stay('c-paid', { paidOnline: PAID }));
  const sibling = shape(stay('c-sibling', { childName: 'Nok', allergies: null }));

  type PickerButton = ReactElement<{ disabled?: boolean; onClick?: () => void }>;
  const buttonIn = (node: ReactNode): PickerButton | null => {
    if (Array.isArray(node)) {
      for (const item of node as ReactNode[]) {
        const found = buttonIn(item);
        if (found) return found;
      }
      return null;
    }
    if (!isValidElement(node)) return null;
    if (node.type === Button) return node as PickerButton;
    return buttonIn((node.props as { children?: ReactNode }).children);
  };

  /** The family's row, rendered as a person reads it, and its one button pressed through its own handler. */
  const picker = (children: CheckIn[], attached: string[] = []) => {
    const added = vi.fn<(children: CheckIn[]) => void>();
    const group: RegistrationGroup = {
      registrationId: REG,
      parentName: 'Khun Mali',
      phone: '+66812345678',
      children,
    };
    const props = { group, attached: new Set(attached), onAddToSale: added };
    return {
      html: renderToStaticMarkup(createElement(WaitingFamily, props)),
      press: () => buttonIn(WaitingFamily(props))?.props.onClick?.(),
      added,
    };
  };
  const enabled = (label: string) => new RegExp(`<button(?![^>]* disabled="")[^>]*>${label}</button>`);
  const disabled = (label: string) => new RegExp(`<button[^>]* disabled=""[^>]*>${label}</button>`);

  it('a family who all paid online reads Paid online, and its button adds nobody', () => {
    const { html, press, added } = picker([paid]);
    expect(html).toMatch(disabled('Paid online'));
    expect(html.match(/Paid online/g)).toHaveLength(2);
    press();
    expect(added).not.toHaveBeenCalled();
  });

  it('a sibling beside a paid child stays addable, and the press adds the sibling alone', () => {
    const { html, press, added } = picker([paid, sibling]);
    expect(html).toMatch(enabled('Add to sale'));
    expect(html.match(/Paid online/g)).toHaveLength(1);
    expect(html.indexOf('Paid online')).toBeLessThan(html.indexOf('Nok'));
    press();
    expect(added).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledWith([sibling]);
  });

  it('once the sibling is on the sale there is nothing left to add', () => {
    const { html, press, added } = picker([paid, sibling], [sibling.id]);
    expect(html).toMatch(disabled('Added'));
    expect(html).toContain('In sale');
    press();
    expect(added).not.toHaveBeenCalled();
  });

  it('a family with nothing paid online reads as it did', () => {
    const { html, press, added } = picker([sibling]);
    expect(html).toMatch(enabled('Add to sale'));
    expect(html).not.toContain('Paid online');
    press();
    expect(added).toHaveBeenCalledWith([sibling]);
  });
});

describe('s730 — the redeem dialog, opened with nothing scanned', () => {
  it.each([
    ['a booking this till cannot find', new ApiError(404, 'BOOKING_NOT_FOUND', 'Not here'), 'This booking could not be found.'],
    [
      'no connection',
      new NetworkError(),
      'No connection to the platform, so this booking cannot be checked. Nothing has been issued.',
    ],
    [
      'a deployment with no such route',
      new ApiError(404, 'ROUTE_NOT_FOUND', 'Not here'),
      'This deployment has no booking lookup yet (SCRUM-234), so this booking cannot be checked here.',
    ],
    ['anything else', new Error('boom'), 'This booking could not be checked.'],
  ])('%s is said without naming a scan', (_case, err, words) => {
    expect(openedBookingFailure(err)).toBe(words);
    expect(words).not.toMatch(/scan|QR/i);
  });

  it('a QR that fails its signature check still says what the platform said', () => {
    const refused = new ApiError(400, BOOKING_QR_SIGNATURE_INVALID, 'That QR did not come from OTO.');
    expect(openedBookingFailure(refused)).toBe('That QR did not come from OTO.');
  });
});
