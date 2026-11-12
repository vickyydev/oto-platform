import { readFileSync } from 'node:fs';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { apiCheckinToCheckIn, type ApiCheckin, type ApiRegistration } from '@/api/checkin';
import { WaitingFamily, type RegistrationGroup } from '@/components/till/AddDropOffModal';

/**
 * SCRUM-888 — THE CANCEL BOOKING BUTTON FITS IN THE FAMILY CARD.
 *
 * Found in the SCRUM-871 staging proof (picture 03e): at 1680 wide the Add
 * drop-off child window cut a waiting family's "Cancel booking" off at the
 * card's right edge ("Cancel book"). Two causes, both in the window:
 *
 * - Radix lays a scroll area's content out as a table, as wide as the
 *   content's narrowest possible layout: a family name that never wraps
 *   (`truncate`) beside two buttons made the card wider than the window, and
 *   the window cut its right end off. As a block, the list is the window's
 *   width (the override StepConfirmation and the F&B and shop carts use).
 * - With the card bounded, the row still has to share it: on a wide card the
 *   name keeps the room it needs and the buttons take the rest, Cancel
 *   booking going under Add to sale when both do not fit; on a narrow card
 *   (the phone till) the buttons sit under the name.
 *
 * Where each element lands is measured in a browser, at 1680 x 1050, 1440 x 900
 * and on the phone till (e2e/dropoff-picker-fits.spec.ts); this pins the markup
 * that gives it, and what the card says is unchanged (s862 covers the rules).
 */

// The card is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const REG = '0190a0a0-0000-7000-8000-00000000a888';
const BRANCH = '0190a0a0-0000-7000-8000-0000000000b1';

const stay = (id: string): ApiCheckin => ({
  id, registrationId: REG, childId: null, childName: 'ZZ TEST Kai', childAgeYears: 3, dateOfBirth: null,
  allergies: null, foodRestrictions: null, mayOrderFood: false, foodProvision: null, service: 'drop_off',
  status: 'registered', scheduledFor: null, bookedMinutes: 120, nannyId: null, checkedInAt: null, saleId: null,
  bandId: null, visitId: null, photoFileId: null,
});
const registration = (children: ApiCheckin[]): ApiRegistration => ({
  id: REG, branchId: BRANCH, memberId: null, guardianName: 'ZZ TEST SCRUM-888 guardian nanny05',
  guardianPhone: '+66898880888', contactChannel: 'whatsapp', consentRecordedAt: '2026-11-12T02:00:00.000Z',
  acknowledgedConfirmations: [], source: 'till', photoFileId: null, createdAt: '2026-11-12T02:00:00.000Z', children,
});
const group = (): RegistrationGroup => {
  const children = [stay('c1')];
  return {
    registrationId: REG, parentName: 'ZZ TEST SCRUM-888 guardian nanny05', phone: '+66898880888',
    children: children.map((c) => apiCheckinToCheckIn(c, registration(children))),
  };
};
const card = (attached: string[] = []) => renderToStaticMarkup(
  createElement(WaitingFamily, { group: group(), attached: new Set(attached), onAddToSale: () => {}, onCancel: () => {} }),
);

/** The element whose class list is exactly these classes, with what it holds up to the next of its kind. */
const classed = (markup: string, classes: string) => {
  const at = markup.indexOf(`class="${classes}"`);
  expect(at, classes).toBeGreaterThan(-1);
  return markup.slice(at);
};

describe('SCRUM-888 — the family card shares its row', () => {
  const markup = card();

  it('the header measures its own width: two columns on a wide card, one on a narrow one', () => {
    const header = classed(markup, '@container');
    expect(header).toMatch(/^class="@container"><div class="grid grid-cols-1 @md:grid-cols-\[minmax\(0,max-content\)_minmax\(min-content,1fr\)\] items-start gap-3">/);
  });

  it('the name gives way only to what the buttons cannot do without, and is cut short with an ellipsis', () => {
    expect(markup).toContain('<div class="min-w-0"><div class="font-bold truncate">ZZ TEST SCRUM-888 guardian nanny05&#x27;s booking</div>');
  });

  it('both buttons share one row that wraps from the right: Cancel booking goes under Add to sale', () => {
    const row = classed(markup, 'flex flex-wrap justify-end gap-2');
    const addAt = row.indexOf('Add to sale</button>');
    const cancelAt = row.indexOf('Cancel booking</button>');
    expect(addAt).toBeGreaterThan(0);
    expect(cancelAt).toBeGreaterThan(addAt);
    // Nothing else sits between them: the row closes after Cancel booking.
    expect(row.slice(cancelAt)).toMatch(/^Cancel booking<\/button><\/div>/);
    // The buttons themselves are as they were.
    expect(markup).toContain('shrink-0 gap-1.5');
  });

  it('the reason a cancel is held back stays under the buttons, at the right', () => {
    const held = card(['c1']);
    const column = classed(held, 'flex flex-col items-end gap-1');
    expect(column.indexOf('Take the children off this sale first.')).toBeGreaterThan(column.indexOf('Cancel booking</button>'));
  });

  it("the window's list is the window's width, not the table Radix draws", () => {
    const picker = readFileSync(new URL('../src/components/till/AddDropOffModal.tsx', import.meta.url), 'utf8');
    expect(picker).toContain('<ScrollArea className="max-h-[60vh] -mx-2 px-2 [&_[data-radix-scroll-area-viewport]>div]:!block">');
  });
});
