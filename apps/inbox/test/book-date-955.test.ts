// @vitest-environment jsdom
//
// SCRUM-955 — Book Date: an empty count does not read as 0, and a count the
// chat reads two ways is chosen before saving.
//
// Found in the staging proof of SCRUM-947 (docs/qa/proof-2026-11-12/SCRUM-947,
// picture 06): the chat said "10 kids" and later "12 kids", the window offered
// both readings of the kids, and while it waited the "# of kids" and "# of
// adults" boxes were empty with a grey "0" in them, which read as 0 kids at a
// glance. "Book date" stood ready beside them. Now:
//   - an empty count box shows the window's dash (as "Turning (age)" does),
//     never a 0; a 0 the chat states or staff type still shows as 0;
//   - while a field is read two ways and staff have neither picked a reading
//     nor typed their own, "Book date" is disabled and one line beside it says
//     what it waits for (the window's own words for it, `pendingChoice`); a
//     pick or a typed value frees it at once, and emptying the box again
//     opens the two readings again;
//   - a party with no count at all (the chat names none, nothing two ways)
//     books exactly as before.
// The pure rules, the dialog rendered with react-dom/server, and the dialog in
// jsdom (a press on a reading, a typed figure). Every assert takes a string or
// a boolean, never a node.
//
// FICTIONAL TEST DATA: "ZZ TEST" names, invented lines.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookDateProposal, ConversationRow, Message } from '@/api/inbox';
import { BookDateDialog, readDraft, type BookDateValues } from '@/components/BookDateDialog';
import {
  bookDateDraft,
  editBookDate,
  freshBookDate,
  mergeBookDateProposal,
  parseBeoFromConversation,
  pendingChoice,
  pickBookDateChoice,
  type BookDateDraft,
} from '@/lib/beo';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const CHALONG = '00000000-0000-7000-8000-00000000000d';
const BRANCHES = [
  { value: CENTRAL, label: 'Central Floresta' },
  { value: CHALONG, label: 'Chalong' },
];
const BRANCH_IDS = BRANCHES.map((b) => b.value);
const TODAY = '2026-11-12';
const FAMILY_LINE = '0192f0a0-1234-7abc-8def-000000000101';

function row(language: string): ConversationRow {
  return {
    id: '0192f0a0-1234-7abc-8def-0123456789ab',
    channel: 'whatsapp',
    channelAccountId: '0192f0a0-1234-7abc-8def-0000000000a1',
    channelAccountName: 'Reception · Central Floresta',
    canReply: true,
    contact: { id: '0192f0a0-1234-7abc-8def-0123456789ac', channel: 'whatsapp', handle: '+66812345678', displayName: 'ZZ TEST 955', phone: '+66812345678', language, erased: false },
    category: 'birthdays',
    intent: 'birthday party',
    language,
    branchId: CENTRAL,
    teamId: '00000000-0000-7000-8000-0000000000b1',
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-11-12T15:25:22.742Z',
    lastMessagePreview: '',
    unanswered: true,
    unread: 1,
    mine: true,
    assignments: [],
    createdAt: '2026-11-12T15:25:22.742Z',
  };
}

let seq = 10;
function msg(body: string): Message {
  seq += 1;
  return {
    id: `0192f0a0-1234-7abc-8def-0000000955${seq}`,
    direction: 'inbound',
    authorKind: 'customer',
    authorAccountId: null,
    authorName: null,
    body,
    bodyLanguage: null,
    translatedBody: null,
    translatedTo: null,
    mediaFileIds: [],
    audioFileId: null,
    transcript: null,
    transcriptStatus: null,
    transcriptLanguage: null,
    templateId: null,
    providerStatus: null,
    source: 'channel',
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    redacted: false,
    createdAt: '2026-11-12T15:25:22.742Z',
  };
}

/** The dialog's first values, as ChatPanel computes them when Book Date opens. */
const draftOf = (messages: Message[]) => bookDateDraft(parseBeoFromConversation(row('en'), messages, TODAY), TODAY, CENTRAL);

