import { readChatPartyDate, readPartyDate, type PartyChatLine } from '@oto/shared/chat-dates';
import { INBOX_DAY_TIMEZONE } from '@oto/shared/inbox';
import type { ConversationRow, Message } from '@/api/inbox';

/**
 * BOOK DATE'S READING OF THE CHAT (SCRUM-775, the date and time SCRUM-814).
 *
 * The prototype's BEO modal pre-filled itself from the conversation
 * (`WhatsAppDemo.tsx` `parseBeoFromConversation`, :2109-2158), and those rules
 * are ported here unchanged: the customer's own lines, joined; the first
 * "<n> kids" in English, Russian or Thai; the first "<n> years"; an animator
 * or a cake mentioned; the package from the conversation's topic.
 *
 * THE DATE AND TIME (SCRUM-814). The prototype's date patterns needed a
 * separator between day and month and used ASCII word boundaries, so they
 * never read a Russian or Thai date ("15 ноября", "15 พ.ย.") nor "21 November"
 * — the owner reported Book Date opening without the chat's date. They are
 * replaced by the shared reader (`@oto/shared` chat-dates, the one the api's
 * BEO confirmation picker uses), over the WHOLE chat: the customer's lines and
 * the team's, a team line's date winning over a customer's when they differ;
 * and the time is read too. The shape stays the prototype's: the phrase the
 * chat said is kept and shown beside the date so a person confirms it.
 *
 * What the platform adds is only what the Events module needs that the
 * prototype's free text could not give it: the phrase becomes a calendar date
 * (`resolveEventDate`).
 */

export interface BeoData {
  customerName: string;
  /** The prototype's free "contact": the phone, else the channel handle (an Instagram or LINE id is no phone). */
  contact: string;
  /**
   * The contact's phone, only when the channel gives one (WhatsApp), else
   * empty: what Book Date's Phone field opens with, since the Events module
   * stores a phone there and a channel handle cannot be read as one.
   */
  phone: string;
  language: string | null;
  branchId: string | null;
  /** The phrase as the chat said it ("21/mar", "saturday", "15 ноября"), or empty. */
  eventDate: string;
  /** Whose line the date came from: a team line's wins over a customer's. */
  eventDateBy: 'team' | 'customer' | null;
  /** The party's start as the chat names it, `HH:MM`, or empty. */
  eventTime: string;
  /** The chat's own words for that time ("в 14:00", "บ่าย 2 โมง"), or empty. */
  eventTimeFrom: string;
  numKids: string;
  numAdults: string;
  packageName: string;
  animator: boolean;
  cake: boolean;
  /** The age the chat names ("5 years"), or empty: the prototype's "(5 y/o)" hint. */
  age: string;
}

const KIDS = /(\d{1,3})\s*(детей|ребен|kids|children|kid|child|เด็ก|คน)/i;
const ANIMATOR = /(animator|аниматор|นักแสดง|นัก)/i;
const CAKE = /(cake|торт|เค้ก|🎂)/i;
const AGE = /(\d{1,2})\s*(лет|years|year|ปี|ขวบ)/i;

/** The customer's own lines, in order, as the prototype joined them. */
export function customerTextOf(messages: readonly Pick<Message, 'authorKind' | 'body'>[]): string {
  return messages
    .filter((m) => m.authorKind === 'customer' && typeof m.body === 'string')
    .map((m) => m.body as string)
    .join(' \n ');
}

/**
 * The chat's lines the date and time are read from, in order: the customer's
 * and the team's people's (not the assistant's or a system notice), each with
 * its text.
 */
export function chatLinesOf(messages: readonly Pick<Message, 'authorKind' | 'body'>[]): PartyChatLine[] {
  return messages
    .filter((m) => (m.authorKind === 'customer' || m.authorKind === 'staff') && typeof m.body === 'string')
    .map((m) => ({ text: m.body as string, team: m.authorKind === 'staff' }));
}

/**
 * `parseBeoFromConversation`, on the platform's conversation and its loaded
 * messages. `today` (the park's day, `YYYY-MM-DD`, or an instant read in the
 * parks' zone) is the day a weekday or "tomorrow" in the chat is counted from,
 * and a date whose own year is past is passed over.
 */
