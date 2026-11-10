// SCRUM-821 — Book Date opens at once with the pattern reading of the chat,
// then merges the model's reading of the whole chat (typos, three languages):
// a field the person has not touched takes the model's value with the chat's
// words and whose line it was; a field the person edited is kept; a field the
// two readings disagree on shows both and the person picks; `unavailable`
// leaves the pattern reading as it was and says nothing more. Nothing is saved
// before Save. Node, no DOM: the merge as the pure functions the dialog calls,
// and the dialog rendered with react-dom/server.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BookDateProposal, ConversationRow, Message } from '@/api/inbox';
import { BookDateDialog, readDraft } from '@/components/BookDateDialog';
import {
  DEFAULT_START_TIME,
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
const ELSEWHERE = '00000000-0000-7000-8000-00000000000e';
const BRANCHES = [
  { value: CENTRAL, label: 'Central Floresta' },
  { value: CHALONG, label: 'Chalong' },
];
const BRANCH_IDS = BRANCHES.map((b) => b.value);
const TODAY = '2026-11-10'; // a Tuesday; 21 November is a Saturday
const FAMILY_LINE = '0192f0a0-1234-7abc-8def-000000000101';
const TEAM_LINE = '0192f0a0-1234-7abc-8def-000000000102';

function row(language: string): ConversationRow {
  return {
    id: '0192f0a0-1234-7abc-8def-0123456789ab',
    channel: 'whatsapp',
    channelAccountId: '0192f0a0-1234-7abc-8def-0000000000a1',
    channelAccountName: 'Reception · Central Floresta',
    canReply: true,
    contact: { id: '0192f0a0-1234-7abc-8def-0123456789ac', channel: 'whatsapp', handle: '+66812345678', displayName: 'ZZ TEST Olga', phone: '+66812345678', language, erased: false },
    category: 'birthdays',
    intent: 'birthday party',
    language,
    branchId: CENTRAL,
    teamId: '00000000-0000-7000-8000-0000000000b1',
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-11-10T03:00:00.000Z',
    lastMessagePreview: '',
    unanswered: true,
    unread: 1,
    mine: true,
    assignments: [],
    createdAt: '2026-11-10T02:00:00.000Z',
  };
}

let seq = 10;
function msg(body: string, authorKind: Message['authorKind'] = 'customer'): Message {
  seq += 1;
  return {
    id: `0192f0a0-1234-7abc-8def-0000000002${seq}`,
    direction: authorKind === 'customer' ? 'inbound' : 'outbound',
    authorKind,
    authorAccountId: null,
    authorName: null,
    body,
    bodyLanguage: null,
    translatedBody: null,
    translatedTo: null,
    mediaFileIds: [],
    audioFileId: null,
    transcript: null,
    templateId: null,
    providerStatus: null,
    source: 'channel',
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    redacted: false,
    createdAt: '2026-11-10T03:00:00.000Z',
  };
}

/** The dialog's first values, as ChatPanel computes them when Book Date opens. */
const draftOf = (language: string, messages: Message[]) =>
  bookDateDraft(parseBeoFromConversation(row(language), messages, TODAY), TODAY, CENTRAL);

type Proposal = NonNullable<BookDateProposal['proposal']>;
const family = <T,>(value: T, text: string) => ({ value, text, source: 'family' as const, messageId: FAMILY_LINE });
const team = <T,>(value: T, text: string) => ({ value, text, source: 'team' as const, messageId: TEAM_LINE });

function answer(proposal: Partial<Proposal>): BookDateProposal {
  return {
    conversationId: row('en').id,
    model: 'ai',
    proposal: { date: null, startTime: null, kids: null, adults: null, childName: null, childAge: null, branchHint: null, ...proposal } as Proposal,
    patternReading: { date: null, dateText: '', source: null, startTime: null, timeText: '' },
  };
}

const UNAVAILABLE: BookDateProposal = {
  conversationId: row('en').id,
  model: 'unavailable',
  proposal: null,
  patternReading: { date: null, dateText: '', source: null, startTime: null, timeText: '' },
};

function dialog(initial: BookDateDraft, proposal: BookDateProposal | null, reading = false): string {
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
      reading,
    }),
  );
}

// "12 kds and 4 adust, sat 21 novmber 2pm": the pattern reading misses the kids
// and the adults (spelled wrong) and reads "sat" as the next Saturday.
const ENGLISH_TYPOS = [msg('hi! party for my daughter Emma turning 7, 12 kds and 4 adust, sat 21 novmber 2pm')];
const ENGLISH_MODEL = answer({
  date: family('2026-11-21', 'sat 21 novmber'),
  startTime: family('14:00', '2pm'),
  kids: family(12, '12 kds'),
  adults: family(4, '4 adust'),
  childName: family('Emma', 'Emma'),
  childAge: family(7, 'turning 7'),
});