type Proposal = NonNullable<BookDateProposal['proposal']>;
const family = <T,>(value: T, text: string) => ({ value, text, source: 'family' as const, messageId: FAMILY_LINE });

function answer(proposal: Partial<Proposal>): BookDateProposal {
  return {
    conversationId: row('en').id,
    model: 'ai',
    proposal: { date: null, startTime: null, kids: null, adults: null, childName: null, childAge: null, branchHint: null, ...proposal } as Proposal,
    patternReading: { date: null, dateText: '', source: null, startTime: null, timeText: '' },
  };
}

function dialog(initial: BookDateDraft, proposal: BookDateProposal | null, reading = false): string {
  return renderToStaticMarkup(
    createElement(BookDateDialog, {
      open: true,
      customer: 'ZZ TEST 955',
      initial,
      branches: BRANCHES,
      busy: false,
      error: null,
      thenOpensBeo: false,
      onCancel: () => undefined,
      onSave: () => undefined,
      proposal,
      reading,
    }),
  );
}

/** The `<input …>` tag named `label`, as rendered. */
function inputTag(html: string, label: string): string {
  return new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';
}

/** The `<button …>…</button>` whose text is exactly `text`. */
function buttonNamed(html: string, text: string): string {
  const re = /<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs;
  for (const m of html.matchAll(re)) if (m[0].replace(/<[^>]+>/g, '').trim() === text) return m[0];
  return '';
}

/** A button that carries the disabled attribute (not the `disabled:` style). */
const DISABLED = / disabled=""/;

// The proof's thread P6: "10 kids" first, "12 kids" later. The pattern reading
// takes the first, the model the later: the kids are read two ways.
const P6 = [msg('Hi, a party on 12 December at 13:00 for 10 kids (ZZ TEST)'), msg('sorry, 12 kids, not 10 (ZZ TEST)')];
const P6_MODEL = answer({
  date: family('2026-12-12', '12 December'),
  startTime: family('13:00', 'at 13:00'),
  kids: family(12, '12 kids'),
});
const KIDS_WAIT = 'The chat reads two ways for the number of kids: choose one.';

// A chat that names no count at all, and nothing two ways.
const NO_COUNT = [msg('Hi, a party on 12 December at 13:00 please (ZZ TEST)')];
const NO_COUNT_MODEL = answer({ date: family('2026-12-12', '12 December'), startTime: family('13:00', 'at 13:00') });

describe('an empty count shows no figure', () => {
  it('the kids and adults boxes, empty, show the window’s dash (as the age does), never a 0', () => {
    const draft = draftOf(NO_COUNT);
    expect(draft.kids).toBe('');
    expect(draft.adults).toBe('');
    const html = dialog(draft, NO_COUNT_MODEL);
    expect(html).not.toContain('placeholder="0"');
    expect(inputTag(html, 'Kids')).toContain('value=""');
    expect(inputTag(html, 'Kids')).toContain('placeholder="—"');
    expect(inputTag(html, 'Adults')).toContain('value=""');
    expect(inputTag(html, 'Adults')).toContain('placeholder="—"');
    // The same mark the window already gives an empty age.
    expect(inputTag(html, 'Turning age')).toContain('placeholder="—"');
  });

  it('while the kids are read two ways (the proof’s picture 06), both boxes are empty and neither shows a 0', () => {
    const html = dialog(draftOf(P6), P6_MODEL);
    expect(html).toContain('data-choice="kids"');
    expect(inputTag(html, 'Kids')).toContain('value=""');
    expect(inputTag(html, 'Adults')).toContain('value=""');
    expect(html).not.toContain('placeholder="0"');
  });

  it('while the model reads, the boxes still say "reading…"', () => {
    const html = dialog(draftOf(NO_COUNT), null, true);
    expect(inputTag(html, 'Kids')).toContain('placeholder="reading…"');
    expect(inputTag(html, 'Adults')).toContain('placeholder="reading…"');
  });
});

