// SCRUM-947 — Book Date reads a chat's kids count once: the digits of a clock
// time, a date, a price, a phone number or an age are never offered as a count.
//
// Found in the staging proof of the BEO fill (docs/qa/proof-2026-11-12/SCRUM-904,
// picture 18): both Thai chats said "11:00-13:00 เด็ก 8 คน" and "14:00-16:00
// เด็ก 10 คน", and the dialog said "The chat reads two ways: choose one" for
// the kids, "8 or 00" and "10 or 00". The model had read 8 and 10; the "00"
// was the dialog's own pattern reading (the prototype's "<n> kids" rule,
// `parseBeoFromConversation`), which took the minutes of "13:00" before "เด็ก"
// for the count. Node, no DOM: the reading and the merge as the pure functions
// the dialog calls, and the dialog rendered with react-dom/server.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BookDateProposal, ConversationRow, Message } from '@/api/inbox';
import { BookDateDialog, readDraft } from '@/components/BookDateDialog';
import {
  bookDateDraft,
  freshBookDate,
  mergeBookDateProposal,
  parseBeoFromConversation,
  pendingChoice,
  type BookDateDraft,
} from '@/lib/beo';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const BRANCHES = [{ value: CENTRAL, label: 'Central Floresta' }];
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
    contact: { id: '0192f0a0-1234-7abc-8def-0123456789ac', channel: 'whatsapp', handle: '+66812345678', displayName: 'ZZ TEST 947', phone: '+66812345678', language, erased: false },
    category: 'birthdays',
    intent: 'birthday party',
    language,
    branchId: CENTRAL,
    teamId: '00000000-0000-7000-8000-0000000000b1',
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-11-12T12:17:22.141Z',
    lastMessagePreview: '',
    unanswered: true,
    unread: 1,
    mine: true,
    assignments: [],
    createdAt: '2026-11-12T12:17:22.141Z',
  };
}

let seq = 10;
function msg(body: string, authorKind: Message['authorKind'] = 'customer'): Message {
  seq += 1;
  return {
    id: `0192f0a0-1234-7abc-8def-0000000009${seq}`,
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
    transcriptStatus: null,
    transcriptLanguage: null,
    templateId: null,
    providerStatus: null,
    source: 'channel',
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    redacted: false,
    createdAt: '2026-11-12T12:17:22.141Z',
  };
}

/** The pattern reading's kids for one customer line. */
const kidsOf = (text: string, language = 'en') => parseBeoFromConversation(row(language), [msg(text)], TODAY).numKids;

/** The dialog's first values, as ChatPanel computes them when Book Date opens. */
const draftOf = (language: string, messages: Message[]) =>
  bookDateDraft(parseBeoFromConversation(row(language), messages, TODAY), TODAY, CENTRAL);

type Proposal = NonNullable<BookDateProposal['proposal']>;
const family = <T,>(value: T, text: string) => ({ value, text, source: 'family' as const, messageId: FAMILY_LINE });

function answer(proposal: Partial<Proposal>): BookDateProposal {
  return {
    conversationId: row('th').id,
    model: 'ai',
    proposal: { date: null, startTime: null, kids: null, adults: null, childName: null, childAge: null, branchHint: null, ...proposal } as Proposal,
    patternReading: { date: null, dateText: '', source: null, startTime: null, timeText: '' },
  };
}

function dialog(initial: BookDateDraft, proposal: BookDateProposal | null): string {
  return renderToStaticMarkup(
    createElement(BookDateDialog, {
      open: true,
      customer: 'ZZ TEST 947',
      initial,
      branches: BRANCHES,
      busy: false,
      error: null,
      thenOpensBeo: false,
      onCancel: () => undefined,
      onSave: () => undefined,
      proposal,
      reading: false,
    }),
  );
}

// The proof's two Thai threads, as the family typed them (receipt.json, threads C and F).
const THREAD_C = [
  msg('สวัสดีค่ะ อยากจองงานวันเกิดให้ลูกชาย ZZ Test Niko ครบ 5 ขวบ วันเสาร์ที่ 12 ธันวาคม 11:00-13:00 เด็ก 8 คน ผู้ใหญ่ 4 คน (ZZ TEST)'),
  msg('แพ็กเกจวันเกิด Floresta ค่ะ ข้าวผัดไก่ for the adults please. ลูกแพ้ถั่วลิสง (ZZ TEST)'),
];
const THREAD_C_MODEL = answer({
  date: family('2026-12-12', 'วันเสาร์ที่ 12 ธันวาคม'),
  startTime: family('11:00', '11:00-13:00'),
  kids: family(8, 'เด็ก 8 คน'),
  adults: family(4, 'ผู้ใหญ่ 4 คน'),
  childName: family('ZZ Test Niko', 'ZZ Test Niko'),
  childAge: family(5, 'ครบ 5 ขวบ'),
});
const THREAD_F = [
  msg('สวัสดีค่ะ จองงานวันเกิด ZZ Test Pim ครบ 4 ขวบ วันอาทิตย์ที่ 27 ธันวาคม 14:00-16:00 เด็ก 10 คน ผู้ใหญ่ 5 คน แพ็กเกจวันเกิด Floresta ข้าวผัดสำหรับผู้ใหญ่ค่ะ (ZZ TEST)'),
];
const THREAD_F_MODEL = answer({
  date: family('2026-12-27', 'วันอาทิตย์ที่ 27 ธันวาคม'),
  startTime: family('14:00', '14:00-16:00'),
  kids: family(10, 'เด็ก 10 คน'),
  adults: family(5, 'ผู้ใหญ่ 5 คน'),
  childName: family('ZZ Test Pim', 'ZZ Test Pim'),
  childAge: family(4, 'ครบ 4 ขวบ'),
});

