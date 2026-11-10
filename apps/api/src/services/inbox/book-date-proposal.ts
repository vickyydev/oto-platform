import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema as s, type Db } from '@oto/db';
import {
  BOOK_DATE_TIMEOUT_MS,
  readBookDateProposal,
  type BookDateChatLine,
  type BookDateOutcome,
  type BookDateProposalReading,
  type BookDateProposed,
  type BookDateReader,
  type BookDateRequest,
} from '@oto/assistant';
import {
  INBOX_DAY_TIMEZONE,
  InboxBookDateProposalSchema,
  branchToday,
  readChatPartyDate,
  type InboxBookDateProposal,
  type InboxBeoTranscriptLine,
} from '@oto/shared';
import { errors } from '../../lib/errors';
import { BEO_CONFIRMATION_MESSAGES, beoTranscriptOf } from './beo-confirmation';
import { loadVisibleConversation, type InboxViewer } from './read-visibility';

/**
 * BOOK DATE'S VALUES, READ FROM THE WHOLE CHAT BY THE MODEL (SCRUM-821).
 *
 * The Book Date dialog opens at once with the pattern reading of the chat
 * (the prototype's rules and SCRUM-814's date and time reader) and then asks
 * here (`GET /inbox/conversations/{id}/book-date-proposal`). Those patterns
 * need words spelled exactly, so a chat typed fast on a phone ("12 kds and 4
 * adust, sat 21 novmber", "12 детй и 4 взрослх, 21 ноабря") left the dialog
 * with empty or wrong numbers. Here one structured model call (`@oto/assistant`
 * book-date.ts) reads the conversation and proposes the party's date, start
 * time, kids, adults, the child's name and age and the park the chat names,
 * each with the chat's own words and the message they are in, the team's
 * confirmation winning where the family and the team both speak (as SCRUM-815
 * rules the BEO's fill).
 *
 * THE LINES are the BEO fill's transcript (`beoTranscriptOf`, SCRUM-815): the
 * family's lines and the team's received ones, never the assistant's, a
 * system notice, an erased line or one the channel refused; the newest 200
 * within the 60 days before the newest. Each line goes to the model with its
 * local time at the park, and the park's today and zone ride with them.
 *
 * NEVER A 500 FROM THE MODEL. No model configured here (the inbox assistant
 * switched off, no key, or under tests without a fake), no lines to read, a
 * provider failure, a refusal, a cut-off or malformed answer, or a throw: the
 * answer is `model: 'unavailable'` with no proposal, and the dialog keeps
 * the pattern reading. What the model proposes is checked before it is
 * answered (`readBookDateProposal`): a value with no line of the chat behind
 * it, a date gone by or no calendar day, a time that is no clock time, a
 * count out of range, or a park the operator does not have is left out.
 *
 * WHO: whoever can see the conversation, as `GET …/beo-confirmation` reads it
 * (`inbox:conversation:read`, then the conversation's own visibility; 404 when
 * they cannot see it). Only a Birthdays & Events conversation (409
 * NOT_A_BIRTHDAY). A read: nothing is written and nothing is audited; one log
 * line gives the outcome and the latency, never the chat.
 */

export const BOOK_DATE_PROPOSAL_MESSAGES = {
  notABirthday: BEO_CONFIRMATION_MESSAGES.notABirthday,
} as const;

/** What `book-date-proposal` asks per signed-in caller: a model call each. */
export const BOOK_DATE_PROPOSAL_RATE = { max: 30, timeWindow: 60_000 } as const;

