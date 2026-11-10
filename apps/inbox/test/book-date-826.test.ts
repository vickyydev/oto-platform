// @vitest-environment jsdom
//
// SCRUM-826 — "Fetch from chat" in Book Date: the dialog is open and the chat
// has moved on; a press reads the chat again (the SCRUM-821 model read, as it
// is now) and fills ONLY the fields the person has not typed in — a typed
// field stays, and the line under the button says what was filled and what
// was kept. A pending choice on an untouched field is settled by the fresh
// reading; an answer the model could not give changes nothing. The fetch as
// the pure function the dialog calls, and the dialog rendered with
// react-dom/server; then, in a DOM (the panel keeps the dialog mounted across
// birthday conversations), a fetch whose answer lands after the dialog was
// closed and opened again changes nothing — the first family's reading never
// fills the second family's Book Date.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BookDateProposal } from '@/api/inbox';
import { BookDateDialog, readDraft } from '@/components/BookDateDialog';
import {
  bookDateFetchLine,
  editBookDate,
  fetchBookDateProposal,
  freshBookDate,
  mergeBookDateProposal,
  pendingChoice,
  type BookDateDraft,
} from '@/lib/beo';

const CONVERSATION = '0192f0a0-1234-7abc-8def-0123456789ab';
const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const CHALONG = '00000000-0000-7000-8000-00000000000d';
const BRANCHES = [
  { value: CENTRAL, label: 'Central Floresta' },
  { value: CHALONG, label: 'Chalong' },
];
const BRANCH_IDS = BRANCHES.map((b) => b.value);
const FAMILY_LINE = '0192f0a0-1234-7abc-8def-000000000101';
const TEAM_LINE = '0192f0a0-1234-7abc-8def-000000000102';

type Proposal = NonNullable<BookDateProposal['proposal']>;
const family = <T,>(value: T, text: string) => ({ value, text, source: 'family' as const, messageId: FAMILY_LINE });
const team = <T,>(value: T, text: string) => ({ value, text, source: 'team' as const, messageId: TEAM_LINE });

function answer(proposal: Partial<Proposal>): BookDateProposal {
  return {
    conversationId: CONVERSATION,
    model: 'ai',
    proposal: { date: null, startTime: null, kids: null, adults: null, childName: null, childAge: null, branchHint: null, ...proposal } as Proposal,
    patternReading: { date: null, dateText: '', source: null, startTime: null, timeText: '' },
  };
}
const UNAVAILABLE: BookDateProposal = {
  conversationId: CONVERSATION,
  model: 'unavailable',
  proposal: null,
  patternReading: { date: null, dateText: '', source: null, startTime: null, timeText: '' },
};

function dialog(initial: BookDateDraft, proposal: BookDateProposal | null, onFetch?: () => Promise<BookDateProposal>): string {
  return renderToStaticMarkup(
    createElement(BookDateDialog, {
      open: true,
      customer: 'ZZ TEST Olga',
      initial,
      branches: BRANCHES,
      busy: false,
      error: null,
      thenOpensBeo: false,
      onCancel: () => undefined,
      onSave: () => undefined,
      proposal,
      reading: false,
      onFetch,
    }),
  );
}

// The pattern reading when the dialog opened: "12 kids, sat 21 november 2pm" (it never reads adults).
const PATTERN: BookDateDraft = {
  date: '2026-11-21',
  dateFrom: 'sat 21 november',
  startTime: '14:00',
  timeFrom: '2pm',
  branchId: CENTRAL,
  kids: '12',
  adults: '',
  contactName: 'ZZ TEST Olga',
  phone: '+66812345678',
  childName: '',
  childAge: '7',
};
// The model's reading then: the same, with the adults and the child's name the pattern missed.
const FIRST_READ = answer({
  date: family('2026-11-21', 'sat 21 november'),
  startTime: family('14:00', '2pm'),
  kids: family(12, '12 kids'),
  adults: family(4, '4 adults'),
  childName: family('Emma', 'Emma'),
  childAge: family(7, 'turning 7'),
});
// Then the family wrote again (15 kids, 6 adults) and the team moved the start to 3pm.
const LATER_READ = answer({
  date: family('2026-11-21', 'sat 21 november'),
  startTime: team('15:00', 'let’s start at 3pm then'),
  kids: family(15, 'now 15 kids'),
  adults: family(6, '6 adults'),
  childName: family('Emma', 'Emma'),
  childAge: family(7, 'turning 7'),
});

