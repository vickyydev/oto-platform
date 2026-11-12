import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import { MobileChildDetail } from '@/components/mobile/dropoff/MobileChildDetail';
import type { CheckIn } from '@/types';

/**
 * SCRUM-901 — A LONG CHECK-IN LABEL STAYS INSIDE ITS BUTTON.
 *
 * SCRUM-886's staging proof, picture 07a: a large part-paid family's card on
 * the Check-in board, its second button "Check in ZZ TEST Sibling 496 age3,
 * ZZ TEST Sibling 496 age3 & ZZ TEST Sibling 496 age6 nanny" spilling above
 * and below its button beside Cancel booking: the label wraps (SCRUM-741) but
 * the button kept its fixed 44px. A button that names children now grows with
 * its label (at least 44px, 64px on the phone), and the cancel of a child on
 * their own wraps inside its button too; the boxes are measured in a browser
 * in `s884-split-view-measured.test.ts`. A one-word Check in keeps exactly
 * the classes it had, so the ordinary card does not move.
 */
// The cards are compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const markup = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const base = {
  registrationId: 'zz-test-496', parentName: 'ZZ TEST guardian 496', contactMethod: 'whatsapp' as const,
  phone: '+66898904960', mayOrderFood: false, confirmationsAccepted: true, serviceType: 'drop_off' as const,
  registeredAt: '2026-11-12T02:00:00.000Z', waConnection: { status: 'confirmed' as const },
};
const sib = (id: string, childName: string): CheckIn => ({ ...base, id, childName, childAge: 3, status: 'registered' });
const paidAtTill: CheckIn = { ...sib('c-496', 'ZZ TEST Child 496 C'), paidAtTill: { saleId: 'sale-496', receiptNumber: 'R-496' } };
const paidOnline: CheckIn = { ...sib('c-496', 'ZZ TEST Child 496 C'), paidOnline: { bookingId: 'b-496', reference: 'OTO-496', redeemed: false } };
const siblings = [sib('s1', 'ZZ TEST Sibling 496 age3'), sib('s2', 'ZZ TEST Sibling 496 age3'), sib('s3', 'ZZ TEST Sibling 496 age6 nanny')];
const noop = () => undefined;
const handlers = {
  onMessage: noop, onAssignNanny: noop, onCheckIn: noop, onCheckOut: noop, onCheckInBooked: noop,
  onRedeemBooking: noop, onEdit: noop, onResend: noop, onSimulateConfirm: noop, onMarkFailed: noop,
  onSaveAndResend: noop, onManagePickups: noop, onCancelBooking: noop,
};

/** The opening tag of the button whose text starts with `label`. */
function buttonTag(html: string, label: string): string | null {
  const at = html.indexOf(label);
  if (at < 0) return null;
  const open = html.lastIndexOf('<button', at);
  return open < 0 ? null : html.slice(open, html.indexOf('>', open) + 1);
}

describe("the desk board's family card", () => {
  const html = markup(createElement(FamilyCheckInCard, { family: [paidAtTill, ...siblings], ...handlers }));

  it('a Check in that names children grows with its label, at least 44px high', () => {
    const named = buttonTag(html, 'Check in ZZ TEST Sibling 496 age3, ZZ TEST Sibling 496 age3 & ZZ TEST Sibling 496 age6 nanny');
    expect(named).toContain('h-auto min-h-11 py-2 flex-1 min-w-[120px] gap-1.5');
    // No fixed 44px left on it (min-h-11 is the floor).
    expect(named).not.toMatch(/(?<![\w-])h-11(?![\w-])/);
    // The label is still the wrapping span SCRUM-741 gave it.
    expect(html).toContain('<span class="min-w-0 whitespace-normal break-words text-center leading-tight">Check in ZZ TEST Sibling 496 age3');
    expect(buttonTag(html, 'Check in ZZ TEST Child 496 C')).toContain('h-auto min-h-11 py-2');
  });

  it('Cancel booking keeps its button as it was', () => {
    expect(buttonTag(html, 'Cancel booking')).toContain('h-11 gap-1.5');
  });

  it('a family with one way in keeps its one-word Check in exactly as before', () => {
    const single = markup(createElement(FamilyCheckInCard, { family: [sib('one', 'ZZ TEST Single')], ...handlers }));
    const button = buttonTag(single, 'Check in');
    expect(button).toContain('h-11 flex-1 min-w-[120px] gap-1.5');
    expect(button).not.toContain('min-h-11');
  });
});

describe("the phone's family screen", () => {
  const html = markup(createElement(MobileChildDetail, { family: [paidOnline, ...siblings], onBack: noop, onMarkArrived: noop, ...handlers }));

  it('a Check In that names children grows with its label, at least 64px high', () => {
    const named = buttonTag(html, 'Check In ZZ TEST Sibling 496 age3');
    expect(named).toContain('w-full h-auto min-h-16 py-3 text-lg gap-2 rounded-2xl');
  });

  it('a plain Check In keeps its 64px button', () => {
    const single = markup(createElement(MobileChildDetail, { family: [sib('one', 'ZZ TEST Single')], onBack: noop, onMarkArrived: noop, ...handlers }));
    expect(buttonTag(single, 'Check In')).toContain('w-full h-16 text-lg gap-2 rounded-2xl');
  });
});
