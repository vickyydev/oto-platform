// SCRUM-814 — Book Date opens with the date and time the chat names, in
// Russian, Thai and English, read from the whole chat (the customer's lines
// and the team's; a team line's date wins when they differ), each with the
// chat's own words beside it, and the Events module's 14:00 only when the chat
// names no time. Node, no DOM: the dialog rendered with react-dom/server, and
// the parser and the draft as the pure functions ChatPanel calls.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationRow, Message } from '@/api/inbox';
import { BookDateDialog, readDraft } from '@/components/BookDateDialog';
import { DEFAULT_START_TIME, bookDateDraft, chatLinesOf, parseBeoFromConversation, type BookDateDraft } from '@/lib/beo';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const TODAY = '2026-11-10'; // a Tuesday; 14 November is a Saturday

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
    id: `0192f0a0-1234-7abc-8def-0000000000${seq}`,
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

function dialog(initial: BookDateDraft): string {
  return renderToStaticMarkup(
    createElement(BookDateDialog, {
      open: true,
      customer: 'ZZ TEST Olga',
      initial,
      branches: [{ value: CENTRAL, label: 'Central Floresta' }],
      busy: false,
      error: null,
      thenOpensBeo: false,
      onCancel: () => undefined,
      onSave: () => undefined,
    }),
  );
}

describe('Book Date’s first values on a Russian chat', () => {
  const chat = [
    msg('Здравствуйте! Хотим отметить день рождения сына 15 ноября, 12 детей'),
    msg('Здравствуйте! 15 ноября занято, можем предложить 21-го ноября в 14:00', 'staff'),
    msg('Да, давайте 21-го'),
  ];
  const draft = draftOf('ru', chat);

  it('the team’s date wins over the customer’s, with its words and its time; the kids are the customer’s', () => {
    expect(draft).toMatchObject({
      date: '2026-11-21',
      dateFrom: '21-го ноября',
      startTime: '14:00',
      timeFrom: 'в 14:00',
      kids: '12',
      branchId: CENTRAL,
    });
    expect(parseBeoFromConversation(row('ru'), chat, TODAY).eventDateBy).toBe('team');
  });

  it('renders the date and the time, each with the chat’s words beside it, and saves them', () => {
    const html = dialog(draft);
    expect(html).toContain('value="2026-11-21"');
    expect(html).toContain('The chat says “21-го ноября”');
    expect(html).toContain('value="14:00"');
    expect(html).toContain('The chat says “в 14:00”');
    expect(readDraft(draft)).toMatchObject({ values: { date: '2026-11-21', startTime: '14:00', kids: 12 } });
  });

  it('a weekday alone is the next such day, and the Events module’s start time with no hint', () => {
    const d = draftOf('ru', [msg('Можно в субботу?')]);
    expect(d).toMatchObject({ date: '2026-11-14', dateFrom: 'в субботу', startTime: DEFAULT_START_TIME, timeFrom: '' });
    const html = dialog(d);
    expect(html).toContain('The chat says “в субботу”');
    expect(html).not.toContain('The chat says “14:00”');
  });

  it('the confirmation’s deposit date is not the party’s date', () => {
    const d = draftOf('ru', [msg('Подтверждаем день рождения 21 ноября в 14:00, 12 детей. Депозит получен 9 ноября', 'staff')]);
    expect(d).toMatchObject({ date: '2026-11-21', dateFrom: '21 ноября', startTime: '14:00' });
  });

  it('nor when the deposit is written with a thousands comma, in the three languages', () => {
    for (const [language, text, dateFrom] of [
      ['ru', 'Подтверждаем праздник 21 ноября в 14:00. Депозит 1,500 бат получен 9 ноября.', '21 ноября'],
      ['en', 'Confirmed: Saturday 21 November at 14:00. Deposit of 1,500 baht received on 9 November.', 'Saturday 21 November'],
      ['th', 'ยืนยันงานวันที่ 21 พ.ย. เวลา 14.00 น. มัดจำ 1,500 บาท วันที่ 9 พ.ย.', '21 พ.ย.'],
    ] as const) {
      expect(draftOf(language, [msg('Хотим праздник'), msg(text, 'staff')]), text).toMatchObject({ date: '2026-11-21', dateFrom, startTime: '14:00' });
    }
  });
});

describe('Book Date’s first values on a Thai chat', () => {
  const draft = draftOf('th', [msg('สวัสดีค่ะ อยากจัดงานวันเกิดลูก วันที่ 15 พ.ย. บ่าย 2 โมง เด็ก 10 คน'), msg('ได้ค่ะ', 'staff')]);

  it('reads the day and month, the afternoon hour and the kids', () => {
    expect(draft).toMatchObject({ date: '2026-11-15', dateFrom: '15 พ.ย.', startTime: '14:00', timeFrom: 'บ่าย 2 โมง', kids: '10' });
    const html = dialog(draft);
    expect(html).toContain('value="2026-11-15"');
    expect(html).toContain('The chat says “15 พ.ย.”');
    expect(html).toContain('The chat says “บ่าย 2 โมง”');
  });

  it('a full month name and a Buddhist year, and next Saturday', () => {
    expect(draftOf('th', [msg('ขอจองวันที่ 21 พฤศจิกายน 2569 ค่ะ')])).toMatchObject({ date: '2026-11-21', dateFrom: '21 พฤศจิกายน 2569' });
    expect(draftOf('th', [msg('วันเสาร์หน้าว่างไหมคะ')])).toMatchObject({ date: '2026-11-14', dateFrom: 'วันเสาร์หน้า' });
  });
});

describe('Book Date’s first values on an English chat', () => {
  it('a weekday and a full month name with a space, and the time', () => {
    const draft = draftOf('en', [msg('Hi, can we book a party on Saturday 21 November at 2 pm for 15 kids?')]);
    expect(draft).toMatchObject({
      date: '2026-11-21',
      dateFrom: 'Saturday 21 November',
      startTime: '14:00',
      timeFrom: '2 pm',
      kids: '15',
    });
    expect(dialog(draft)).toContain('The chat says “Saturday 21 November”');
  });

  it('the assistant’s and the system’s lines are not read; the team’s and the customer’s are', () => {
    const messages = [msg('Party on 21 November please'), msg('See you on 22 November!', 'ai'), msg('Booked for 23 November', 'system')];
    expect(chatLinesOf(messages)).toEqual([{ text: 'Party on 21 November please', team: false }]);
    expect(draftOf('en', messages).date).toBe('2026-11-21');
  });

  it('a chat that names no date opens with none, as before', () => {
    const draft = draftOf('en', [msg('Hello! How much is a party?')]);
    expect(draft).toMatchObject({ date: '', dateFrom: '', startTime: DEFAULT_START_TIME, timeFrom: '' });
    expect(dialog(draft)).toContain('The chat names no date');
  });
});
