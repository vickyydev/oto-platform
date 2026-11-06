import { and, desc, eq, inArray, isNotNull, isNull, not, sql } from 'drizzle-orm';
import { schema as s, type Db } from '@oto/db';
import type { InboxBeoConfirmation } from '@oto/shared';
import { errors } from '../../lib/errors';
import { loadVisibleConversation, type InboxViewer } from './read-visibility';

/**
 * THE MESSAGE A BIRTHDAY'S BEO IS FILLED FROM (SCRUM-660).
 *
 * The birthday manager sends the family one final confirmation — the date,
 * the time, the programme, the food and the other requests — and the OTO
 * App's AI Fill reads it into the BEO form, so nobody types the same details
 * twice. The inbox's Create BEO lands on that form; the app then asks here
 * (`GET /inbox/conversations/{id}/beo-confirmation`), server to server and as
 * the same signed-in person, for the message to read. The text never rides a
 * URL or the hand-off.
 *
 * WHICH MESSAGE, conservatively: the newest one that
 *   - a person on the team wrote (author `staff`, outbound, on the channel —
 *     never the customer's, the assistant's, a system notice or a mirrored
 *     notice), still has its text (not erased), and was not refused by the
 *     channel (`failed`; `withdrawn` and `shadow` are the assistant's and
 *     never reached the family);
 *   - and names a date, a time and at least one more party detail: a guest
 *     count, food or the programme (`carriesBirthdayDetails`), in Thai,
 *     English or Russian.
 * Among the team's newest `BEO_CONFIRMATION_SCAN` messages. A reminder that
 * names only the date and time, a price quote, or a greeting is passed over;
 * none at all answers `message: null`, and the form opens without the fill.
 * The person sees the message that was read before anything is applied.
 *
 * WHO: whoever can see the conversation in the inbox — `inbox:conversation:
 * read` in their operator, then the conversation's own visibility, exactly as
 * `GET …/messages` reads it (404 when they cannot see it). Only a Birthdays &
 * Events conversation (409 NOT_A_BIRTHDAY). A read: nothing is written.
 */

/** How many of the team's newest messages are looked at. */
export const BEO_CONFIRMATION_SCAN = 100;

export const BEO_CONFIRMATION_MESSAGES = {
  notABirthday: 'The BEO is filled only from conversations in Birthdays & Events.',
} as const;

/**
 * A team message the family never received: refused by the channel, or the
 * assistant's held-back and shadow lines (never a person's, but excluded by
 * name all the same; `shadow` is in the table's CHECK, not in the type).
 */
const neverReceived = () => sql`${s.message.providerStatus} in ('failed', 'withdrawn', 'shadow')`;

const MONTHS_EN =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS_RU = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const MONTHS_TH =
  'มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|' +
  'ม\\.ค|ก\\.พ|มี\\.ค|เม\\.ย|พ\\.ค|มิ\\.ย|ก\\.ค|ส\\.ค|ก\\.ย|ต\\.ค|พ\\.ย|ธ\\.ค';

/** A date: 21/03, 21.03.2027, 2027-03-21, 21 March, March 21, 21 марта, 21 มีนาคม, or a weekday. */
const DATE: RegExp[] = [
  /(?<![\d.:/-])(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])(?:[./-](?:\d{4}|\d{2}))?(?![\d:])/,
  /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/,
  new RegExp(`(?<!\\d)\\d{1,2}(?:st|nd|rd|th)?\\s*(?:of\\s+)?(?:${MONTHS_EN})\\b`, 'i'),
  new RegExp(`\\b(?:${MONTHS_EN})\\.?\\s+\\d{1,2}(?!\\d)`, 'i'),
  new RegExp(`(?<!\\d)\\d{1,2}\\s*(?:${MONTHS_RU})`, 'i'),
  new RegExp(`(?<!\\d)\\d{1,2}\\s*(?:${MONTHS_TH})`),
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /(?:понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье)/i,
  /(?:วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัส|วันศุกร์|วันเสาร์|วันอาทิตย์)/,
];