describe('a real 0 still shows as 0', () => {
  it('a 0 the chat states, read by the pattern ("0 kids")', () => {
    const draft = draftOf([msg('0 kids at 13:00 on 12 December, just adults (ZZ TEST)')]);
    expect(draft.kids).toBe('0');
    const html = dialog(draft, null);
    expect(inputTag(html, 'Kids')).toContain('value="0"');
    expect(readDraft(draft)).toMatchObject({ values: { kids: 0 } });
  });

  it('a 0 the chat states, read by the model ("no adults")', () => {
    const draft = draftOf(NO_COUNT);
    const noAdults = answer({ adults: family(0, 'no adults') });
    const merged = mergeBookDateProposal(freshBookDate(draft), noAdults, BRANCH_IDS);
    expect(merged.draft.adults).toBe('0');
    expect(pendingChoice(merged)).toBeNull();
    const html = dialog(draft, noAdults);
    expect(inputTag(html, 'Adults')).toContain('value="0"');
    expect(html).toContain('The chat says “no adults”');
    expect(readDraft(merged.draft)).toMatchObject({ values: { adults: 0 } });
  });

  it('a 0 staff type', () => {
    const typed = editBookDate(freshBookDate(draftOf(NO_COUNT)), 'adults', '0');
    expect(typed.draft.adults).toBe('0');
    expect(readDraft(typed.draft)).toMatchObject({ values: { adults: 0 } });
    expect(inputTag(dialog(typed.draft, null), 'Adults')).toContain('value="0"');
  });
});

describe('a count the chat reads two ways is chosen before Book date saves', () => {
  it('while the choice is open, "Book date" is disabled and one line says what it waits for', () => {
    const merged = mergeBookDateProposal(freshBookDate(draftOf(P6)), P6_MODEL, BRANCH_IDS);
    expect(merged.choices.kids?.map((o) => o.value)).toEqual(['12', '10']);
    expect(pendingChoice(merged)).toBe(KIDS_WAIT);
    const html = dialog(draftOf(P6), P6_MODEL);
    expect(buttonNamed(html, 'Book date')).toMatch(DISABLED);
    expect(html).toContain(`data-testid="book-date-waiting">${KIDS_WAIT}<`);
    // Opened from Create BEO, the same.
    const beo = renderToStaticMarkup(
      createElement(BookDateDialog, {
        open: true,
        customer: 'ZZ TEST 955',
        initial: draftOf(P6),
        branches: BRANCHES,
        busy: false,
        error: null,
        thenOpensBeo: true,
        onCancel: () => undefined,
        onSave: () => undefined,
        proposal: P6_MODEL,
        reading: false,
      }),
    );
    expect(buttonNamed(beo, 'Book date and open the BEO')).toMatch(DISABLED);
  });

  it('with nothing two ways, "Book date" is ready and no line waits', () => {
    const html = dialog(draftOf(NO_COUNT), NO_COUNT_MODEL);
    expect(buttonNamed(html, 'Book date')).not.toBe('');
    expect(buttonNamed(html, 'Book date')).not.toMatch(DISABLED);
    expect(html).not.toContain('book-date-waiting');
  });

  it('a pick frees it; so does a typed figure', () => {
    const merged = mergeBookDateProposal(freshBookDate(draftOf(P6)), P6_MODEL, BRANCH_IDS);
    const picked = pickBookDateChoice(merged, 'kids', merged.choices.kids![1]!);
    expect(picked.draft.kids).toBe('10');
    expect(pendingChoice(picked)).toBeNull();
    const typed = editBookDate(merged, 'kids', '11');
    expect(typed.draft.kids).toBe('11');
    expect(pendingChoice(typed)).toBeNull();
  });

  it('a typed figure emptied again opens the two readings again: the count is still not chosen', () => {
    const merged = mergeBookDateProposal(freshBookDate(draftOf(P6)), P6_MODEL, BRANCH_IDS);
    const typed = editBookDate(merged, 'kids', '1');
    const emptied = editBookDate(typed, 'kids', '');
    expect(emptied.draft.kids).toBe('');
    expect(emptied.choices.kids).toEqual(merged.choices.kids);
    expect(emptied.edited).not.toContain('kids');
    expect(pendingChoice(emptied)).toBe(KIDS_WAIT);
    // Spaces only are no figure either.
    expect(pendingChoice(editBookDate(typed, 'kids', '  '))).toBe(KIDS_WAIT);
    // And it is chosen as before.
    expect(pendingChoice(pickBookDateChoice(emptied, 'kids', emptied.choices.kids![0]!))).toBeNull();
    expect(pendingChoice(editBookDate(emptied, 'kids', '9'))).toBeNull();
  });

  it('a blank first key (a space) on a box read two ways settles nothing: the readings stay and Save waits', () => {
    const merged = mergeBookDateProposal(freshBookDate(draftOf(P6)), P6_MODEL, BRANCH_IDS);
    const spaced = editBookDate(merged, 'kids', ' ');
    expect(pendingChoice(spaced)).toBe(KIDS_WAIT);
    expect(spaced.choices.kids).toEqual(merged.choices.kids);
    expect(spaced.edited).not.toContain('kids');
    expect(readDraft(spaced.draft)).toMatchObject({ values: { kids: null } });
    // A figure typed after the space settles it as any typed figure does.
    const typed = editBookDate(spaced, 'kids', ' 9');
    expect(pendingChoice(typed)).toBeNull();
    expect(readDraft(typed.draft)).toMatchObject({ values: { kids: 9 } });
    // The same for the child's name: spaces are no name.
    const names = mergeBookDateProposal(
      freshBookDate({ ...draftOf(P6), childName: 'ZZ Test Mia' }),
      answer({ childName: family('ZZ Test Nina', 'ZZ Test Nina') }),
      BRANCH_IDS,
    );
    const blankName = editBookDate(names, 'childName', '  ');
    expect(pendingChoice(blankName)).toBe("The chat reads two ways for the child's name: choose one.");
    expect(blankName.choices.childName).toEqual(names.choices.childName);
  });
});

