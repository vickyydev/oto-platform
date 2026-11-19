// SCRUM-1016 — Book the date as BookDate.dc.html draws it: the deposit first,
// then the line that the fields were filled in from the chat, then large
// fields; where the chat reads a field two ways the question is asked plainly
// with both options, below the row, before Save; and Save names what it will
// book. Every rule of the dialog stays: the payment gate, Request deposit for
// those who may only, the test ids.
//
// FICTIONAL TEST DATA: every name is "ZZ TEST".
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BookDateProposal } from '@/api/inbox';
import { BookDateDialog, bookDateSaveLabel } from '@/components/BookDateDialog';
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
const base = {
  open: true,
  customer: 'ZZ TEST Sarah',
  initial,
  branches: [{ value: PARK, label: 'ZZ TEST park' }],
  busy: false,
  error: null,
  thenOpensBeo: false,
  onCancel: () => undefined,
  onSave: () => undefined,
};
const paid = paidPrebookingFixture(PARK);
const render = (over: Partial<Parameters<typeof BookDateDialog>[0]> = {}) =>
  renderToStaticMarkup(createElement(BookDateDialog, { ...base, ...over }));

/** The pattern read "at 2pm", the model "at 3pm" from the team: the start time reads two ways. */
const saidTwoWays: BookDateDraft = { ...initial, timeFrom: 'at 2pm' };
const twoTimes = {
  conversationId: '0192f0a0-1234-7abc-8def-0000000000e1',
  model: 'ai',
  proposal: {
    date: null,
    startTime: { value: '15:00', text: 'at 3pm', source: 'team', messageId: '0192f0a0-1234-7abc-8def-0000000000e2' },
    kids: null,
    adults: null,
    childName: null,
    childAge: null,
    branchHint: null,
  },
  patternReading: { date: null, dateText: '', source: null, startTime: null, timeText: '' },
} as unknown as BookDateProposal;

describe('SCRUM-1016: Book the date, laid out as drawn', () => {
  it('is titled "Book the date" with the family under it; the deposit comes first, then the chat line, then the fields', () => {
    const html = render({ initialDeposit: paid, onReadDeposit: async () => ({ draft: paid }) });
    expect(html).toContain('>Book the date</h2>');
    expect(html).toContain('ZZ TEST Sarah · birthday party');
    const deposit = html.indexOf('data-testid="prebooking-deposit"');
    const filled = html.indexOf('Filled in from the chat. Check each line before you book.');
    const date = html.indexOf('aria-label="Date"');
    expect(deposit).toBeGreaterThan(0);
    expect(filled).toBeGreaterThan(deposit);
    expect(date).toBeGreaterThan(filled);
    // Paid and verified on the green ground: the amount and the gateway's time.
    expect(html).toMatch(/data-testid="prebooking-deposit" class="[^"]*bg-money text-money-ink/);
    expect(html).toContain('Deposit ฿3,000 paid</strong> · verified 16 Nov, 19:00');
    // Paid: nothing left to request, Check payment stays.
    expect(html).not.toContain('>Request deposit<');
    expect(html).toContain('Check payment');
  });

  it('the fields are large and named by their labels as drawn', () => {
    const html = render({ initialDeposit: paid });
    for (const label of ['Date', 'Start time', 'Park', 'Children', 'Adults', 'Birthday child', 'Turning', 'Booking name', 'Phone']) {
      expect(html, label).toMatch(new RegExp(`aria-label="${label}"[^>]*class="min-h-12 `));
      expect(html, label).toContain(`>${label}</span>`);
    }
  });

  it('where the chat reads the start time two ways, the field says so and the question is asked with both options', () => {
    const html = render({ initialDeposit: paid, initial: saidTwoWays, proposal: twoTimes });
    const fieldset = /<fieldset data-choice="startTime"[^]*?<\/fieldset>/.exec(html)?.[0] ?? '';
    expect(fieldset).toContain('<legend');
    expect(fieldset).toContain('Which start time is right?');
    const options = fieldset.match(/<button type="button"[^>]*>[^]*?<\/button>/g) ?? [];
    expect(options.map((b) => b.replace(/<[^>]+>/g, ''))).toEqual(['15:00“at 3pm” · from the team', '14:00“at 2pm” · from the chat']);
    // SCRUM-1016 (review): a press picks the reading and the question goes;
    // the options act, they do not toggle, so none says "not pressed".
    expect(fieldset).not.toContain('aria-pressed');
    // The field wears the amber edge and the window's words; Save waits and says why.
    expect(html).toMatch(/aria-label="Start time" class="[^"]*border-2 border-ask-edge/);
    expect(html).toContain('The chat reads two ways: choose one');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="book-date-save"/);
    expect(html).toContain('data-testid="book-date-waiting">The chat reads two ways for the start time: choose one.<');
  });

  it('before payment: where the deposit stands, the agreed amount, and Request deposit only for those who may', () => {
    const asked = render({ initialDeposit: null, onRequestDeposit: async () => ({ draft: null }) });
    expect(asked).toContain('Gateway verification required. A payment slip or staff receipt does not unlock booking.');
    expect(asked).toContain('aria-label="Agreed deposit (baht)"');
    expect(asked).toContain('>Request deposit</button>');
    const agent = render({ initialDeposit: null });
    expect(agent).not.toContain('Request deposit<');
    expect(agent).toContain('A manager requests the agreed deposit. The birthdays team can book after gateway verification.');
    expect(agent).toMatch(/<button[^>]*disabled=""[^>]*data-testid="book-date-save"/);
  });

  it('Save names the day and time it books, with the year; "Book the date" until a date is chosen', () => {
    expect(bookDateSaveLabel({ date: '2026-12-19', startTime: '14:00' }, false)).toBe('Book Sat 19 Dec 2026, 14:00');
    expect(bookDateSaveLabel({ date: '2026-12-19', startTime: '' }, false)).toBe('Book Sat 19 Dec 2026');
    expect(bookDateSaveLabel({ date: '', startTime: '14:00' }, false)).toBe('Book the date');
    expect(bookDateSaveLabel({ date: '2026-12-19', startTime: '14:00' }, true)).toBe('Book Sat 19 Dec 2026, 14:00 and open the BEO');
    expect(render({ initialDeposit: paid })).toMatch(/data-testid="book-date-save"[^>]*>Book Sat 21 Nov 2099, 14:00<\/button>/);
  });

  it('carries no palette class of its own', () => {
    const html = render({ initialDeposit: paid, initial: saidTwoWays, proposal: twoTimes, onRequestDeposit: async () => ({ draft: null }) });
    expect(html).not.toMatch(/\b(?:bg|text|border|ring)-(?:slate|amber|indigo|emerald|violet|rose|teal)-\d/);
    expect(html).not.toMatch(/\bdark:/);
  });
});
