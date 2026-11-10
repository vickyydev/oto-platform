import { and, desc, eq, inArray, isNotNull, isNull, not, or, sql } from 'drizzle-orm';
import { schema as s, type Db } from '@oto/db';
import {
  mentionsPartyDate,
  mentionsPartyTime,
  type InboxBeoConfirmation,
  type InboxBeoTranscriptLine,
} from '@oto/shared';
import { errors } from '../../lib/errors';
import { loadVisibleConversation, type InboxViewer } from './read-visibility';
import { messageText } from './voice-notes';

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
 * THE CONVERSATION (SCRUM-815). The answer also carries `transcript`: the
 * conversation's lines oldest first, so the fill reads the whole agreement —
 * what the family asked for and what the team confirmed — and not one
 * message alone. A line is in it when it is
 *   - the family's (author `customer`, inbound), or a person on the team's on
 *     the channel, by the same rule as the confirmation above (outbound,
 *     `source` channel, a delivery state, not refused by the channel);
 *   - not erased (`redacted_at` null) and has text: its body, and a voice
 *     note's transcript marked `[voice note] …` (SCRUM-824, `messageText`).
 * The assistant's lines, system notices and mirrored notices never are.
 * Bounded: the newest `BEO_TRANSCRIPT_LIMIT` such lines, and none older than
 * `BEO_TRANSCRIPT_DAYS` days before the newest of them (the conversation's
 * own last 60 days, so the bound does not move with the clock); when a bound
 * left lines out, `transcriptCut` is true.
 *
 * WHO: whoever can see the conversation in the inbox — `inbox:conversation:
 * read` in their operator, then the conversation's own visibility, exactly as
 * `GET …/messages` reads it (404 when they cannot see it). Only a Birthdays &
 * Events conversation (409 NOT_A_BIRTHDAY). A read: nothing is written.
 */

/** How many of the team's newest messages are looked at. */
export const BEO_CONFIRMATION_SCAN = 100;

/** The most lines the transcript carries (SCRUM-815). */
export const BEO_TRANSCRIPT_LIMIT = 200;
/** The transcript reaches back this many days before its newest line. */
export const BEO_TRANSCRIPT_DAYS = 60;

export const BEO_CONFIRMATION_MESSAGES = {
  notABirthday: 'The BEO is filled only from conversations in Birthdays & Events.',
} as const;

/**
 * A team message the family never received: refused by the channel, or the
 * assistant's held-back and shadow lines (never a person's, but excluded by
 * name all the same; `shadow` is in the table's CHECK, not in the type).
 */
const neverReceived = () => sql`${s.message.providerStatus} in ('failed', 'withdrawn', 'shadow')`;

/*
 * A date and a time are read by the one reader the inbox's Book Date uses
 * (`@oto/shared` chat-dates, SCRUM-814): 21/03, 21.03.2027, 2027-03-21,
 * 21 March, March 21, 21 марта, 21-го ноября, 21 มีนาคม, 15 พ.ย., or a weekday
 * in the three languages; 14:00, 2pm, 2:30 pm, 14.00 น., เวลา 14.00, в 14.00,
 * 14 часов, บ่าย 2 โมง. "Today" and "tomorrow" alone are not a party's date
 * here: a reminder says them too.
 */

/** A guest count, food, or the programme. */
const DETAIL: RegExp[] = [
  /(?<!\d)\d{1,3}\s*(?:kids?|children|child|guests?|adults?|people|pax|persons?|детей|дет|ребен\S*|взрослых|гостей|человек|เด็ก|คน|ผู้ใหญ่|ท่าน)/i,
  /(?:menu|food|pizza|nugget|fries|snack|buffet|drinks?|juice|cake|меню|еда|пицц|наггетс|торт|напит|сок|เมนู|อาหาร|เค้ก|พิซซ่า|เครื่องดื่ม|ขนม|น้ำผลไม้)/i,
  /(?:animator|host|show|programme|program|package|games?|disco|bubble|magic|decoration|balloons?|photo ?zone|аниматор|ведущ|шоу|программ|пакет|игр|дискотек|декор|шар|фотозон|พิธีกร|นักแสดง|โชว์|แพ็กเกจ|แพ็คเกจ|กิจกรรม|เกม|ลูกโป่ง|ตกแต่ง|มายากล)/i,
];

/** Does this message carry a birthday's details: a date, a time, and one more party detail. */
export function carriesBirthdayDetails(body: string): boolean {
  const text = body.normalize('NFC');
  return mentionsPartyDate(text) && mentionsPartyTime(text) && DETAIL.some((r) => r.test(text));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The conversation's lines for the fill, oldest first, as the header says:
 * the family's and the team's received ones, never erased, bounded. The
 * caller has already checked the conversation is the viewer's to see.
 */
export async function beoTranscriptOf(
  db: Db,
  operatorId: string,
  conversationId: string,
): Promise<{ transcript: InboxBeoTranscriptLine[]; transcriptCut: boolean }> {
  const familys = and(eq(s.message.authorKind, 'customer'), eq(s.message.direction, 'inbound'));
  const teams = and(
    eq(s.message.authorKind, 'staff'),
    eq(s.message.direction, 'outbound'),
    eq(s.message.source, 'channel'),
    isNotNull(s.message.providerStatus),
    not(neverReceived()),
  );
  const rows = await db
    .select({
      id: s.message.id,
      authorKind: s.message.authorKind,
      body: s.message.body,
      transcript: s.message.transcript,
      sentAt: s.message.sentAt,
      createdAt: s.message.createdAt,
    })
    .from(s.message)
    .where(
      and(
        eq(s.message.operatorId, operatorId),
        eq(s.message.conversationId, conversationId),
        isNull(s.message.redactedAt),
        or(familys, teams),
        or(
          and(isNotNull(s.message.body), sql`btrim(${s.message.body}) <> ''`),
          and(isNotNull(s.message.transcript), sql`btrim(${s.message.transcript}) <> ''`),
        ),
      ),
    )
    .orderBy(desc(s.message.createdAt), desc(s.message.id))
    .limit(BEO_TRANSCRIPT_LIMIT + 1);

  const newest = rows[0]?.createdAt;
  if (!newest) return { transcript: [], transcriptCut: false };
  const since = newest.getTime() - BEO_TRANSCRIPT_DAYS * DAY_MS;
  const inBounds = rows.slice(0, BEO_TRANSCRIPT_LIMIT).filter((m) => m.createdAt.getTime() >= since);
  const transcript = inBounds.reverse().map((m) => ({
    id: m.id,
    author: m.authorKind === 'customer' ? ('customer' as const) : ('staff' as const),
    at: (m.sentAt ?? m.createdAt).toISOString(),
    // SCRUM-824: a voice note's transcript, marked `[voice note] …` so the model knows it was spoken.
    text: messageText(m) as string,
  }));
  return { transcript, transcriptCut: rows.length > transcript.length };
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
  const { transcript, transcriptCut } = await beoTranscriptOf(db, viewer.operatorId, conv.id);
  return {
    conversationId: conv.id,
    eventId: conv.eventOrderRef ?? null,
    transcript,
    transcriptCut,
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