describe('the pattern reading first, the model after', () => {
  const pattern = draftOf('en', ENGLISH_TYPOS);

  it('the pattern reading alone misses the misspelled guests', () => {
    expect(pattern.kids).toBe('');
    expect(pattern.adults).toBe('');
    expect(pattern.childName).toBe('');
  });

  it('fields the pattern left empty and the person has not touched take the model’s values, each with the chat’s words and whose line', () => {
    const merged = mergeBookDateProposal(freshBookDate(pattern), ENGLISH_MODEL, BRANCH_IDS);
    expect(merged.draft).toMatchObject({ kids: '12', adults: '4', childName: 'Emma', startTime: '14:00', timeFrom: '2pm' });
    expect(merged.sources.kids).toEqual({ text: '12 kds', source: 'family' });
    expect(merged.sources.adults).toEqual({ text: '4 adust', source: 'family' });
    expect(merged.sources.childName).toEqual({ text: 'Emma', source: 'family' });
    // Merging the same answer again changes nothing.
    expect(mergeBookDateProposal(merged, ENGLISH_MODEL, BRANCH_IDS)).toBe(merged);
  });

  it('the dialog shows the model’s values with "The chat says “…”" and a source mark', () => {
    const html = dialog(pattern, ENGLISH_MODEL);
    expect(html).toMatch(/aria-label="Kids"[^>]*value="12"/);
    expect(html).toContain('The chat says “12 kds”');
    expect(html).toMatch(/aria-label="Adults"[^>]*value="4"/);
    expect(html).toContain('The chat says “4 adust”');
    expect(html).toContain('from the family');
    expect(html).toMatch(/aria-label="Child&#x27;s name"[^>]*value="Emma"/);
    expect(html).toMatch(/aria-label="Start time"[^>]*value="14:00"/);
    expect(html).toContain('The chat says “2pm”');
  });

  it('the Events module’s 14:00 is no reading: the model’s time replaces it', () => {
    const noTime = { ...pattern, startTime: DEFAULT_START_TIME, timeFrom: '' };
    const merged = mergeBookDateProposal(freshBookDate(noTime), answer({ startTime: team('15:30', 'в 15:30') }), BRANCH_IDS);
    expect(merged.draft).toMatchObject({ startTime: '15:30', timeFrom: 'в 15:30' });
    expect(merged.sources.startTime).toEqual({ text: 'в 15:30', source: 'team' });
    expect(merged.choices.startTime).toBeUndefined();
  });

  it('while the model reads, the dialog says so; the pattern values are already there', () => {
    const html = dialog(pattern, null, true);
    expect(html).toContain('Reading the whole chat…');
    expect(html).toMatch(/aria-label="Kids"[^>]*value=""/);
    expect(html).toMatch(/aria-label="Booking name"[^>]*value="ZZ TEST Olga"/);
  });
});

// The same with Thai typed fast: "เดก" for เด็ก, "ผูใหญ่" for ผู้ใหญ่, "ธันวา" for
// ธันวาคม, "บ่าย2โมง" run together. The pattern reading skips the short month, and
// with no date in the line the time as well; it never reads adults, and its kids
// come only from "10 คน".
const THAI_TYPOS = [msg('อยากจัดวันเกิดน้องมะลิ ครบ 5 ขวบ 15 ธันวา บ่าย2โมง เดก 10 คน ผูใหญ่ 6 คน')];
const THAI_MODEL = answer({
  date: family('2026-12-15', '15 ธันวา'),
  startTime: family('14:00', 'บ่าย2โมง'),
  kids: family(10, 'เดก 10 คน'),
  adults: family(6, 'ผูใหญ่ 6 คน'),
  childName: family('มะลิ', 'น้องมะลิ'),
  childAge: family(5, 'ครบ 5 ขวบ'),
});

