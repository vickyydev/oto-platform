import { and, eq, isNull, sql } from 'drizzle-orm';
import { AI_REPLY_LANGUAGES, BY_BRANCH, resolvePlan, type AiReplyLanguage, type GateVerdict } from '@oto/assistant';
import { aiTurn, conversation, fileObject, message, type Db, type MessageTranscriptStatus } from '@oto/db';
import type { FastifyBaseLogger } from 'fastify';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import { recordRun } from '../ops';
import { withTx, type Tx } from '../tx';
import {
  TRANSCRIPTION_LANGUAGE_HINTS,
  transcribe,
  type TranscriptionFailureReason,
  type TranscriptionOutcome,
  type TranscriptionRuntime,
} from './transcription';

/**
 * A CUSTOMER'S VOICE NOTE, READ LIKE TYPED TEXT (SCRUM-824 part a).
 *
 * THE FLOW. With a transcription provider configured (`app.inboxTranscription`,
 * the runtime this job asks), a voice note is `pending` from the moment the
 * ingest files it (`ingest.ts`); with none it is `off` there at once, and
 * nothing waits for it. Its audio is stored after the delivery commits
 * (`media.ts`; a pending one that cannot be stored is settled there:
 * `too_long` over the size limit, else `failed`). `job:inbox.transcribe`, every fifteen seconds,
 * claims a batch of pending notes under a lease (as the send job claims its
 * rows), reads each one's audio back from storage, and asks the transcription
 * boundary (`transcription.ts`). Then, in one transaction with its audit row:
 *   - the words → `transcript`, its language → `transcript_language`, `done`;
 *   - over the length limit → `too_long`, never sent;
 *   - a refusal asking again could help (a timeout, a rate limit, the
 *     provider down) → asked again in 15 s, then in 60 s: the first ask and
 *     two retries, then `failed`; one it cannot help (a refused file, a
 *     format no provider takes, nothing heard) → `failed` at once;
 *   - no provider configured → `off`, "not transcribed", as before (the
 *     ingest already filed it so; this sweep is the safety net for a note
 *     filed pending before a provider was switched off).
 * A note whose audio never arrived is `failed` two minutes after the note
 * reached us: the deadline the ingest wrote in `transcript_next_attempt_at`,
 * on our clock — never the message's `created_at`, the provider's timestamp,
 * which a redelivery leaves minutes old.
 * Every provider call is an `ops_run` (`adapter:inbox.transcription`): ids,
 * the outcome word, latency, the length and the language — never the words.
 *
 * WHAT READS IT. `messageText` is the one reading of a message's words for a
 * model: the body, and the transcript marked `[voice note] …` so the model
 * knows it was spoken. The assistant's episode, Book Date's whole-chat read
 * and the conversation handed to the BEO fill all read it.
 *
 * THE ASSISTANT WAITS (`voiceHold`, read by `ai-engine.ts` once per turn): a
 * burst holding a note still `pending` makes no model call and no reply — the
 * turn goes back to `pending` for ten seconds (`holdTurnForTranscript`) and is
 * decided on the transcript once it lands. A note that could not be read
 * (`failed`, `too_long`, or still pending five minutes after the turn was
 * born — our clock, not the provider's) hands the thread
 * to a person with the playbook's warm holding line, the turn's reason
 * `VOICE_UNREAD` ("voice note could not be read" on the staff side). A note
 * that is `off` is what it was before: no words, a person's to pick up.
 *
 * NOTHING HERE LOGS, AUDITS OR RECORDS THE WORDS. An erased message is never
 * claimed, and a transcript that lands after an erasure is not written.
 */

export const INBOX_TRANSCRIBE_JOB = 'job:inbox.transcribe';
export const INBOX_TRANSCRIBE_INTERVAL_S = 15;
/** Notes one tick transcribes at most; the rest wait for the next tick. */
export const TRANSCRIBE_BATCH = 10;
/** The first ask and two retries. */
export const TRANSCRIBE_MAX_ATTEMPTS = 3;
/** How long a claim holds a note while the provider is asked. */
export const TRANSCRIBE_LEASE_MS = 3 * 60_000;
/** When a retry is due after the first and the second failed ask. */
export const TRANSCRIBE_RETRY_MS: readonly number[] = [15_000, 60_000];
/**
 * A pending note whose audio never arrived is given up this long after the
 * note reached us (the ingest writes the deadline in `transcript_next_attempt_at`).
 */