describe('every other field the window reads two ways is held the same way', () => {
  const base = draftOf(P6);
  const cases: { field: string; label: string; initial: BookDateDraft; model: BookDateProposal }[] = [
    { field: 'adults', label: 'number of adults', initial: { ...base, adults: '4' }, model: answer({ adults: family(6, '6 adults') }) },
    { field: 'date', label: 'date', initial: base, model: answer({ date: family('2026-12-19', '19 December') }) },
    { field: 'startTime', label: 'start time', initial: base, model: answer({ startTime: family('15:00', 'at 3pm') }) },
    { field: 'branchId', label: 'park', initial: base, model: answer({ branchHint: family(CHALONG, 'at Chalong') }) },
    { field: 'childName', label: "child's name", initial: { ...base, childName: 'ZZ Test Mia' }, model: answer({ childName: family('ZZ Test Nina', 'ZZ Test Nina') }) },
    { field: 'childAge', label: 'age', initial: { ...base, childAge: '5' }, model: answer({ childAge: family(6, 'turning 6') }) },
  ];
  it.each(cases)('the $field: Book date waits for a choice, with the window’s line for it', ({ label, initial, model }) => {
    const wait = `The chat reads two ways for the ${label}: choose one.`;
    // The model says nothing of the kids here: only this field is read two ways.
    expect(pendingChoice(mergeBookDateProposal(freshBookDate(initial), model, BRANCH_IDS))).toBe(wait);
    const html = dialog(initial, model);
    expect(buttonNamed(html, 'Book date')).toMatch(DISABLED);
    // The markup writes the apostrophe of "child's name" as &#x27;.
    expect(html).toContain(`data-testid="book-date-waiting">${wait.replace(/'/g, '&#x27;')}<`);
  });
});

