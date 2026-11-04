import type { ConversationRow, Message } from '@/api/inbox';

/**
 * BOOK DATE'S READING OF THE CHAT (SCRUM-775).
 *
 * The prototype's BEO modal pre-filled itself from the conversation
 * (`WhatsAppDemo.tsx` `parseBeoFromConversation`, :2109-2158), and those rules
 * are ported here unchanged: the customer's own lines, joined; the first
 * "<n> kids" in English, Russian or Thai; the first day-and-month or weekday
 * phrase; the first "<n> years"; an animator or a cake mentioned; the package
 * from the conversation's topic. The patterns are the prototype's, character
 * for character, including what they do not read ("14 March" with a space, a
 * full month name): a rule that looks narrow is a question for the owner, not
 * a change made here.
 *
 * What the platform adds is only what the Events module needs that the
 * prototype's free text could not give it: the phrase becomes a calendar date
 * (`resolveEventDate`), shown beside the phrase it came from so a person
 * confirms it.
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
  /** The phrase as the chat said it ("21/mar", "saturday"), or empty. */
  eventDate: string;
  eventTime: string;
  numKids: string;
  numAdults: string;
  packageName: string;
  animator: boolean;
  cake: boolean;
  /** The age the chat names ("5 years"), or empty: the prototype's "(5 y/o)" hint. */
  age: string;
}

const KIDS = /(\d{1,3})\s*(детей|ребен|kids|children|kid|child|เด็ก|คน)/i;
const DAY_MONTH =
  /\b(\d{1,2})[-./]\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|พ\.ค|ม\.ค|ก\.พ|มี\.ค|เม\.ย|มิ\.ย|ก\.ค|ส\.ค|ก\.ย|ต\.ค|พ\.ย|ธ\.ค)\b/i;
const WEEKDAY =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|next sunday|next saturday|субботы|воскресенья|следующую субботу)\b/i;
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

/** `parseBeoFromConversation`, on the platform's conversation and its loaded messages. */
export function parseBeoFromConversation(
  conv: Pick<ConversationRow, 'contact' | 'language' | 'branchId' | 'intent'>,
  messages: readonly Pick<Message, 'authorKind' | 'body'>[],
): BeoData {
  const customerText = customerTextOf(messages);

  const numKidsMatch = customerText.match(KIDS);
  const numKids = numKidsMatch ? numKidsMatch[1]! : '';

  const dateMatch = customerText.match(DAY_MONTH) || customerText.match(WEEKDAY);
  const eventDate = dateMatch ? dateMatch[0] : '';

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
    eventDate,
    eventTime: '',
    numKids,
    numAdults: '',
    packageName,
    animator,
    cake,
    age,
  };
}

// --- The phrase as a calendar date -----------------------------------------------------

/** Each month word the prototype's pattern reads, to its month (1-12). */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
  'ม.ค': 1, 'ก.พ': 2, 'มี.ค': 3, 'เม.ย': 4, 'พ.ค': 5, 'มิ.ย': 6, 'ก.ค': 7, 'ส.ค': 8, 'ก.ย': 9, 'ต.ค': 10, 'พ.ย': 11, 'ธ.ค': 12,
};

/** Each weekday word the prototype's pattern reads, to its day (0 Sunday … 6 Saturday). */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  'next sunday': 0, 'next saturday': 6,
  субботы: 6, воскресенья: 0, 'следующую субботу': 6,
};

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The calendar date a phrase the parser found means, from `today` (the park's
 * day, `YYYY-MM-DD`): a day and month is its next occurrence, today or later
 * (this year, else next); a weekday is the next such day, today or later.
 * Null when there is no phrase or it names no real date (31/feb).
 */
export function resolveEventDate(phrase: string, today: string): string | null {
  const text = phrase.trim().toLowerCase();
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const dm = /^(\d{1,2})[-./]\s*(.+)$/.exec(text);
  if (dm) {
    const day = Number(dm[1]);
    const month = MONTHS[dm[2]!.trim()];
    if (!month) return null;
    for (const year of [ty, ty + 1]) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue; // 29/feb outside a leap year
      const candidate = iso(year, month, day);
      if (candidate >= today) return candidate;
    }
    return null;
  }
  const weekday = WEEKDAYS[text];
  if (weekday === undefined) return null;
  const start = new Date(Date.UTC(ty, tm - 1, td));
  const ahead = (weekday - start.getUTCDay() + 7) % 7;
  start.setUTCDate(start.getUTCDate() + ahead);
  return start.toISOString().slice(0, 10);
}

// --- The Book Date dialog's first values -----------------------------------------------

/** The Events module's own default start for a new event (its New event form: 14:00). */
export const DEFAULT_START_TIME = '14:00';

export interface BookDateDraft {
  date: string;
  /** The chat's phrase the date came from, shown beside it; empty when the chat named none. */
  dateFrom: string;
  startTime: string;
  branchId: string;
  kids: string;
  adults: string;
  contactName: string;
  phone: string;
  childName: string;
  childAge: string;
}

/** What the dialog opens with: the parser's reading, the conversation's park, the Events module's start time. */
export function bookDateDraft(data: BeoData, today: string, branchId: string | null): BookDateDraft {
  return {
    date: resolveEventDate(data.eventDate, today) ?? '',
    dateFrom: data.eventDate,
    startTime: DEFAULT_START_TIME,
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