export const VOICE_MEDIA_GRACE_MS = 2 * 60_000;
/**
 * The assistant waits at most this long for a transcript, from the note's
 * arrival as our clock saw it: the later of its own time and the turn's birth
 * (`voiceHold`).
 */
export const VOICE_WAIT_MAX_MS = 5 * 60_000;
/** A waiting turn is looked at again this often. */
export const VOICE_WAIT_STEP_MS = 10_000;
/** The turn's reason word while it waits, and when a note could not be read. */
export const TRANSCRIPT_PENDING = 'TRANSCRIPT_PENDING';
export const VOICE_UNREAD = 'VOICE_UNREAD';
/** How a transcript is marked where a model reads it. */
export const VOICE_NOTE_MARK = '[voice note]';

// --- The one reading of a message's words -----------------------------------------------------

/**
 * A message's words as a model reads them: its body, and a voice note's
 * transcript marked `[voice note] …`; both when it has both; null when it has
 * neither (an image, a sticker, a note not transcribed).
 */
export function messageText(m: { body: string | null; transcript?: string | null }): string | null {
  const body = m.body !== null && m.body.trim() !== '' ? m.body : null;
  const spoken = m.transcript ? m.transcript.trim() : '';
  const heard = spoken ? `${VOICE_NOTE_MARK} ${spoken}` : null;
  if (body !== null && heard !== null) return `${body}\n${heard}`;
  return body ?? heard;
}

// --- The assistant's wait ---------------------------------------------------------------------

/**
 * What the customer's open burst says of the assistant's turn: `wait` while a
 * voice note in it is still being transcribed; `unread` when one could not be
 * read (or is still pending past `VOICE_WAIT_MAX_MS`); null otherwise.
 *
 * The wait is counted on OUR clock: from the later of the note's own time and
 * `turnBornAt` (the turn's `first_seen_at`, written when the burst's first
 * bubble reached us). A message's `at` is the provider's timestamp, which a
 * redelivered webhook leaves minutes old: counted from it alone, a late note
 * would be "unread" before anyone tried to read it.
 */
export function voiceHold(
  burst: ReadonlyArray<{ at: Date; voice?: MessageTranscriptStatus | null }>,
  now: Date,
  turnBornAt: Date,
): 'wait' | 'unread' | null {
  let unread = false;
  for (const m of burst) {
    if (m.voice === 'pending') {
      const since = Math.max(m.at.getTime(), turnBornAt.getTime());
      if (now.getTime() - since < VOICE_WAIT_MAX_MS) return 'wait';
      unread = true;
    } else if (m.voice === 'failed' || m.voice === 'too_long') {
      unread = true;
    }
  }
  return unread ? 'unread' : null;
}

/**
 * The turn a voice note nobody could read makes, with no model call: the
 * playbook's "Unclear or not covered" hand-over (a withheld reply's path, item
 * D) — its warm holding line in the thread's language, the thread to its park
 * when it is known, else the GM; a number whose silence policy covers it keeps
 * its silence. The turn's reason is `VOICE_UNREAD`.
 */
export function voiceUnreadTurn(conv: { language: string | null; branchId: string | null }): {
  verdict: GateVerdict;
  withheld: true;
  turnReason: typeof VOICE_UNREAD;
} {
  const language = (AI_REPLY_LANGUAGES as readonly string[]).includes(conv.language ?? '')
    ? (conv.language as AiReplyLanguage)
    : 'en';
  return {
    verdict: {
      action: 'handover',
      reason: 'OVERRULED_HANDOVER',
      intent: 'other',
      intents: ['other'],
      language,
      plan: resolvePlan(BY_BRANCH, conv.branchId !== null),
      holdingBubbles: [],
      droppedHoldingRule: 'voice_unread',
      branchNamed: null,
    },
    withheld: true,
    turnReason: VOICE_UNREAD,
  };
}

/**
 * A claimed turn handed back to wait for its transcript, inside the commit's
 * transaction (the caller holds the thread and the turn): `pending` again, due
 * in `VOICE_WAIT_STEP_MS`, the claim's attempt given back.
 */
