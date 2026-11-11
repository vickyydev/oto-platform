import { readChatPartyDate, readPartyDate, type PartyChatLine } from '@oto/shared/chat-dates';
import { bahtOf } from '@/lib/view';
import { INBOX_DAY_TIMEZONE } from '@oto/shared/inbox';
import type { BookDateProposal, ConversationRow, Message } from '@/api/inbox';

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
 * the team's, the later line's date winning (the team's answer to the
 * customer's ask, or the customer's move after the team's confirmation), each
 * line counted from the day it was written, a date gone by and a line older
 * than the window passed over, "today" and "tomorrow" not read (a greeting
 * says them); and the time is read too. The shape stays the prototype's: the
 * phrase the chat said is kept and shown beside the date so a person confirms
 * it.
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
  /** Whose line the date came from: the later line's wins, the team's or the customer's. */
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

/** A message's words as the reading needs them: its body, and a voice note's transcript (SCRUM-824). */
type WordsOf = Pick<Message, 'body' | 'transcript' | 'transcriptStatus' | 'redacted'>;

/** How a transcript is marked where the chat is read: the api's `messageText` mark (`voice-notes.ts`). */
export const VOICE_NOTE_MARK = '[voice note]';

/**
 * A message's words, a voice note's read like typed text (SCRUM-824), as the
 * api's `messageText` gives them to the model: the body, and a transcribed
 * (`done`) voice note's words marked `[voice note] …`, never an erased one's;
 * both on two lines when it has both; null when it has neither. A typed body
 * is read exactly as before.
 */
export function messageWordsOf(m: WordsOf): string | null {
  const body = typeof m.body === 'string' ? m.body : null;
  const spoken = !m.redacted && m.transcriptStatus === 'done' && m.transcript ? m.transcript.trim() : '';
  if (!spoken) return body;
  const heard = `${VOICE_NOTE_MARK} ${spoken}`;
  return body !== null && body.trim() !== '' ? `${body}\n${heard}` : heard;
}

/** A loaded message as the reading needs it; when it was written, when the caller has it. */
type ChatMessage = Pick<Message, 'authorKind'> & WordsOf & Partial<Pick<Message, 'createdAt'>>;

/** The customer's own lines, in order, as the prototype joined them; a voice note's words among them. */
export function customerTextOf(messages: readonly ChatMessage[]): string {
  return messages
    .filter((m) => m.authorKind === 'customer')
    .map(messageWordsOf)
    .filter((text): text is string => text !== null)
    .join(' \n ');
}

/**
 * The chat's lines the date and time are read from, in order: the customer's
 * and the team's people's (not the assistant's or a system notice), each with
 * its text — a voice note's words as typed text — and when it was written (a
 * date in it is counted from that day).
 */
export function chatLinesOf(messages: readonly ChatMessage[]): PartyChatLine[] {
  return messages.flatMap((m) => {
    if (m.authorKind !== 'customer' && m.authorKind !== 'staff') return [];
    const text = messageWordsOf(m);
    return text === null ? [] : [{ text, team: m.authorKind === 'staff', ...(m.createdAt ? { at: m.createdAt } : {}) }];
  });
}

/**
 * `parseBeoFromConversation`, on the platform's conversation and its loaded
 * messages. `today` (the park's day, `YYYY-MM-DD`, or an instant read in the
 * parks' zone) is the day the chat's dates are checked against: a date gone by
 * (its own year past, or a weekday or day written on an earlier day) is passed
 * over.
 */
export function parseBeoFromConversation(
  conv: Pick<ConversationRow, 'contact' | 'language' | 'branchId' | 'intent'>,
  messages: readonly ChatMessage[],
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

// --- The model's reading merged in (SCRUM-821) -----------------------------------------

/**
 * BOOK DATE'S VALUES FROM THE MODEL (SCRUM-821). The dialog opens at once with
 * the pattern reading above, then asks the api to read the whole chat with
 * the model (`GET …/book-date-proposal`), which reads typos and the three
 * languages. When it answers:
 *   - a field the person has typed in or chosen is theirs: never changed;
 *   - a field the pattern reading left empty (or, for the time, at the Events
 *     module's default) takes the model's value, with the chat's words and a
 *     mark of whose line it was;
 *   - a field both read the same keeps its value and gains the words and mark;
 *   - a field they read differently is emptied and shows both readings: the
 *     person picks one (or types their own) before Save;
 *   - the park the chat names that is none the person can choose is shown as
 *     the chat's words only;
 *   - `unavailable`, or no answer at all, changes nothing: the pattern reading
 *     stands and the dialog says nothing more.
 * Nothing is saved until Save, as before.
 */

/** The fields a reading of the chat proposes. */
export const PROPOSED_FIELDS = ['date', 'startTime', 'branchId', 'kids', 'adults', 'childName', 'childAge'] as const;
export type ProposedField = (typeof PROPOSED_FIELDS)[number];

/** How a pending choice is named when Save asks for it. */
export const PROPOSED_FIELD_LABELS: Record<ProposedField, string> = {
  date: 'date',
  startTime: 'start time',
  branchId: 'park',
  kids: 'number of kids',
  adults: 'number of adults',
  childName: "child's name",
  childAge: 'age',
};

export type ChatSource = 'team' | 'family';

/** Where a value is in the chat: its words, and whose line (null when the pattern reading does not say). */
export interface FieldSource {
  text: string;
  source: ChatSource | null;
}

/** One reading of a field the person may pick. */
export interface FieldOption extends FieldSource {
  value: string;
  by: 'model' | 'pattern';
}

/** What a press of "Fetch from chat" did (SCRUM-826), for the line the dialog shows under it. */
export interface BookDateFetch {
  /** The model read the chat; false when it could not (nothing changed). */
  read: boolean;
  /** The fields filled or changed from the chat as it is now. */
  filled: readonly ProposedField[];
  /** The fields the person typed that the chat reads differently: kept as typed. */
  kept: readonly ProposedField[];
}

export interface BookDateState {
  draft: BookDateDraft;
  /** The fields the person typed in or chose: a reading never changes them. */
  edited: readonly ProposedField[];
  /** The chat's words and whose line, per field the model read. */
  sources: Partial<Record<ProposedField, FieldSource>>;
  /** The fields the two readings disagree on: the person picks. */
  choices: Partial<Record<ProposedField, readonly FieldOption[]>>;
  /** The park the chat names when it is none the person can choose: its words only. */
  parkHint: FieldSource | null;
  /** The answer already merged, so the same one is never merged twice. */
  merged: BookDateProposal | null;
  /** The last "Fetch from chat", or null before one (SCRUM-826). */
  fetched: BookDateFetch | null;
}

/** The dialog's state as it opens: the pattern reading, nothing edited. */
export function freshBookDate(draft: BookDateDraft): BookDateState {
  return { draft, edited: [], sources: {}, choices: {}, parkHint: null, merged: null, fetched: null };
}

const sameName = (a: string, b: string) => a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase();

/** The pattern reading of a field, when it read one: its value and the chat's words for it. */
function patternOf(draft: BookDateDraft, field: ProposedField): { value: string; text: string } | null {
  switch (field) {
    case 'date':
      return draft.date ? { value: draft.date, text: draft.dateFrom } : null;
    case 'startTime':
      // The Events module's 14:00 is no reading of the chat.
      return draft.timeFrom ? { value: draft.startTime, text: draft.timeFrom } : null;
    case 'branchId':
      return draft.branchId ? { value: draft.branchId, text: '' } : null;
    default:
      return draft[field].trim() ? { value: draft[field].trim(), text: '' } : null;
  }
}

function agree(field: ProposedField, a: string, b: string): boolean {
  if (field === 'kids' || field === 'adults' || field === 'childAge') return Number(a) === Number(b);
  if (field === 'childName') return sameName(a, b);
  return a === b;
}

/** A field's value set, and the words shown beside the date and the time. */
function withValue(draft: BookDateDraft, field: ProposedField, value: string, text: string): BookDateDraft {
  const next = { ...draft, [field]: value };
  if (field === 'date') next.dateFrom = text;
  if (field === 'startTime') next.timeFrom = text;
  return next;
}

type ModelReading = Record<ProposedField, { value: string; text: string; source: ChatSource } | null>;

/** The model's answer as the dialog's fields: a park only when it is one the person can choose. */
function modelReadingOf(p: NonNullable<BookDateProposal['proposal']>, branchIds: readonly string[]): ModelReading {
  return {
    date: p.date && { value: p.date.value, text: p.date.text, source: p.date.source },
    startTime: p.startTime && { value: p.startTime.value, text: p.startTime.text, source: p.startTime.source },
    branchId:
      p.branchHint && p.branchHint.value !== null && branchIds.includes(p.branchHint.value)
        ? { value: p.branchHint.value, text: p.branchHint.text, source: p.branchHint.source }
        : null,
    kids: p.kids && { value: String(p.kids.value), text: p.kids.text, source: p.kids.source },
    adults: p.adults && { value: String(p.adults.value), text: p.adults.text, source: p.adults.source },
    childName: p.childName && { value: p.childName.value, text: p.childName.text, source: p.childName.source },
    childAge: p.childAge && { value: String(p.childAge.value), text: p.childAge.text, source: p.childAge.source },
  };
}

/**
 * The model's answer merged into the dialog, by the rules above. `branchIds`
 * are the parks the person can choose in the dialog.
 */
export function mergeBookDateProposal(
  state: BookDateState,
  answer: BookDateProposal | null,
  branchIds: readonly string[],
): BookDateState {
  if (!answer || answer.model !== 'ai' || !answer.proposal || state.merged === answer) return state;
  const p = answer.proposal;
  const read = modelReadingOf(p, branchIds);
  let draft = state.draft;
  const sources = { ...state.sources };
  const choices = { ...state.choices };
  for (const field of PROPOSED_FIELDS) {
    const model = read[field];
    if (!model || state.edited.includes(field) || choices[field]) continue;
    const pattern = patternOf(draft, field);
    if (pattern && !agree(field, pattern.value, model.value)) {
      choices[field] = [
        { value: model.value, text: model.text, source: model.source, by: 'model' },
        { value: pattern.value, text: pattern.text, source: null, by: 'pattern' },
      ];
      delete sources[field];
      draft = withValue(draft, field, '', '');
      continue;
    }
    sources[field] = { text: model.text, source: model.source };
    draft = withValue(draft, field, pattern ? pattern.value : model.value, model.text);
  }
  const parkHint =
    p.branchHint && read.branchId === null ? { text: p.branchHint.text, source: p.branchHint.source } : state.parkHint;
  return { ...state, draft, sources, choices, parkHint, merged: answer };
}

// --- Fetch from chat (SCRUM-826) ---------------------------------------------------------

/**
 * "FETCH FROM CHAT" (SCRUM-826). The dialog is open; the chat has moved on (a
 * new line with another headcount, a changed time). The person presses Fetch:
 * the model reads the chat again as it is now (the same `book-date-proposal`
 * read), and its answer fills ONLY the fields the person has not typed in or
 * chosen — those take the chat's value as it stands now, with its words and
 * whose line it was, a pending choice on them settled by the fresh reading. A
 * field the person edited stays theirs — only the chat's words under it are
 * refreshed, as SCRUM-821 shows them beside a typed value — and when the chat
 * reads it differently the dialog says it was kept. The outcome (`fetched`)
 * is what the line under the button says; an answer the model could not give
 * changes nothing. Nothing is saved until Save, as before.
 */
export function fetchBookDateProposal(
  state: BookDateState,
  answer: BookDateProposal | null,
  branchIds: readonly string[],
): BookDateState {
  if (!answer || answer.model !== 'ai' || !answer.proposal) {
    return { ...state, fetched: { read: false, filled: [], kept: [] } };
  }
  const p = answer.proposal;
  const read = modelReadingOf(p, branchIds);
  let draft = state.draft;
  const sources = { ...state.sources };
  const choices = { ...state.choices };
  const filled: ProposedField[] = [];
  const kept: ProposedField[] = [];
  for (const field of PROPOSED_FIELDS) {
    const model = read[field];
    if (!model) continue;
    const current = draft[field].trim();
    const same = current !== '' && agree(field, current, model.value);
    // The chat's words as it stands now, under the field: beside a typed value they say what the chat reads.
    sources[field] = { text: model.text, source: model.source };
    if (state.edited.includes(field)) {
      if (!same) kept.push(field);
      continue;
    }
    if (!same || choices[field]) filled.push(field);
    delete choices[field];
    draft = withValue(draft, field, model.value, model.text);
  }
  const parkHint =
    p.branchHint && read.branchId === null ? { text: p.branchHint.text, source: p.branchHint.source } : state.parkHint;
  return { ...state, draft, sources, choices, parkHint, merged: answer, fetched: { read: true, filled, kept } };
}

/** The line under "Fetch from chat": what the press filled, what it kept, or that it could not read. */
export function bookDateFetchLine(fetched: BookDateFetch): string {
  if (!fetched.read) return 'The chat could not be read again; nothing changed.';
  const names = (fields: readonly ProposedField[]) => fields.map((f) => PROPOSED_FIELD_LABELS[f]).join(', ');
  const kept = fetched.kept.length > 0 ? ` · kept what you typed: ${names(fetched.kept)}` : '';
  if (fetched.filled.length === 0) return `Nothing new in the chat${kept}.`;
  return `Filled from the chat: ${names(fetched.filled)}${kept}.`;
}

/** The person typed in a field: it is theirs, and a choice on it is settled. */
export function editBookDate<K extends keyof BookDateDraft>(state: BookDateState, key: K, value: BookDateDraft[K]): BookDateState {
  const field = (PROPOSED_FIELDS as readonly string[]).includes(key) ? (key as ProposedField) : null;
  if (!field) return { ...state, draft: { ...state.draft, [key]: value } };
  const choices = { ...state.choices };
  delete choices[field];
  return {
    ...state,
    draft: { ...state.draft, [key]: value },
    edited: state.edited.includes(field) ? state.edited : [...state.edited, field],
    choices,
  };
}

/** The person picked one of two readings: its value, its words, and the choice settled. */
export function pickBookDateChoice(state: BookDateState, field: ProposedField, option: FieldOption): BookDateState {
  const choices = { ...state.choices };
  delete choices[field];
  const sources = { ...state.sources };
  if (option.text) sources[field] = { text: option.text, source: option.source };
  else delete sources[field];
  return {
    ...state,
    draft: withValue(state.draft, field, option.value, option.text),
    edited: state.edited.includes(field) ? state.edited : [...state.edited, field],
    sources,
    choices,
  };
}

/** What Save says while a field still has two readings to pick from; null when none has. */
export function pendingChoice(state: BookDateState): string | null {
  const field = PROPOSED_FIELDS.find((f) => state.choices[f]);
  return field ? `The chat reads two ways for the ${PROPOSED_FIELD_LABELS[field]}: choose one.` : null;
}

/** A whole number from a field, or null when it is empty; NaN when it is not one. */
export function countOf(field: string): number | null {
  const t = field.trim();
  if (!t) return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

/** SCRUM-825: the party's newest deposit request as the api sends it on the conversation's event. */
export interface EventChipDeposit {
  state: 'requested' | 'paid' | 'expired' | 'cancelled';
  amountSatang: number;
  /** A `requested` one the thread was handed to a person for. */
  overdue: boolean;
}

/**
 * The deposit's word on the chip (SCRUM-825): "Deposit requested ฿3,000"
 * while the family can pay, "Deposit overdue ฿3,000" once a person has it,
 * "Deposit paid ฿3,000" when the money landed, "Deposit link expired" when it
 * ran out; a cancelled request says nothing, as none was asked.
 */
export function depositChipWords(deposit: EventChipDeposit | null | undefined): string | null {
  if (!deposit) return null;
  const amount = bahtOf(deposit.amountSatang);
  switch (deposit.state) {
    case 'requested':
      return deposit.overdue ? `Deposit overdue ${amount}` : `Deposit requested ${amount}`;
    case 'paid':
      return `Deposit paid ${amount}`;
    case 'expired':
      return 'Deposit link expired';
    default:
      return null;
  }
}

/** SCRUM-820: what the thread says of a party the Events module deleted or archived. */
export const PARTY_REMOVED_LABEL = 'Party removed in the Events module';

/**
 * SCRUM-820: the conversation's event as the panel uses it. A party the Events
 * module no longer has (`removed`: deleted there, or archived) is not an event
 * to open: `event` is null, so Book Date and Create BEO are offered as on a
 * conversation with no date yet, and `removed` is what the thread names.
 */
export function eventLinkOf<E extends { removed?: boolean }>(event: E | null | undefined): { event: E | null; removed: E | null } {
  if (!event) return { event: null, removed: null };
  return event.removed === true ? { event: null, removed: event } : { event, removed: null };
}

/**
 * "Event: 21 Mar 2027 at Central Floresta", the conversation's chip; "· Archived"
 * once the Events module archived it; "· Deposit requested ฿3,000" (and the
 * deposit's other words) while a deposit request stands (SCRUM-825).
 */
export function eventChipLabel(event: { date: string; branchName: string | null; archived?: boolean; deposit?: EventChipDeposit | null }): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.date);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = m ? `${Number(m[3])} ${names[Number(m[2]) - 1]} ${m[1]}` : event.date;
  const deposit = depositChipWords(event.deposit);
  return `Event: ${day}${event.branchName ? ` at ${event.branchName}` : ''}${event.archived ? ' · Archived' : ''}${deposit ? ` · ${deposit}` : ''}`;
}
