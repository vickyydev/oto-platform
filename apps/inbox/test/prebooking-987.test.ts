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
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Book date<\/button>/);
      if (state === null || state === 'requested')
        expect(html).toContain('A payment slip or staff receipt does not unlock booking.');
    }
  });
  it('a gateway receipt enables creation only at its own park; staff capacity guidance stays visible', () => {
    const html = renderToStaticMarkup(
      createElement(BookDateDialog, { ...props, initialDeposit: paid }),
    );
    const button =
      (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find((b) =>
        />Book date<\/button>$/.test(b),
      ) ?? '';
    expect(button).not.toBe('');
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
    expect(foreign).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Book date<\/button>/);
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
    expect(button('Book date').disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
    answer = { draft: { ...pending.draft!, state: 'paid', paidAt: paid.paidAt } };
    await act(async () => {
      button('Check payment').click();
    });
    expect(button('Book date').disabled).toBe(false);
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      button('Book date').click();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