export async function holdTurnForTranscript(
  tx: Tx,
  turn: typeof aiTurn.$inferSelect,
  conv: { id: string; branchId: string | null },
  at: Date,
): Promise<void> {
  const dueAt = new Date(at.getTime() + VOICE_WAIT_STEP_MS);
  await tx
    .update(aiTurn)
    .set({
      state: 'pending',
      dueAt,
      attempts: sql`greatest(${aiTurn.attempts} - 1, 0)`,
      leaseUntil: null,
      reason: TRANSCRIPT_PENDING,
      updatedAt: at,
    })
    .where(and(eq(aiTurn.operatorId, turn.operatorId), eq(aiTurn.id, turn.id)));
  await audit.record(tx, {
    actorAccountId: null,
    action: 'inbox.ai.turn.wait',
    entityType: 'inbox.ai_turn',
    entityId: turn.id,
    operatorId: turn.operatorId,
    branchId: conv.branchId,
    requestId: null,
    before: { state: 'deciding', attempts: turn.attempts },
    after: { turnId: turn.id, conversationId: conv.id, state: 'pending', reason: TRANSCRIPT_PENDING, dueAt: dueAt.toISOString() },
  });
}

// --- The job ----------------------------------------------------------------------------------

export interface TranscribeDeps {
  runtime: TranscriptionRuntime;
  storage: FileStorage | null;
  log?: FastifyBaseLogger;
}

export interface TranscribeSweep extends Record<string, unknown> {
  due: number;
  done: number;
  failed: number;
  tooLong: number;
  off: number;
  retried: number;
  givenUp: number;
  errors: number;
}

type Settled = Exclude<MessageTranscriptStatus, 'pending'>;

/** What became of one claimed note, as the sweep counts it. */
type Tally = 'done' | 'failed' | 'tooLong' | 'off' | 'retried' | 'errors';

interface Claimed {
  id: string;
  operatorId: string;
  conversationId: string;
  audioFileId: string;
  attempts: number;
}

/** Writes a note's outcome with its audit row; only a note still pending, not erased, with the same audio. */
async function settle(
  db: Db,
  note: { id: string; operatorId: string; conversationId: string; audioFileId: string | null },
  status: Settled,
  now: Date,
  extra: { transcript?: string; language?: string | null; reason?: string | null; durationSeconds?: number | null; attempts?: number },
  log?: FastifyBaseLogger,
): Promise<boolean> {
  const [conv] = await db
    .select({ branchId: conversation.branchId })
    .from(conversation)
    .where(and(eq(conversation.operatorId, note.operatorId), eq(conversation.id, note.conversationId)))
    .limit(1);
  const branchId = conv?.branchId ?? null;
  return withTx(db, { operatorId: note.operatorId, branchId, ...(log ? { log } : {}) }, 'inbox.message.transcribe', async (tx) => {
    const done = status === 'done';
    const rows = await tx
      .update(message)
      .set({
        transcriptStatus: status,
        ...(done ? { transcript: extra.transcript ?? null, transcriptLanguage: extra.language ?? null } : {}),
        transcriptNextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(message.operatorId, note.operatorId),
          eq(message.id, note.id),
          eq(message.transcriptStatus, 'pending'),
          isNull(message.redactedAt),
          note.audioFileId === null ? isNull(message.audioFileId) : eq(message.audioFileId, note.audioFileId),
        ),
      )
      .returning({ id: message.id });
    if (rows.length === 0) return false;
    await audit.record(tx, {
      actorAccountId: null,
      action: 'inbox.message.transcribe',
      entityType: 'inbox.message',
      entityId: note.id,
      operatorId: note.operatorId,
      branchId,
      requestId: null,
      before: { transcriptStatus: 'pending' },
      // Ids, words and numbers only: never the transcript.
      after: {
        messageId: note.id,
        conversationId: note.conversationId,
        transcriptStatus: status,
        language: done ? (extra.language ?? null) : null,
        reason: extra.reason ?? null,
        durationSeconds: extra.durationSeconds ?? null,
        attempts: extra.attempts ?? null,
      },
    });
    return true;
  });
}