export function parseBeoFromConversation(
  conv: Pick<ConversationRow, 'contact' | 'language' | 'branchId' | 'intent'>,
  messages: readonly Pick<Message, 'authorKind' | 'body'>[],
  today: string | Date = new Date(),
): BeoData {
  const customerText = customerTextOf(messages);

  const numKidsMatch = customerText.match(KIDS);
  const numKids = numKidsMatch ? numKidsMatch[1]! : '';

  const when = readChatPartyDate(chatLinesOf(messages), today, INBOX_DAY_TIMEZONE);

  const animator = ANIMATOR.test(customerText);
  const cake = CAKE.test(customerText);

  const ageMatch = customerText.match(AGE);
  const age = ageMatch ? ageMatch[1]! : '';

  // The prototype read the topic from its subcategory; the platform's is the intent.
  const subj = (conv.intent ?? '').toLowerCase();
  const packageName = subj.includes('school')
    ? 'School Event Package'
    : subj.includes('workshop')
      ? 'Workshop Package'
      : subj.includes('camp')
        ? 'Summer Camp Booking'
        : subj.includes('birthday')
          ? 'Birthday Package — TBD'
          : '';

  return {
    customerName: conv.contact.erased ? '' : conv.contact.displayName?.trim() || conv.contact.handle,
    contact: conv.contact.phone ?? (conv.contact.erased ? '' : conv.contact.handle),
    phone: conv.contact.phone ?? '',
    language: conv.language,
    branchId: conv.branchId,
    eventDate: when.phrase,
    eventDateBy: when.by,
    eventTime: when.time ?? '',
    eventTimeFrom: when.timePhrase,
    numKids,
    numAdults: '',
    packageName,
    animator,
    cake,
    age,
  };
}

// --- The phrase as a calendar date -----------------------------------------------------

/**
 * The calendar date a phrase the parser found means, from `today` (the park's
 * day, `YYYY-MM-DD`), by the shared reader: a day and month is its next
 * occurrence, today or later (this year, else a later one); a weekday is the
 * next such day, today or later ("next …" after today); a phrase with its own
 * year is that day. Null when there is no phrase or it names no real date (31/feb).
 */
export function resolveEventDate(phrase: string, today: string): string | null {
  if (!phrase.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  return readPartyDate(phrase, today, INBOX_DAY_TIMEZONE).date;
}

// --- The Book Date dialog's first values -----------------------------------------------

/** The Events module's own default start for a new event (its New event form: 14:00). */
export const DEFAULT_START_TIME = '14:00';

export interface BookDateDraft {
  date: string;
  /** The chat's phrase the date came from, shown beside it; empty when the chat named none. */
  dateFrom: string;
  startTime: string;
  /** The chat's words for the start time, shown beside it; empty when the chat named none (the Events module's default). */
  timeFrom: string;
  branchId: string;
  kids: string;
  adults: string;
  contactName: string;
  phone: string;
  childName: string;
  childAge: string;
}

/**
 * What the dialog opens with: the parser's reading of the chat (its date and
 * time, each with the chat's words), the conversation's park, and the Events
 * module's start time only when the chat names none.
 */
export function bookDateDraft(data: BeoData, today: string, branchId: string | null): BookDateDraft {
  return {
    date: resolveEventDate(data.eventDate, today) ?? '',
    dateFrom: data.eventDate,
    startTime: data.eventTime || DEFAULT_START_TIME,
    timeFrom: data.eventTime ? data.eventTimeFrom : '',
    branchId: branchId ?? data.branchId ?? '',
    kids: data.numKids,
    adults: data.numAdults,
    contactName: data.customerName,
    phone: data.phone,
    childName: '',
    childAge: data.age,
  };
}

/** A whole number from a field, or null when it is empty; NaN when it is not one. */
export function countOf(field: string): number | null {
  const t = field.trim();
  if (!t) return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

/** "Event: 21 Mar 2027 at Central Floresta", the conversation's chip; "· Archived" once the Events module archived it. */
export function eventChipLabel(event: { date: string; branchName: string | null; archived?: boolean }): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.date);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = m ? `${Number(m[3])} ${names[Number(m[2]) - 1]} ${m[1]}` : event.date;
  return `Event: ${day}${event.branchName ? ` at ${event.branchName}` : ''}${event.archived ? ' · Archived' : ''}`;
}
