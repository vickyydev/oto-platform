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
function msg(body: string, authorKind: Message['authorKind'] = 'customer', createdAt = '2026-11-10T03:00:00.000Z'): Message {
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
    transcriptStatus: null,
    transcriptLanguage: null,
    templateId: null,
    providerStatus: null,
    source: 'channel',
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    redacted: false,
    createdAt,
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

  it('a duration is not the start, and a deadline on another line leaves the Events module’s start', () => {
    expect(draftOf('ru', [msg('Пакет на 2 часа, 21 ноября в 15:00')])).toMatchObject({ date: '2026-11-21', startTime: '15:00', timeFrom: 'в 15:00' });
    expect(draftOf('ru', [msg('праздник 21 ноября, длительность 3 часа, начало в 14:00')])).toMatchObject({ startTime: '14:00', timeFrom: 'в 14:00' });
    const d = draftOf('ru', [msg('Хотим праздник 21 ноября'), msg('внесите депозит до 18:00 сегодня', 'staff')]);
    expect(d).toMatchObject({ date: '2026-11-21', startTime: DEFAULT_START_TIME, timeFrom: '' });
    expect(draftOf('en', [msg('Party on 21 November please'), msg('We are open today until 20:00', 'staff')])).toMatchObject({
      startTime: DEFAULT_START_TIME,
      timeFrom: '',
    });
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
    expect(chatLinesOf(messages)).toEqual([{ text: 'Party on 21 November please', team: false, at: '2026-11-10T03:00:00.000Z' }]);
    expect(draftOf('en', messages).date).toBe('2026-11-21');
  });

  it('a day of the month without its month, in the three languages', () => {
    expect(draftOf('en', [msg('can we do the 21st at 3pm?')])).toMatchObject({ date: '2026-11-21', dateFrom: 'the 21st', startTime: '15:00' });
    expect(draftOf('ru', [msg('праздник 15-го в 14:00')])).toMatchObject({ date: '2026-11-15', dateFrom: '15-го', startTime: '14:00' });
    expect(draftOf('th', [msg('ขอจองวันที่ 15 ค่ะ')])).toMatchObject({ date: '2026-11-15', dateFrom: 'วันที่ 15' });
  });

  it('a chat that names no date opens with none, as before', () => {
    const draft = draftOf('en', [msg('Hello! How much is a party?')]);
    expect(draft).toMatchObject({ date: '', dateFrom: '', startTime: DEFAULT_START_TIME, timeFrom: '' });
    expect(dialog(draft)).toContain('The chat names no date');
  });
});

describe('Book Date on a chat with no party date: a team greeting is not one', () => {
  it('"today" and "tomorrow" in the team’s greeting or reply open with no date, in the three languages', () => {
    for (const [language, customer, team] of [
      ['en', 'Hi, how much is a party?', 'Hello! How can I help you today?'],
      ['ru', 'Сколько стоит праздник?', 'Здравствуйте! Чем можем помочь сегодня?'],
      ['th', 'ราคาเท่าไหร่คะ', 'สวัสดีค่ะ วันนี้ให้ช่วยอะไรคะ'],
      ['ru', 'Сколько стоит?', 'Уточню у менеджера и отвечу завтра'],
    ] as const) {
      expect(draftOf(language, [msg(customer), msg(team, 'staff')]), team).toMatchObject({ date: '', dateFrom: '' });
    }
  });
});

describe('Book Date reads the chat’s latest date, and not an old one', () => {
  it('a customer’s new date after the team’s confirmation of a past party', () => {
    const d = draftOf('ru', [
      msg('Подтверждаем ваш праздник 15 марта в 14:00', 'staff', '2026-03-01T03:00:00.000Z'),
      msg('Хотим снова праздник 21 ноября'),
    ]);
    expect(d).toMatchObject({ date: '2026-11-21', dateFrom: '21 ноября' });
    // Even when the old confirmation is inside the window, its day has gone.
    const recent = draftOf('ru', [
      msg('Подтверждаем ваш праздник 25 октября в 14:00', 'staff', '2026-10-20T03:00:00.000Z'),
      msg('Хотим снова праздник в субботу'),
    ]);
    expect(recent).toMatchObject({ date: '2026-11-14', dateFrom: 'в субботу' });
  });

  it('a move the customer asks for after the team’s date', () => {
    const d = draftOf('ru', [msg('Подтверждаем 16 ноября', 'staff'), msg('перенести на 22 ноября?')]);
    expect(d).toMatchObject({ date: '2026-11-22', dateFrom: '22 ноября' });
    expect(parseBeoFromConversation(row('ru'), [msg('Подтверждаем 16 ноября', 'staff'), msg('перенести на 22 ноября?')], TODAY).eventDateBy).toBe('customer');
  });

  it('a weekday written on an earlier day is counted from that day', () => {
    // Written on Wednesday 4 November: "в субботу" was 7 November, gone by the 10th.
    expect(draftOf('ru', [msg('Можно в субботу?', 'customer', '2026-11-04T03:00:00.000Z')])).toMatchObject({ date: '', dateFrom: '' });
    // A date still ahead from a line in the window is read.
    expect(draftOf('en', [msg('Party on 21 November please', 'customer', '2026-10-01T03:00:00.000Z')])).toMatchObject({ date: '2026-11-21' });
    // A line older than the window is not read.
    expect(draftOf('en', [msg('Party on 21 December please', 'customer', '2026-08-01T03:00:00.000Z')])).toMatchObject({ date: '', dateFrom: '' });
  });
});