/** One provider call as its ops run: ids, the outcome word, latency, length and language. */
async function recordTranscription(
  db: Db,
  note: Claimed,
  outcome: TranscriptionOutcome,
  startedAt: Date,
): Promise<void> {
  await recordRun(db, {
    kind: 'adapter',
    name: 'adapter:inbox.transcription',
    outcome: outcome.ok ? 'ok' : 'failed',
    startedAt,
    operatorId: note.operatorId,
    detail: {
      messageId: note.id,
      conversationId: note.conversationId,
      outcome: outcome.ok ? 'ok' : outcome.reason,
      model: outcome.model,
      latencyMs: outcome.latencyMs,
      durationSeconds: outcome.durationSeconds,
      language: outcome.ok ? outcome.language : null,
      attempt: note.attempts,
      status: outcome.ok ? null : outcome.status,
    },
    ...(outcome.ok ? {} : { error: Object.assign(new Error(`inbox transcription ${outcome.reason}`), { name: outcome.reason }) }),
  });
}

/** One claimed note, start to finish. Answers what became of it. */
async function transcribeOne(db: Db, deps: TranscribeDeps, note: Claimed, now: Date): Promise<Tally> {
  const fail = async (
    reason: TranscriptionFailureReason | 'MEDIA_MISSING' | 'STORAGE_UNREADABLE',
    status: Settled = 'failed',
    durationSeconds: number | null = null,
  ): Promise<Tally> =>
    (await settle(db, note, status, now, { reason, durationSeconds, attempts: note.attempts }, deps.log))
      ? status === 'too_long'
        ? 'tooLong'
        : 'failed'
      : 'errors';
  const [file] = await db
    .select({ objectKey: fileObject.objectKey, contentType: fileObject.contentType })
    .from(fileObject)
    .where(and(eq(fileObject.operatorId, note.operatorId), eq(fileObject.id, note.audioFileId)))
    .limit(1);
  if (!file) return fail('MEDIA_MISSING');
  if (!deps.storage?.get) return fail('STORAGE_UNREADABLE');

  const startedAt = new Date();
  let outcome: TranscriptionOutcome;
  try {
    const bytes = await deps.storage.get(file.objectKey);
    outcome = await transcribe(deps.runtime, {
      bytes,
      contentType: file.contentType,
      languageHints: TRANSCRIPTION_LANGUAGE_HINTS,
    });
  } catch {
    // The store did not answer: worth another try, as a provider outage is.
    outcome = { ok: false, reason: 'PROVIDER_UNAVAILABLE', retryable: true, status: null, model: null, latencyMs: 0, durationSeconds: null };
  }
  await recordTranscription(db, note, outcome, startedAt);

  if (outcome.ok) {
    const written = await settle(
      db,
      note,
      'done',
      now,
      { transcript: outcome.text, language: outcome.language, durationSeconds: outcome.durationSeconds, attempts: note.attempts },
      deps.log,
    );
    return written ? 'done' : 'errors';
  }
  if (outcome.reason === 'TOO_LONG') return fail('TOO_LONG', 'too_long', outcome.durationSeconds);
  if (outcome.reason === 'NOT_CONFIGURED') {
    return (await settle(db, note, 'off', now, { reason: 'NOT_CONFIGURED' }, deps.log)) ? 'off' : 'errors';
  }
  if (outcome.retryable && note.attempts < TRANSCRIBE_MAX_ATTEMPTS) {
    const wait = TRANSCRIBE_RETRY_MS[Math.min(note.attempts, TRANSCRIBE_RETRY_MS.length) - 1] ?? TRANSCRIBE_RETRY_MS.at(-1)!;
    await db
      .update(message)
      .set({ transcriptNextAttemptAt: new Date(now.getTime() + wait), updatedAt: now })
      .where(and(eq(message.operatorId, note.operatorId), eq(message.id, note.id), eq(message.transcriptStatus, 'pending')));
    return 'retried';
  }
  return fail(outcome.reason, 'failed', outcome.durationSeconds);
}