describe('a party with no count at all still books as before', () => {
  it('no count in the chat, nothing two ways, the boxes left empty: Save sends no kids and no adults', () => {
    const merged = mergeBookDateProposal(freshBookDate(draftOf(NO_COUNT)), NO_COUNT_MODEL, BRANCH_IDS);
    expect(pendingChoice(merged)).toBeNull();
    expect(readDraft(merged.draft)).toMatchObject({ values: { kids: null, adults: null, date: '2026-12-12', startTime: '13:00' } });
  });
});

describe('the dialog in a page: a pick or a typed figure frees Book date at once', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const saved = vi.fn<(values: BookDateValues) => void>();
  beforeEach(() => {
    saved.mockReset();
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

  const render = (initial: BookDateDraft, proposal: BookDateProposal | null) =>
    act(async () => {
      root!.render(
        createElement(BookDateDialog, {
          open: true,
          customer: 'ZZ TEST 955',
          initial,
          branches: BRANCHES,
          busy: false,
          error: null,
          thenOpensBeo: false,
          onCancel: () => undefined,
          onSave: saved,
          proposal,
          reading: false,
        }),
      );
    });
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  const bookButton = () => buttons().find((b) => b.textContent?.trim() === 'Book date');
  const bookDisabled = () => bookButton()?.disabled ?? null;
  const waiting = () => document.querySelector('[data-testid="book-date-waiting"]')?.textContent ?? null;
  const readingsOfKids = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-choice="kids"] button')).map((b) => b.textContent ?? '');
  const kidsBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Kids"]')!;
  const press = (pick: () => HTMLButtonElement | undefined) =>
    act(async () => {
      pick()?.click();
    });
  const type = (value: string) =>
    act(async () => {
      const box = kidsBox();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, value);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('the proof’s picture 06: held; a press on "10" frees it and Book date saves 10 kids', async () => {
    await render(draftOf(P6), P6_MODEL);
    expect(readingsOfKids().length).toBe(2);
    expect(bookDisabled()).toBe(true);
    expect(waiting()).toBe(KIDS_WAIT);
    // A press on the disabled button saves nothing.
    await press(bookButton);
    expect(saved.mock.calls.length).toBe(0);

    await press(() => buttons().find((b) => b.closest('[data-choice="kids"]') && b.textContent?.trim().startsWith('10')));
    expect(readingsOfKids().length).toBe(0);
    expect(kidsBox().value).toBe('10');
    expect(bookDisabled()).toBe(false);
    expect(waiting()).toBeNull();
    await press(bookButton);
    expect(saved.mock.calls.length).toBe(1);
    expect(saved.mock.calls[0]![0].kids).toBe(10);
  });

  it('a typed figure frees it; emptied, the readings come back and it is held again', async () => {
    await render(draftOf(P6), P6_MODEL);
    await type('11');
    expect(bookDisabled()).toBe(false);
    expect(waiting()).toBeNull();
    expect(readingsOfKids().length).toBe(0);

    await type('');
    expect(kidsBox().value).toBe('');
    expect(readingsOfKids().length).toBe(2);
    expect(bookDisabled()).toBe(true);
    expect(waiting()).toBe(KIDS_WAIT);

    await type('9');
    await press(bookButton);
    expect(saved.mock.calls.length).toBe(1);
    expect(saved.mock.calls[0]![0].kids).toBe(9);
  });

  it('a space typed first in the kids box leaves Book date held and the readings offered', async () => {
    await render(draftOf(P6), P6_MODEL);
    await type(' ');
    expect(readingsOfKids().length).toBe(2);
    expect(bookDisabled()).toBe(true);
    expect(waiting()).toBe(KIDS_WAIT);
    await press(bookButton);
    expect(saved.mock.calls.length).toBe(0);
  });

  it('a party with no count at all: ready at once, and Save sends no kids and no adults', async () => {
    await render(draftOf(NO_COUNT), NO_COUNT_MODEL);
    expect(bookDisabled()).toBe(false);
    expect(waiting()).toBeNull();
    await press(bookButton);
    expect(saved.mock.calls.length).toBe(1);
    expect(saved.mock.calls[0]![0].kids).toBeNull();
    expect(saved.mock.calls[0]![0].adults).toBeNull();
  });
});
