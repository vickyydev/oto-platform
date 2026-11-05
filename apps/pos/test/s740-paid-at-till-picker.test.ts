import React, { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCheckinToCheckIn,
  paidAtTillOf,
  waitingStaysOf,
  type ApiCheckin,
  type ApiRegistration,
} from '@/api/checkin';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import { WaitingFamily, type RegistrationGroup } from '@/components/till/AddDropOffModal';
import { Button } from '@/components/ui/button';
import { familyCheckInActions } from '@/lib/dropoff';
import type { CheckIn } from '@/types';

/**
 * SCRUM-740 — A CHILD PAID FOR AT THE TILL IS NEVER A SECOND LINE TO CHARGE.
 *
 * SCRUM-730 kept a child paid for online off every sale but their booking's.
 * A child paid for at the counter, but not yet checked in, was still listed in
 * the Add drop-off picker with Add to sale. The picker now reads the
 * platform's `paidAtTill` (or, on a box copy without it, the sale "Leave as
 * booked" filed), lists the child as paid, and the board checks them in on that
 * sale with no payment. `fetch` is stubbed at the boundary, as s730 does.
 */

// The card is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const BRANCH = '0190a0a0-0000-7000-8000-0000000000b1';
const REG = '0190a0a0-0000-7000-8000-00000000a740';
const SALE = '0190a0a0-0000-7000-8000-00000000b740';
const PAID = { saleId: SALE, receiptNumber: 'T1-000042' };

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
  branchId: BRANCH,
  memberId: null,
  guardianName: 'ZZ TEST Ploy',
  guardianPhone: '+66812345678',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-11-05T02:00:00.000Z',
  acknowledgedConfirmations: [],
  source: 'pos',
  photoFileId: null,
  createdAt: '2026-11-05T02:00:00.000Z',
  children,
});

const shape = (c: ApiCheckin): CheckIn => apiCheckinToCheckIn(c, registration([c]));

describe('s740 — which waiting child a till sale already paid for', () => {
  it('reads the platform, which names a payment whose choice was never made', () => {
    expect(paidAtTillOf(stay('c1', { paidAtTill: PAID }))).toEqual(PAID);
    expect(shape(stay('c1', { paidAtTill: PAID })).paidAtTill).toEqual(PAID);
  });

  it('reads the sale "Leave as booked" filed when a box copy carries no answer', () => {
    expect(paidAtTillOf(stay('c1', { saleId: SALE, scheduledFor: '2026-11-05T03:00:00.000Z' }))).toEqual({
      saleId: SALE,
      receiptNumber: null,
    });
  });

  it("takes the platform's no for a sale since voided or refunded", () => {
    expect(paidAtTillOf(stay('c1', { saleId: SALE, paidAtTill: null }))).toBeNull();
  });

  it('leaves a child paid for online to SCRUM-730, and a child on no sale as a walk-up', () => {
    const online = stay('c1', { paidOnline: { bookingId: SALE, reference: 'OTO-AB12-3456' }, saleId: SALE });
    expect(paidAtTillOf(online)).toBeNull();
    expect(paidAtTillOf(stay('c2'))).toBeNull();
    expect(shape(stay('c2')).paidAtTill).toBeUndefined();
  });
});

describe("s740 — the till's load path", () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          registrations: [
            registration([
              stay('c-paid-no-choice', { paidAtTill: PAID }),
              stay('c-left-booked', { childName: 'ZZ TEST Bua', saleId: SALE, scheduledFor: '2026-11-05T03:00:00.000Z' }),
              stay('c-sibling', { childName: 'ZZ TEST Nok', paidAtTill: null }),
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

  it('never loads a child a till sale paid for as a line to charge, and still loads the sibling', async () => {
    const lines = await waitingStaysOf(BRANCH, REG);
    expect(lines.map((c) => c.id)).toEqual(['c-sibling']);
  });
});

describe('s740 — what the board offers', () => {
  it('checks a child paid at the till with no choice made in with no payment', () => {
    const child = shape(stay('c1', { paidAtTill: PAID }));
    expect(familyCheckInActions([child])).toEqual({ toRedeem: [], booked: [child], walkUp: [] });
  });

  it('leaves a walk-up as it was', () => {
    const walkUp = shape(stay('c1'));
    expect(familyCheckInActions([walkUp])).toEqual({ toRedeem: [], booked: [], walkUp: [walkUp] });
  });

  it("says booked and paid on the family's card, with one Check in", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(FamilyCheckInCard, {
        family: [shape(stay('c1', { paidAtTill: PAID }))],
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
    expect(html).toContain('Booked &amp; paid · no payment needed');
    expect(html.match(/Check in/g)).toHaveLength(1);
  });
});

describe('s740 — the Add drop-off picker', () => {
  const paid = shape(stay('c-paid', { paidAtTill: PAID }));
  const leftBooked = shape(stay('c-left', { childName: 'ZZ TEST Bua', saleId: SALE, scheduledFor: '2026-11-05T03:00:00.000Z' }));
  const sibling = shape(stay('c-sibling', { childName: 'ZZ TEST Nok', paidAtTill: null }));
  const online = shape(stay('c-online', { childName: 'ZZ TEST Tam', paidOnline: { bookingId: SALE, reference: 'OTO-AB12-3456' } }));

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
      parentName: 'ZZ TEST Ploy',
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

  it('a child paid at the till reads Paid at till with the receipt, and the button adds nobody', () => {
    const { html, press, added } = picker([paid]);
    expect(html).toMatch(disabled('Paid at till'));
    expect(html).toContain('Paid at till · T1-000042');
    expect(html).not.toMatch(/Add to sale/);
    press();
    expect(added).not.toHaveBeenCalled();
  });

  it('a child left as booked reads paid too, from the sale every copy carries', () => {
    const { html, press, added } = picker([leftBooked]);
    expect(html).toMatch(disabled('Paid at till'));
    press();
    expect(added).not.toHaveBeenCalled();
  });

  it('a sibling beside a child paid at the till stays addable, and the press adds the sibling alone', () => {
    const { html, press, added } = picker([paid, sibling]);
    expect(html).toMatch(enabled('Add to sale'));
    expect(html.match(/Paid at till/g)).toHaveLength(1);
    press();
    expect(added).toHaveBeenCalledWith([sibling]);
  });

  it('a family paid partly online and partly at the till reads Paid', () => {
    const { html, press, added } = picker([online, paid]);
    expect(html).toMatch(disabled('Paid'));
    expect(html).toContain('Paid online');
    expect(html).toContain('Paid at till · T1-000042');
    press();
    expect(added).not.toHaveBeenCalled();
  });

  it('a family with nothing paid reads as it did', () => {
    const { html, press, added } = picker([sibling]);
    expect(html).toMatch(enabled('Add to sale'));
    expect(html).not.toContain('Paid');
    press();
    expect(added).toHaveBeenCalledWith([sibling]);
  });
});