const STAMP_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** An instant as `YYYY-MM-DD HH:MM`, local at the park. */
export function parkLocalStamp(iso: string, timeZone: string): string {
  let f = STAMP_FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    STAMP_FORMATTERS.set(timeZone, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(iso))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

type Proposal = NonNullable<InboxBookDateProposal['proposal']>;

/** The checked reading as the route answers it: each value with its message. */
function answerOf(reading: BookDateProposalReading, transcript: readonly InboxBeoTranscriptLine[]): Proposal {
  const at = <T>(p: BookDateProposed<T> | null) =>
    p && transcript[p.line] ? { value: p.value, text: p.text, source: p.source, messageId: transcript[p.line]!.id } : null;
  return {
    date: at(reading.date),
    startTime: at(reading.startTime),
    kids: at(reading.kids),
    adults: at(reading.adults),
    childName: at(reading.childName),
    childAge: at(reading.childAge),
    branchHint: at(reading.park),
  };
}

export interface BookDateProposalDeps {
  db: Db;
  /** The model; null when none is configured (the answer is then `unavailable`). */
  reader: BookDateReader | null;
  log: FastifyBaseLogger;
  now?: Date;
  /** The longest the answer waits for the model, past the client's own timeout; tests shorten it. */
  deadlineMs?: number;
}

/** The reader's answer within `ms`, never a throw. */
async function readWithin(reader: BookDateReader, request: BookDateRequest, ms: number): Promise<BookDateOutcome> {
  const started = Date.now();
  const failed = (reason: 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR'): BookDateOutcome => ({
    ok: false,
    reason,
    error: null,
    usage: null,
    model: null,
    requestId: null,
    latencyMs: Date.now() - started,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BookDateOutcome>((resolve) => {
    timer = setTimeout(() => resolve(failed('PROVIDER_TIMEOUT')), ms);
  });
  // The reader never throws by contract; a throw is its class's business, never this answer's.
  const call = reader.read(request).catch((): BookDateOutcome => failed('PROVIDER_ERROR'));
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The conversation's Book Date proposal, as the header says; a read. */
export async function bookDateProposalOf(
  deps: BookDateProposalDeps,
  viewer: InboxViewer,
  conversationId: string,
): Promise<InboxBookDateProposal> {
  const { db, reader, log } = deps;
  const now = deps.now ?? new Date();
  const conv = await loadVisibleConversation(db, viewer, conversationId);
  if (conv.category !== 'birthdays') {
    throw errors.conflict('NOT_A_BIRTHDAY', BOOK_DATE_PROPOSAL_MESSAGES.notABirthday);
  }

  const parks = await db
    .select({ id: s.branch.id, name: s.branch.name, code: s.branch.code, timezone: s.branch.timezone })
    .from(s.branch)
    .where(and(eq(s.branch.operatorId, viewer.operatorId), isNull(s.branch.archivedAt)))
    .orderBy(asc(s.branch.name), asc(s.branch.id));
  const timeZone = parks.find((p) => p.id === conv.branchId)?.timezone ?? INBOX_DAY_TIMEZONE;
  const today = branchToday(timeZone, now);

  const { transcript } = await beoTranscriptOf(db, viewer.operatorId, conv.id);
  const pattern = readChatPartyDate(
    transcript.map((l) => ({ text: l.text, team: l.author === 'staff', at: l.at })),
    now,
    timeZone,
  );
  const patternReading: InboxBookDateProposal['patternReading'] = {
    date: pattern.date,
    dateText: pattern.phrase,
    source: pattern.by === null ? null : pattern.by === 'team' ? 'team' : 'family',
    startTime: pattern.time,
    timeText: pattern.timePhrase,
  };
  const unavailable = (reason: string, outcome?: BookDateOutcome): InboxBookDateProposal => {
    log.info(
      {
        conversationId: conv.id,
        outcome: 'unavailable',
        reason,
        lines: transcript.length,
        model: outcome?.model ?? reader?.model ?? null,
        latencyMs: outcome?.latencyMs ?? null,
        requestId: outcome?.requestId ?? null,
      },
      'inbox.book_date_proposal',
    );
    return { conversationId: conv.id, model: 'unavailable', proposal: null, patternReading };
  };

  if (!reader) return unavailable('NO_MODEL');
  if (transcript.length === 0) return unavailable('NO_LINES');

  const request: BookDateRequest = {
    lines: transcript.map(
      (l): BookDateChatLine => ({ by: l.author === 'staff' ? 'team' : 'family', at: parkLocalStamp(l.at, timeZone), text: l.text }),
    ),
    today,
    timeZone,
    parks: parks.map((p) => ({ id: p.id, name: p.name, code: p.code })),
  };
  const outcome = await readWithin(reader, request, deps.deadlineMs ?? BOOK_DATE_TIMEOUT_MS + 2_000);
  if (!outcome.ok) return unavailable(outcome.reason, outcome);

  const proposal = answerOf(readBookDateProposal(outcome.reading, request), transcript);
  const answer: InboxBookDateProposal = { conversationId: conv.id, model: 'ai', proposal, patternReading };
  // The checks above keep every value inside the route's own schema; were one ever to slip, the answer is
  // the pattern reading's, never a 500.
  if (!InboxBookDateProposalSchema.safeParse(answer).success) return unavailable('INVALID_PROPOSAL', outcome);
  log.info(
    {
      conversationId: conv.id,
      outcome: 'ai',
      lines: transcript.length,
      model: outcome.model,
      latencyMs: outcome.latencyMs,
      requestId: outcome.requestId,
      // The model's usage, counted in its units (named so: a "token" key reads as a credential to the log lint).
      usageIn: outcome.usage.inputTokens,
      usageOut: outcome.usage.outputTokens,
      fields: Object.entries(proposal)
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
    },
    'inbox.book_date_proposal',
  );
  return answer;
}
