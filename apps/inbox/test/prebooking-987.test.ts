// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookDateDialog } from '@/components/BookDateDialog';
import type { Prebooking } from '@/api/inbox';
import type { BookDateDraft } from '@/lib/beo';
import { paidPrebookingFixture } from './paid-prebooking-fixture';

const PARK = '00000000-0000-7000-8000-00000000000c';
const initial: BookDateDraft = {
  date: '2099-11-21',
  dateFrom: '',
  startTime: '14:00',
  timeFrom: '',
  branchId: PARK,
  kids: '12',
  adults: '4',
  contactName: 'ZZ TEST parent',
  phone: '',
  childName: 'ZZ TEST child',
  childAge: '6',
};
const props = {
  open: true,
  customer: 'ZZ TEST parent',
  initial,
  branches: [{ value: PARK, label: 'ZZ TEST park' }],
  busy: false,
  error: null,
  thenOpensBeo: false,
  onCancel: () => undefined,
  onSave: () => undefined,
};
const paid = paidPrebookingFixture(PARK);
// SCRUM-1016: Save names what it books (BookDate.dc.html, "Book Sat 20 Dec, 14:00"), with the year.
const SAVE_WORDS = 'Book Sat 21 Nov 2099, 14:00';
const SAVE_DISABLED = /<button[^>]*disabled=""[^>]*data-testid="book-date-save"[^>]*>[^]*?Book Sat 21 Nov 2099, 14:00<\/button>/;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('SCRUM-987 payment gate in Book Date', () => {
  it('keeps creation disabled before payment, including expired/manual-review states', () => {
    for (const state of [null, 'requested', 'expired', 'failed', 'needs_review'] as const) {
      const html = renderToStaticMarkup(
        createElement(BookDateDialog, {
          ...props,
          initialDeposit: state ? { ...paid, state } : null,
        }),
      );
      expect(html).toMatch(SAVE_DISABLED);
      if (state === null || state === 'requested')
        expect(html).toContain('A payment slip or staff receipt does not unlock booking.');
    }
  });
  it('a gateway receipt enables creation only at its own park; staff capacity guidance stays visible', () => {
    const html = renderToStaticMarkup(
      createElement(BookDateDialog, { ...props, initialDeposit: paid }),
    );
    const button = /<button\b[^>]*data-testid="book-date-save"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button.replace(/<[^>]+>/g, '')).toBe(SAVE_WORDS);
    expect(button).not.toMatch(/\sdisabled=/);
    expect(html).toContain('check park capacity before booking');
    expect(html).toContain('Simulator test payment: no real bank deposit has been received.');
    const foreign = renderToStaticMarkup(
      createElement(BookDateDialog, {
        ...props,
        initialDeposit: {
          ...paid,
          booking: { ...paid.booking, branchId: '00000000-0000-7000-8000-00000000000d' },
        },
      }),
    );
    expect(foreign).toMatch(SAVE_DISABLED);
    // The deposit says which park it unlocks (SCRUM-1016).
    expect(foreign).toContain('Paid for another park');
    expect(foreign).toContain('booking unlocks at that park only.');
  });
  it('Check payment unlocks the button without saving; only the later staff press creates a booking', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const save = vi.fn();
    const pending: Prebooking = {
      draft: {
        ...paid,
        booking: { ...paid.booking, kids: 12, adults: 4 },
        state: 'requested',
        paidAt: null,
      },
    };
    let answer = pending;
    const read = vi.fn(async () => answer);
    await act(async () => {
      root!.render(createElement(BookDateDialog, { ...props, onSave: save, onReadDeposit: read }));
    });
    const button = (name: string) =>
      Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.trim() === name)!;
    expect(button(SAVE_WORDS).disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
    answer = { draft: { ...pending.draft!, state: 'paid', paidAt: paid.paidAt } };
    await act(async () => {
      button('Check payment').click();
    });
    expect(button(SAVE_WORDS).disabled).toBe(false);
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      button(SAVE_WORDS).click();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