describe('Thai typed with typos reaches the merge', () => {
  const pattern = draftOf('th', THAI_TYPOS);

  it('the pattern reading alone misses the date, the time, the adults and the child’s name', () => {
    // 14:00 with no words is the Events module's default, no reading of the chat.
    expect(pattern).toMatchObject({ date: '', dateFrom: '', startTime: DEFAULT_START_TIME, timeFrom: '', kids: '10', adults: '', childName: '', childAge: '5' });
  });

  it('the model’s values fill what the pattern missed, each with the family’s words as written; where both read the same, no choice', () => {
    const merged = mergeBookDateProposal(freshBookDate(pattern), THAI_MODEL, BRANCH_IDS);
    expect(merged.draft).toMatchObject({
      date: '2026-12-15',
      dateFrom: '15 ธันวา',
      startTime: '14:00',
      timeFrom: 'บ่าย2โมง',
      kids: '10',
      adults: '6',
      childName: 'มะลิ',
      childAge: '5',
      branchId: CENTRAL,
    });
    expect(merged.sources.date).toEqual({ text: '15 ธันวา', source: 'family' });
    expect(merged.sources.startTime).toEqual({ text: 'บ่าย2โมง', source: 'family' });
    expect(merged.sources.kids).toEqual({ text: 'เดก 10 คน', source: 'family' });
    expect(merged.sources.adults).toEqual({ text: 'ผูใหญ่ 6 คน', source: 'family' });
    expect(merged.choices).toEqual({});
    expect(pendingChoice(merged)).toBeNull();
    expect(readDraft(merged.draft)).toMatchObject({ values: { date: '2026-12-15', kids: 10, adults: 6, startTime: '14:00' } });

    const html = dialog(pattern, THAI_MODEL);
    expect(html).toMatch(/aria-label="Adults"[^>]*value="6"/);
    expect(html).toContain('The chat says “ผูใหญ่ 6 คน”');
    expect(html).toContain('The chat says “เดก 10 คน”');
    expect(html).toContain('from the family');
  });
});

describe('what the person edited is theirs', () => {
  it('an edited field keeps the person’s value; the others still take the model’s', () => {
    const pattern = draftOf('en', ENGLISH_TYPOS);
    const typed = editBookDate(freshBookDate(pattern), 'kids', '15');
    const merged = mergeBookDateProposal(typed, ENGLISH_MODEL, BRANCH_IDS);
    expect(merged.draft.kids).toBe('15');
    expect(merged.sources.kids).toBeUndefined();
    expect(merged.choices.kids).toBeUndefined();
    expect(merged.draft.adults).toBe('4');
  });

  it('an edited date is kept even when the model reads another, and no choice is asked', () => {
    const pattern = draftOf('en', ENGLISH_TYPOS);
    const typed = editBookDate(freshBookDate(pattern), 'date', '2026-12-05');
    const merged = mergeBookDateProposal(typed, ENGLISH_MODEL, BRANCH_IDS);
    expect(merged.draft.date).toBe('2026-12-05');
    expect(merged.choices.date).toBeUndefined();
    expect(pendingChoice(merged)).toBeNull();
  });
});