/** A time: 14:00, 2pm, 2:30 pm, 14.00 น., เวลา 14.00, в 14.00, 14 часов, บ่าย 2 โมง. */
const TIME: RegExp[] = [
  /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/,
  /(?<![\d:.])(?:1[0-2]|0?[1-9])(?:[:.][0-5]\d)?\s*(?:am|pm|a\.m\.|p\.m\.)/i,
  /(?<![\d.])(?:[01]?\d|2[0-3])\.[0-5]\d\s*น/,
  /(?:เวลา|в)\s*(?:[01]?\d|2[0-3])[.:][0-5]\d(?!\d)/i,
  /(?<!\d)\d{1,2}\s*(?:час|โมง|นาฬิกา)/i,
];

/** A guest count, food, or the programme. */
const DETAIL: RegExp[] = [
  /(?<!\d)\d{1,3}\s*(?:kids?|children|child|guests?|adults?|people|pax|persons?|детей|дет|ребен\S*|взрослых|гостей|человек|เด็ก|คน|ผู้ใหญ่|ท่าน)/i,
  /(?:menu|food|pizza|nugget|fries|snack|buffet|drinks?|juice|cake|меню|еда|пицц|наггетс|торт|напит|сок|เมนู|อาหาร|เค้ก|พิซซ่า|เครื่องดื่ม|ขนม|น้ำผลไม้)/i,
  /(?:animator|host|show|programme|program|package|games?|disco|bubble|magic|decoration|balloons?|photo ?zone|аниматор|ведущ|шоу|программ|пакет|игр|дискотек|декор|шар|фотозон|พิธีกร|นักแสดง|โชว์|แพ็กเกจ|แพ็คเกจ|กิจกรรม|เกม|ลูกโป่ง|ตกแต่ง|มายากล)/i,
];

/** Does this message carry a birthday's details: a date, a time, and one more party detail. */
export function carriesBirthdayDetails(body: string): boolean {
  const text = body.normalize('NFC');
  return DATE.some((r) => r.test(text)) && TIME.some((r) => r.test(text)) && DETAIL.some((r) => r.test(text));
}

/** The conversation's confirmation message, chosen as the header says; a read. */
export async function beoConfirmationOf(
  db: Db,
  viewer: InboxViewer,
  conversationId: string,
): Promise<InboxBeoConfirmation> {
  const conv = await loadVisibleConversation(db, viewer, conversationId);
  if (conv.category !== 'birthdays') {
    throw errors.conflict('NOT_A_BIRTHDAY', BEO_CONFIRMATION_MESSAGES.notABirthday);
  }
  const rows = await db
    .select({
      id: s.message.id,
      body: s.message.body,
      bodyLanguage: s.message.bodyLanguage,
      authorAccountId: s.message.authorAccountId,
      sentAt: s.message.sentAt,
      createdAt: s.message.createdAt,
    })
    .from(s.message)
    .where(
      and(
        eq(s.message.operatorId, viewer.operatorId),
        eq(s.message.conversationId, conv.id),
        eq(s.message.authorKind, 'staff'),
        eq(s.message.direction, 'outbound'),
        eq(s.message.source, 'channel'),
        isNull(s.message.redactedAt),
        isNotNull(s.message.body),
        isNotNull(s.message.providerStatus),
        not(neverReceived()),
      ),
    )
    .orderBy(desc(s.message.createdAt), desc(s.message.id))
    .limit(BEO_CONFIRMATION_SCAN);

  const chosen = rows.find((m) => typeof m.body === 'string' && carriesBirthdayDetails(m.body));
  let authorName: string | null = null;
  if (chosen?.authorAccountId) {
    const [author] = await db
      .select({ name: s.employee.name })
      .from(s.account)
      .leftJoin(s.employee, eq(s.employee.id, s.account.employeeId))
      .where(and(eq(s.account.operatorId, viewer.operatorId), inArray(s.account.id, [chosen.authorAccountId])))
      .limit(1);
    authorName = author?.name ?? null;
  }
  return {
    conversationId: conv.id,
    eventId: conv.eventOrderRef ?? null,
    message: chosen
      ? {
          id: chosen.id,
          body: chosen.body as string,
          bodyLanguage: chosen.bodyLanguage,
          authorName,
          sentAt: chosen.sentAt ? chosen.sentAt.toISOString() : null,
          createdAt: chosen.createdAt.toISOString(),
        }
      : null,
    scanned: rows.length,
  };
}