describe('the proof’s Thai chats: the kids are read once', () => {
  it.each([
    ['C', THREAD_C, THREAD_C_MODEL, '8', 'เด็ก 8 คน'],
    ['F', THREAD_F, THREAD_F_MODEL, '10', 'เด็ก 10 คน'],
  ] as const)('thread %s: the pattern reads the kids the chat gives, never the minutes of the time', (_thread, lines, model, kids, words) => {
    const draft = draftOf('th', [...lines]);
    expect(draft.kids).toBe(kids);
    const merged = mergeBookDateProposal(freshBookDate(draft), model, BRANCH_IDS);
    expect(merged.choices.kids).toBeUndefined();
    expect(merged.choices).toEqual({});
    expect(pendingChoice(merged)).toBeNull();
    expect(merged.draft.kids).toBe(kids);
    expect(merged.sources.kids).toEqual({ text: words, source: 'family' });
    expect(readDraft(merged.draft)).toMatchObject({ values: { kids: Number(kids) } });

    const html = dialog(draft, model);
    expect(html).not.toContain('two ways');
    expect(html).not.toContain('data-choice="kids"');
    expect(html).toMatch(new RegExp(`aria-label="Kids"[^>]*value="${kids}"`));
    expect(html).toContain(`The chat says “${words}”`);
  });
});

describe('the digits of a clock time are no count', () => {
  it.each([
    ['th', 'วันเสาร์ที่ 12 ธันวาคม 13:00 เด็ก 8 คน'],
    ['th', '13.00 เด็ก 8 คน'],
    ['th', '13:00 น. เด็ก 8 คน'],
    ['th', 'เวลา 11.00-13.00 เด็ก 8 คน'],
    ['th', '13:00น.เด็ก8คน'],
    ['th', '๑๓:๐๐ เด็ก ๘ คน'],
    ['th', '๑๓:00 เด็ก 8 คน'],
    ['th', '11:00 - 13:00 เด็ก 8 คน'],
    ['en', 'Saturday 12 December from 11:00-13:00 kids 8, 8 kids and 4 adults'],
    ['en', 'party 1 pm 8 kids'],
    ['en', 'from 13.00 kids party for 8 kids'],
    ['en', '١٣:٠٠ kids party, 8 kids'],
    ['ru', 'в 13:00 детей 8, нас будет 8 детей'],
    ['ru', '12 декабря с 11.00 до 13.00 детей будет 8 детей'],
  ])('%s: "%s" reads 8', (language, text) => {
    expect(kidsOf(text, language)).toBe('8');
  });

  it.each([
    ['th', '11:00-13:00 เด็ก'],
    ['en', 'party 11:00-13:00 kids welcome'],
    ['ru', 'с 11:00 до 13:00 детей ждём'],
    ['en', '١٣:٠٠ kids'],
  ])('%s: "%s" has no count, so none is read', (language, text) => {
    expect(kidsOf(text, language)).toBe('');
  });
});

describe('the digits of a date, a price, a phone number or an age are no count', () => {
  it.each([
    // Dates.
    ['th', '27/12 เด็ก 10 คน', '10'],
    ['th', 'วันที่ 27 เด็ก 10 คน', '10'],
    ['th', 'วันเสาร์ที่ 12 เด็ก 10 คน', '10'],
    ['en', 'on 12.12 kids 10, 10 kids', '10'],
    ['en', '2026-12-12 kids party, 10 kids', '10'],
    ['ru', '12.12 детей 10, всего 10 детей', '10'],
    // Prices.
    ['th', 'ราคา 1,500 เด็ก 10 คน', '10'],
    ['th', 'ราคา 590 เด็ก 10 คน', '10'],
    ['en', '฿1,500 kids package for 10 kids', '10'],
    ['en', 'the 1,000 kids package? we are 10 kids', '10'],
    ['ru', 'цена 590 детский пакет, 1,500 детей не надо, у нас 10 детей', '10'],
    // Phone numbers.
    ['th', 'โทร 0812345678 เด็ก 10 คน', '10'],
    ['th', 'โทร 081-234-5678 เด็ก 10 คน', '10'],
    ['en', 'call me on +66 81 234 5678 kids 10, 10 kids', '10'],
    ['ru', 'мой номер 081 234 567 детей 10, 10 детей', '10'],
    // Ages.
    ['th', 'ลูกอายุ 5 เด็ก 10 คน', '10'],
    ['en', 'my son is turning 7 kids party for 10 kids', '10'],
    ['ru', 'сыну исполняется 6 детей будет 10 детей', '10'],
  ])('%s: "%s" reads %s', (language, text, kids) => {
    expect(kidsOf(text, language)).toBe(kids);
  });
});