/** The dialog as it stands after it opened and the first read was merged: nothing typed, no choice. */
const opened = () => mergeBookDateProposal(freshBookDate(PATTERN), FIRST_READ, BRANCH_IDS);

describe('Fetch from chat fills the fields the person has not touched', () => {
  it('the dialog as opened holds the first reading, nothing pending', () => {
    const state = opened();
    expect(state.draft).toMatchObject({ kids: '12', adults: '4', childName: 'Emma', startTime: '14:00', date: '2026-11-21' });
    expect(state.choices).toEqual({});
    expect(state.fetched).toBeNull();
  });

  it('a changed headcount and time replace the earlier reading, each with the chat’s new words; no choice is asked', () => {
    const fetched = fetchBookDateProposal(opened(), LATER_READ, BRANCH_IDS);
    expect(fetched.draft).toMatchObject({
      kids: '15',
      adults: '6',
      startTime: '15:00',
      timeFrom: 'let’s start at 3pm then',
      date: '2026-11-21',
      childName: 'Emma',
    });
    expect(fetched.sources.kids).toEqual({ text: 'now 15 kids', source: 'family' });
    expect(fetched.sources.startTime).toEqual({ text: 'let’s start at 3pm then', source: 'team' });
    expect(fetched.choices).toEqual({});
    expect(pendingChoice(fetched)).toBeNull();
    expect(fetched.fetched).toEqual({ read: true, filled: ['startTime', 'kids', 'adults'], kept: [] });
    expect(bookDateFetchLine(fetched.fetched!)).toBe('Filled from the chat: start time, number of kids, number of adults.');
    expect(readDraft(fetched.draft)).toMatchObject({ values: { kids: 15, adults: 6, startTime: '15:00', date: '2026-11-21' } });
  });

  it('a field the person typed stays as typed, and the line says it was kept; the others are still filled', () => {
    const typed = editBookDate(opened(), 'adults', '5');
    const fetched = fetchBookDateProposal(typed, LATER_READ, BRANCH_IDS);
    expect(fetched.draft.adults).toBe('5');
    // Under the typed value, the chat's words as it stands now (SCRUM-821's hint, refreshed).
    expect(fetched.sources.adults).toEqual({ text: '6 adults', source: 'family' });
    expect(fetched.draft.kids).toBe('15');
    expect(fetched.draft.startTime).toBe('15:00');
    expect(fetched.fetched).toEqual({ read: true, filled: ['startTime', 'kids'], kept: ['adults'] });
    expect(bookDateFetchLine(fetched.fetched!)).toBe('Filled from the chat: start time, number of kids · kept what you typed: number of adults.');
    expect(fetched.edited).toEqual(['adults']);
  });

  it('a typed field the chat agrees with is not called kept; the same chat fetched again fills nothing', () => {
    const typed = editBookDate(opened(), 'kids', '15');
    const fetched = fetchBookDateProposal(typed, LATER_READ, BRANCH_IDS);
    expect(fetched.fetched).toEqual({ read: true, filled: ['startTime', 'adults'], kept: [] });
    const again = fetchBookDateProposal(fetched, LATER_READ, BRANCH_IDS);
    expect(again.draft).toEqual(fetched.draft);
    expect(again.fetched).toEqual({ read: true, filled: [], kept: [] });
    expect(bookDateFetchLine(again.fetched!)).toBe('Nothing new in the chat.');
    const keptOnly = fetchBookDateProposal(editBookDate(again, 'adults', '7'), LATER_READ, BRANCH_IDS);
    expect(bookDateFetchLine(keptOnly.fetched!)).toBe('Nothing new in the chat · kept what you typed: number of adults.');
  });

  it('a pending choice on an untouched field is settled by the fresh reading; one the person settled by typing stays theirs', () => {
    // The two readings disagreed on the date when the dialog opened: 14 November (pattern) against 21 (model).
    const twoWays = mergeBookDateProposal(freshBookDate({ ...PATTERN, date: '2026-11-14', dateFrom: 'sat' }), FIRST_READ, BRANCH_IDS);
    expect(twoWays.choices.date).toBeDefined();
    expect(twoWays.draft.date).toBe('');
    const fetched = fetchBookDateProposal(twoWays, LATER_READ, BRANCH_IDS);
    expect(fetched.choices.date).toBeUndefined();
    expect(fetched.draft).toMatchObject({ date: '2026-11-21', dateFrom: 'sat 21 november' });
    expect(fetched.fetched!.filled).toContain('date');
    expect(pendingChoice(fetched)).toBeNull();

    const settled = editBookDate(twoWays, 'date', '2026-11-28');
    const kept = fetchBookDateProposal(settled, LATER_READ, BRANCH_IDS);
    expect(kept.draft.date).toBe('2026-11-28');
    expect(kept.fetched!.kept).toEqual(['date']);
  });

  it('a field the person emptied stays empty: an edited field is theirs even when blank', () => {
    const blanked = editBookDate(opened(), 'childName', '');
    const fetched = fetchBookDateProposal(blanked, LATER_READ, BRANCH_IDS);
    expect(fetched.draft.childName).toBe('');
    expect(fetched.fetched!.kept).toEqual(['childName']);
  });

  it('the park the chat names: another the person can choose is taken when untouched; one of nobody’s is the chat’s words only', () => {
    const chalong = fetchBookDateProposal(opened(), answer({ branchHint: family(CHALONG, 'at Chalong') }), BRANCH_IDS);
    expect(chalong.draft.branchId).toBe(CHALONG);
    expect(chalong.fetched!.filled).toEqual(['branchId']);
    expect(bookDateFetchLine(chalong.fetched!)).toBe('Filled from the chat: park.');
    const elsewhere = fetchBookDateProposal(opened(), answer({ branchHint: family(null, 'the Bangna one') }), BRANCH_IDS);
    expect(elsewhere.draft.branchId).toBe(CENTRAL);
    expect(elsewhere.parkHint).toEqual({ text: 'the Bangna one', source: 'family' });
    expect(elsewhere.fetched!.filled).toEqual([]);
  });

  it('the model unavailable, or no answer at all, changes nothing and the line says so', () => {
    const before = opened();
    for (const bad of [UNAVAILABLE, null]) {
      const fetched = fetchBookDateProposal(before, bad, BRANCH_IDS);
      expect(fetched.draft).toEqual(before.draft);
      expect(fetched.sources).toEqual(before.sources);
      expect(fetched.fetched).toEqual({ read: false, filled: [], kept: [] });
      expect(bookDateFetchLine(fetched.fetched!)).toBe('The chat could not be read again; nothing changed.');
    }
  });

  it('the fetched answer counts as merged, so the dialog’s own merge of it afterwards changes nothing more', () => {
    const fetched = fetchBookDateProposal(opened(), LATER_READ, BRANCH_IDS);
    expect(mergeBookDateProposal(fetched, LATER_READ, BRANCH_IDS)).toBe(fetched);
  });
});