describe('the two readings disagree: both are shown and the person picks', () => {
  // The pattern reads "sat" as Saturday 14 November; the model reads "sat 21 novmber".
  const pattern: BookDateDraft = { ...draftOf('en', ENGLISH_TYPOS), date: '2026-11-14', dateFrom: 'sat' };

  it('the date is emptied and both readings are offered; Save asks for a choice first', () => {
    const merged = mergeBookDateProposal(freshBookDate(pattern), ENGLISH_MODEL, BRANCH_IDS);
    expect(merged.draft.date).toBe('');
    expect(merged.choices.date).toEqual([
      { value: '2026-11-21', text: 'sat 21 novmber', source: 'family', by: 'model' },
      { value: '2026-11-14', text: 'sat', source: null, by: 'pattern' },
    ]);
    expect(pendingChoice(merged)).toBe('The chat reads two ways for the date: choose one.');

    const html = dialog(pattern, ENGLISH_MODEL);
    expect(html).toContain('The chat reads two ways: choose one');
    expect(html).toContain('Sat 21 Nov 2026');
    expect(html).toContain('Sat 14 Nov 2026');
    expect(html).toContain('“sat 21 novmber”');
    expect(html).toContain('data-choice="date"');
  });

  it('picking one sets the date with its words and settles the choice', () => {
    const merged = mergeBookDateProposal(freshBookDate(pattern), ENGLISH_MODEL, BRANCH_IDS);
    const picked = pickBookDateChoice(merged, 'date', merged.choices.date![0]!);
    expect(picked.draft).toMatchObject({ date: '2026-11-21', dateFrom: 'sat 21 novmber' });
    expect(picked.sources.date).toEqual({ text: 'sat 21 novmber', source: 'family' });
    expect(pendingChoice(picked)).toBeNull();
    expect(readDraft(picked.draft)).toMatchObject({ values: { date: '2026-11-21', kids: 12, adults: 4, startTime: '14:00' } });
    // The pattern's reading may be picked instead.
    const other = pickBookDateChoice(merged, 'date', merged.choices.date![1]!);
    expect(other.draft).toMatchObject({ date: '2026-11-14', dateFrom: 'sat' });
  });

  it('typing a date of one’s own settles the choice too', () => {
    const merged = mergeBookDateProposal(freshBookDate(pattern), ENGLISH_MODEL, BRANCH_IDS);
    const typed = editBookDate(merged, 'date', '2026-11-28');
    expect(typed.choices.date).toBeUndefined();
    expect(pendingChoice(typed)).toBeNull();
  });

  it('the same reading by both keeps the value and gains the model’s words and mark', () => {
    const same = { ...pattern, date: '2026-11-21', dateFrom: '21 novmber' };
    const merged = mergeBookDateProposal(freshBookDate(same), ENGLISH_MODEL, BRANCH_IDS);
    expect(merged.draft).toMatchObject({ date: '2026-11-21', dateFrom: 'sat 21 novmber' });
    expect(merged.choices.date).toBeUndefined();
    expect(merged.sources.date).toEqual({ text: 'sat 21 novmber', source: 'family' });
  });

  it('a count read differently (the pattern took "15 คน" for kids) is a choice as well', () => {
    const thai = draftOf('th', [msg('วันเกิดน้องมะลิ 21 พ.ย. เด็ก 10 คน ผู้ใหญ่ 5 คน รวม 15 คน')]);
    const merged = mergeBookDateProposal(
      freshBookDate({ ...thai, kids: '15' }),
      answer({ kids: team(10, 'เด็ก 10 คน'), adults: team(5, 'ผู้ใหญ่ 5 คน') }),
      BRANCH_IDS,
    );
    expect(merged.choices.kids?.map((o) => o.value)).toEqual(['10', '15']);
    expect(merged.draft.kids).toBe('');
    expect(merged.draft.adults).toBe('5');
    expect(merged.sources.adults).toEqual({ text: 'ผู้ใหญ่ 5 คน', source: 'team' });
    expect(pendingChoice(merged)).toBe('The chat reads two ways for the number of kids: choose one.');
  });
});

describe('the park the chat names', () => {
  const pattern = draftOf('en', ENGLISH_TYPOS);

  it('another park the person can choose: both are offered', () => {
    const merged = mergeBookDateProposal(freshBookDate(pattern), answer({ branchHint: family(CHALONG, 'at Chalong') }), BRANCH_IDS);
    expect(merged.choices.branchId?.map((o) => o.value)).toEqual([CHALONG, CENTRAL]);
    const html = dialog(pattern, answer({ branchHint: family(CHALONG, 'at Chalong') }));
    expect(html).toContain('“at Chalong”');
  });

  it('a park that is none of the person’s: the chat’s words only, the park unchanged', () => {
    const merged = mergeBookDateProposal(freshBookDate(pattern), answer({ branchHint: family(ELSEWHERE, 'Bangna') }), BRANCH_IDS);
    expect(merged.draft.branchId).toBe(CENTRAL);
    expect(merged.choices.branchId).toBeUndefined();
    expect(merged.parkHint).toEqual({ text: 'Bangna', source: 'family' });
    const unknown = mergeBookDateProposal(freshBookDate(pattern), answer({ branchHint: family(null, 'the Bangna one') }), BRANCH_IDS);
    expect(unknown.parkHint).toEqual({ text: 'the Bangna one', source: 'family' });
    expect(dialog(pattern, answer({ branchHint: family(null, 'the Bangna one') }))).toContain('The chat says “the Bangna one”');
  });
});

describe('the model unavailable: the pattern reading stands', () => {
  it('unavailable, or no answer, changes nothing and the dialog says nothing more', () => {
    const pattern = draftOf('en', ENGLISH_TYPOS);
    const fresh = freshBookDate(pattern);
    expect(mergeBookDateProposal(fresh, UNAVAILABLE, BRANCH_IDS)).toBe(fresh);
    expect(mergeBookDateProposal(fresh, null, BRANCH_IDS)).toBe(fresh);
    const shown = dialog(pattern, UNAVAILABLE);
    expect(shown).toBe(dialog(pattern, null));
    expect(shown).not.toContain('Reading the whole chat');
    expect(shown).not.toContain('from the family');
    expect(shown).not.toContain('two ways');
  });
});