describe('the prototype’s reading is otherwise as it was', () => {
  it('the first "<n> kids" in English, Russian or Thai, the Thai "<n> คน" with it', () => {
    expect(kidsOf('Hello! Can we book a party for 15 kids on 21/mar?')).toBe('15');
    expect(kidsOf('День рождения, 12 детей, в субботы', 'ru')).toBe('12');
    expect(kidsOf('งานวันเกิด 20 เด็ก', 'th')).toBe('20');
    expect(kidsOf('เด็ก 8 คน', 'th')).toBe('8');
    expect(kidsOf('в субботу 15 детей', 'ru')).toBe('15');
    expect(kidsOf('8-10 kids')).toBe('10');
    expect(kidsOf('nothing useful')).toBe('');
  });

  it('a count of zero the chat states is still read', () => {
    expect(kidsOf('0 kids, only adults: 10 adults')).toBe('0');
    expect(kidsOf('เด็ก 0 คน ผู้ใหญ่ 10 คน', 'th')).toBe('0');
    expect(kidsOf('0 детей, только взрослые', 'ru')).toBe('0');
  });

  it('a Thai count of the adults, the guests or the total is not the kids’', () => {
    expect(kidsOf('ผู้ใหญ่ 4 คน เด็ก 8 คน', 'th')).toBe('8');
    expect(kidsOf('ผูใหญ่ 4 คน เดก 8 คน', 'th')).toBe('8');
    expect(kidsOf('ทั้งหมด 12 คน เด็ก 8 คน', 'th')).toBe('8');
    expect(kidsOf('รวม 12 คน', 'th')).toBe('');
    expect(kidsOf('มา 12 คน', 'th')).toBe('12');
  });

  it('a Thai count in Thai digits is read as the number it is', () => {
    expect(kidsOf('เด็ก ๑๐ คน', 'th')).toBe('10');
  });
});

describe('a real disagreement in the chat is still two ways', () => {
  it('"10 kids" early and "12 kids" later: the pattern reads the first, the model the later; the person chooses', () => {
    const draft = draftOf('en', [msg('Hi, a party on 12 December at 13:00 for 10 kids'), msg('sorry, 12 kids, not 10')]);
    expect(draft.kids).toBe('10');
    const merged = mergeBookDateProposal(freshBookDate(draft), answer({ kids: family(12, '12 kids') }), BRANCH_IDS);
    expect(merged.choices.kids?.map((o) => o.value)).toEqual(['12', '10']);
    expect(pendingChoice(merged)).toBe('The chat reads two ways for the number of kids: choose one.');
    expect(dialog(draft, answer({ kids: family(12, '12 kids') }))).toContain('The chat reads two ways: choose one');
  });

  it('Thai: "เด็ก 10 คน" and later "เด็ก 12 คน", with times in both lines', () => {
    const draft = draftOf('th', [msg('วันที่ 12 ธันวาคม 13:00 เด็ก 10 คน'), msg('ขอเปลี่ยนเป็น 14:00 เด็ก 12 คนค่ะ')]);
    expect(draft.kids).toBe('10');
    const merged = mergeBookDateProposal(freshBookDate(draft), answer({ kids: family(12, 'เด็ก 12 คน') }), BRANCH_IDS);
    expect(merged.choices.kids?.map((o) => o.value)).toEqual(['12', '10']);
  });

  it('Russian: "10 детей", then "12 детей"', () => {
    const draft = draftOf('ru', [msg('12 декабря в 13:00, 10 детей'), msg('Нет, будет 12 детей')]);
    expect(draft.kids).toBe('10');
    const merged = mergeBookDateProposal(freshBookDate(draft), answer({ kids: family(12, '12 детей') }), BRANCH_IDS);
    expect(merged.choices.kids?.map((o) => o.value)).toEqual(['12', '10']);
  });

  it('a zero the chat states and a count the model reads are two ways too', () => {
    const draft = draftOf('en', [msg('0 kids at 13:00, just adults'), msg('actually 3 kids')]);
    expect(draft.kids).toBe('0');
    const merged = mergeBookDateProposal(freshBookDate(draft), answer({ kids: family(3, '3 kids') }), BRANCH_IDS);
    expect(merged.choices.kids?.map((o) => o.value)).toEqual(['3', '0']);
  });
});