describe('a fetch answered after the dialog was closed and opened again changes nothing', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }
  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  /** The dialog as the panel mounts it: one element, re-rendered open or closed with the conversation's own draft and read. */
  const render = (props: { open: boolean; initial: BookDateDraft; proposal: BookDateProposal | null; onFetch: () => Promise<BookDateProposal> }) =>
    act(async () => {
      root!.render(
        createElement(BookDateDialog, {
          open: props.open,
          customer: props.open ? 'ZZ TEST family' : 'ZZ TEST nobody',
          initial: props.initial,
          branches: BRANCHES,
          busy: false,
          error: null,
          thenOpensBeo: false,
          onCancel: () => undefined,
          onSave: () => undefined,
          proposal: props.proposal,
          reading: false,
          onFetch: props.onFetch,
        }),
      );
    });
  const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const click = (testId: string) =>
    act(async () => {
      document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
    });

  it('the first family’s reading, answered once the second family’s Book Date is open, fills none of its fields and says nothing', async () => {
    // Olga's conversation: the dialog open on her pattern reading; Fetch pressed, the model still reading.
    const olga = deferred<BookDateProposal>();
    await render({ open: true, initial: PATTERN, proposal: FIRST_READ, onFetch: () => olga.promise });
    expect(field('Kids').value).toBe('12');
    await click('button-fetch-from-chat');
    expect(document.querySelector('[data-testid="button-fetch-from-chat"]')?.textContent).toContain('Fetching from the chat…');

    // Cancel, then another family's conversation: a blank Book Date for Nok, nothing read yet.
    const NOK: BookDateDraft = { ...PATTERN, date: '', dateFrom: '', startTime: '', timeFrom: '', kids: '', adults: '', contactName: 'ZZ TEST Nok', phone: '+66899990000', childName: '', childAge: '' };
    const nok = deferred<BookDateProposal>();
    await render({ open: false, initial: PATTERN, proposal: FIRST_READ, onFetch: () => olga.promise });
    await render({ open: true, initial: NOK, proposal: null, onFetch: () => nok.promise });
    expect(field('Kids').value).toBe('');
    expect(field("Child's name").value).toBe('');
    expect(document.querySelector('[data-testid="button-fetch-from-chat"]')?.textContent).toBe('Fetch from chat');

    // Olga's reading lands now: 15 kids, 6 adults, Emma, 3pm. Nok's dialog takes none of it.
    olga.resolve(LATER_READ);
    await settle();
    expect(field('Kids').value).toBe('');
    expect(field('Adults').value).toBe('');
    expect(field("Child's name").value).toBe('');
    expect(field('Date').value).toBe('');
    expect(document.querySelector('[data-testid="book-date-fetched"]')).toBeNull();
    expect(document.body.textContent).not.toContain('now 15 kids');

    // Nok's own fetch, pressed here, is taken as before.
    await click('button-fetch-from-chat');
    nok.resolve(answer({ kids: family(8, '8 kids'), childName: family('Nam', 'Nam') }));
    await settle();
    expect(field('Kids').value).toBe('8');
    expect(field("Child's name").value).toBe('Nam');
    expect(document.querySelector('[data-testid="book-date-fetched"]')?.textContent).toBe("Filled from the chat: number of kids, child's name.");
  });

  it('the same conversation closed and opened again: a fetch answered in between is dropped too, and the fresh opening is as the panel gives it', async () => {
    const first = deferred<BookDateProposal>();
    await render({ open: true, initial: PATTERN, proposal: FIRST_READ, onFetch: () => first.promise });
    await click('button-fetch-from-chat');
    await render({ open: false, initial: PATTERN, proposal: FIRST_READ, onFetch: () => first.promise });
    await render({ open: true, initial: PATTERN, proposal: FIRST_READ, onFetch: () => first.promise });
    first.resolve(LATER_READ);
    await settle();
    expect(field('Kids').value).toBe('12');
    expect(field('Adults').value).toBe('4');
    expect(field('Start time').value).toBe('14:00');
    expect(document.querySelector('[data-testid="book-date-fetched"]')).toBeNull();
    expect(document.querySelector('[data-testid="button-fetch-from-chat"]')?.textContent).toBe('Fetch from chat');
  });
});

describe('the dialog shows the button', () => {
  it('"Fetch from chat" with a refresh icon, beside the read of the chat, when the panel gives it a fetch', () => {
    const html = dialog(PATTERN, FIRST_READ, () => Promise.resolve(LATER_READ));
    expect(html).toContain('data-testid="button-fetch-from-chat"');
    expect(html).toContain('Fetch from chat');
    expect(html).toContain('lucide-refresh-cw');
    expect(html).toContain('What you typed here stays.');
    expect(html).toContain('Read the whole chat');
    // No fetch yet: no line under it.
    expect(html).not.toContain('data-testid="book-date-fetched"');
  });

  it('no fetch given: no button, and the dialog is as SCRUM-821 left it', () => {
    const html = dialog(PATTERN, FIRST_READ);
    expect(html).not.toContain('Fetch from chat');
    expect(html).not.toContain('lucide-refresh-cw');
  });
});