/** `job:inbox.transcribe`: one tick. Counts only in the run's detail. */
export async function runInboxTranscribeJob(db: Db, deps: TranscribeDeps, now: Date): Promise<TranscribeSweep> {
  const sweep: TranscribeSweep = { due: 0, done: 0, failed: 0, tooLong: 0, off: 0, retried: 0, givenUp: 0, errors: 0 };
  const at = now.toISOString();

  // No provider: every pending note is "not transcribed", as before SCRUM-824.
  // The ingest already files a note `off` when there is none; this is the
  // safety net for one filed pending before the provider was switched off.
  if (!deps.runtime.adapter) {
    const pending = await db
      .select({ id: message.id, operatorId: message.operatorId, conversationId: message.conversationId, audioFileId: message.audioFileId })
      .from(message)
      .where(and(eq(message.transcriptStatus, 'pending'), isNull(message.redactedAt)))
      .orderBy(message.createdAt, message.id)
      .limit(TRANSCRIBE_BATCH * 10);
    for (const note of pending) {
      try {
        if (await settle(db, note, 'off', now, { reason: 'NOT_CONFIGURED' }, deps.log)) sweep.off += 1;
      } catch (err) {
        sweep.errors += 1;
        deps.log?.error({ messageId: note.id, error: err instanceof Error ? err.constructor.name : 'NonError' }, 'a voice note could not be marked not transcribed');
      }
    }
    return sweep;
  }

  // Given up: audio that never arrived by the deadline the ingest set (two
  // minutes after the note reached us, on our clock: never `created_at`, the
  // provider's timestamp), and a last attempt whose lease ran out.
  const stale = await db
    .select({
      id: message.id,
      operatorId: message.operatorId,
      conversationId: message.conversationId,
      audioFileId: message.audioFileId,
      attempts: message.transcriptAttempts,
    })
    .from(message)
    .where(
      and(
        eq(message.transcriptStatus, 'pending'),
        isNull(message.redactedAt),
        sql`((${message.audioFileId} is null and ${message.transcriptNextAttemptAt} <= ${at}::timestamptz)
          or (${message.transcriptAttempts} >= ${TRANSCRIBE_MAX_ATTEMPTS} and ${message.transcriptNextAttemptAt} <= ${at}::timestamptz))`,
      ),
    )
    .limit(TRANSCRIBE_BATCH);
  for (const note of stale) {
    try {
      const reason = note.audioFileId === null ? 'MEDIA_MISSING' : 'PROVIDER_TIMEOUT';
      if (await settle(db, note, 'failed', now, { reason, attempts: note.attempts }, deps.log)) sweep.givenUp += 1;
    } catch (err) {
      sweep.errors += 1;
      deps.log?.error({ messageId: note.id, error: err instanceof Error ? err.constructor.name : 'NonError' }, 'a voice note could not be given up');
    }
  }

  // The claim, in one statement: two ticks or two instances never ask for the same note.
  const leaseUntil = new Date(now.getTime() + TRANSCRIBE_LEASE_MS).toISOString();
  const claimed = (
    await db.execute<{ id: string; operator_id: string; conversation_id: string; audio_file_id: string; transcript_attempts: number }>(sql`
      update inbox.message m
         set transcript_attempts = m.transcript_attempts + 1,
             transcript_next_attempt_at = ${leaseUntil}::timestamptz,
             updated_at = ${at}::timestamptz
       where m.id in (select q.id from inbox.message q
                       where q.transcript_status = 'pending'
                         and q.audio_file_id is not null
                         and q.redacted_at is null
                         and q.transcript_attempts < ${TRANSCRIBE_MAX_ATTEMPTS}
                         and (q.transcript_next_attempt_at is null or q.transcript_next_attempt_at <= ${at}::timestamptz)
                       order by q.created_at, q.id
                       limit ${TRANSCRIBE_BATCH}
                         for update skip locked)
      returning m.id, m.operator_id, m.conversation_id, m.audio_file_id, m.transcript_attempts`)
  ).rows;
  sweep.due = claimed.length;
  for (const row of claimed) {
    const note: Claimed = {
      id: row.id,
      operatorId: row.operator_id,
      conversationId: row.conversation_id,
      audioFileId: row.audio_file_id,
      attempts: Number(row.transcript_attempts),
    };
    try {
      const outcome = await transcribeOne(db, deps, note, now);
      sweep[outcome] += 1;
    } catch (err) {
      // Left to its lease: the next tick after it asks again, or gives it up.
      sweep.errors += 1;
      deps.log?.error({ messageId: note.id, error: err instanceof Error ? err.constructor.name : 'NonError' }, 'a voice note could not be transcribed; its lease decides what happens next');
    }
  }
  return sweep;
}
