import type { Db } from '@oto/db';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit';
import { recordRun } from '../ops';
import { withTx, type OpContext } from '../tx';
import type { InboxViewer } from './read-visibility';
import { loadReplyableConversation } from './reply';
import {
  TRANSCRIPTION_LANGUAGE_HINTS,
  baseContentType,
  transcribe,
  type TranscriptionOutcome,
  type TranscriptionRuntime,
} from './transcription';

/**
 * A DICTATED REPLY (SCRUM-834, part b of "voice in the inbox"; owner, 11 Nov
 * 2026: "both a and then b").
 *
 * A person at the park presses the composer's microphone, speaks the reply in
 * Thai, English or Russian, presses stop; the browser's recording comes here
 * and the words go back to the composer, where the person reads, corrects and
 * sends them — or does not. NOTHING is written to the thread: no message, no
 * draft. The recording is held in memory for the one provider call and
 * dropped; nothing here logs the audio or the words.
 *
 * THE CHECK is the reply's own (`loadReplyableConversation`, `reply.ts`): the
 * caller must see the conversation and hold `inbox:conversation:reply` at a
 * scope that covers it, exactly as posting a message there — the conversation
 * id names the scope and nothing else.
 *
 * THE PROVIDER, model and limits are part (a)'s (`transcription.ts`, the
 * api's `inboxTranscription` runtime): the same language hints, the same
 * ceiling (`TRANSCRIPTION_MAX_SECONDS`) and byte limit. Each refusal has its
 * own code so the composer can say it in its own words:
 *   DICTATION_NOT_AVAILABLE       409  no provider on this deployment
 *   DICTATION_TOO_LONG            413  over the ceiling or the byte limit
 *   DICTATION_UNSUPPORTED_FORMAT  415  a format no provider takes
 *   DICTATION_NOTHING_HEARD       422  the provider heard no words
 *   DICTATION_RATE_LIMITED        429  more than twenty in a minute from one caller
 *   DICTATION_FAILED              502  the provider did not answer, or refused
 *
 * THE RECORD: one audit row per request that passed the check
 * (`inbox.dictation`: ids, the outcome word, the length, the bytes, the
 * language — never the words) and one ops run per provider call
 * (`adapter:inbox.transcription`, as the voice-note job records its own, with
 * `source: 'dictation'`). The answer is never kept for replay: the route
 * declares `secretResponse`, so the words live nowhere until the person
 * presses Send and the reply route writes them as a message.
 */

export const INBOX_DICTATION_ACTION = 'inbox.dictation';

export interface DictationClip {
  bytes: Uint8Array;
  /** The recording's content type as the browser named it (`audio/webm;codecs=opus`). */
  contentType: string;
}

export interface DictationResult {
  text: string;
  /** ISO 639-1, or null when neither the provider nor the words' script said. */
  language: string | null;
}

export interface DictationDeps {
  runtime: TranscriptionRuntime;
  log?: FastifyBaseLogger;
}

export type DictationCtx = OpContext & { now: Date };

/** "3 minutes", or "150 seconds" when the ceiling is not whole minutes. */
function lengthWords(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

export const dictationNotAvailable = (): AppError =>
  new AppError(
    409,
    'DICTATION_NOT_AVAILABLE',
    'Dictation is not available on this deployment: no transcription provider is configured.',
  );

export const dictationTooLong = (
  limits: Pick<TranscriptionRuntime, 'maxSeconds' | 'maxBytes'>,
  durationSeconds: number | null,
): AppError =>
  new AppError(
    413,
    'DICTATION_TOO_LONG',
    `A dictation is at most ${lengthWords(limits.maxSeconds)} and ${Math.floor(limits.maxBytes / (1024 * 1024))} MB. Speak the reply in parts.`,
    { maxSeconds: limits.maxSeconds, maxBytes: limits.maxBytes, durationSeconds },
  );

export const dictationUnsupportedFormat = (): AppError =>
  new AppError(415, 'DICTATION_UNSUPPORTED_FORMAT', 'The recording is in a format the transcription provider does not take.');

/**
 * How many dictations one caller may send in a minute: a provider call each,
 * so a bound a person speaking replies never meets and a script does. Spent
 * from the api's own bucket (`plugins/rate-limit.ts`: the account, or the
 * station its session sits at), refused before the handler runs.
 */
export const DICTATION_RATE = { max: 20, timeWindow: 60_000 } as const;

export const dictationRateLimited = (retryAfterSeconds: number): AppError =>
  new AppError(429, 'DICTATION_RATE_LIMITED', `Too many dictations in a minute. Try again in ${retryAfterSeconds}s.`, {
    retryAfterSeconds,
  });

/** The refusal a failed transcription is answered with, in the composer's codes. */
export function dictationRefusal(
  outcome: Extract<TranscriptionOutcome, { ok: false }>,
  limits: Pick<TranscriptionRuntime, 'maxSeconds' | 'maxBytes'>,
): AppError {
  switch (outcome.reason) {
    case 'NOT_CONFIGURED':
      return dictationNotAvailable();
    case 'TOO_LONG':
      return dictationTooLong(limits, outcome.durationSeconds);
    case 'UNSUPPORTED_FORMAT':
      return dictationUnsupportedFormat();
    case 'EMPTY':
      return new AppError(422, 'DICTATION_NOTHING_HEARD', 'No words were heard in the recording. Try again, closer to the microphone.');
    default:
      return new AppError(
        502,
        'DICTATION_FAILED',
        outcome.retryable ? 'The transcription provider did not answer. Try again.' : 'The transcription provider refused the recording.',
        { reason: outcome.reason, retryable: outcome.retryable },
      );
  }
}

/**
 * The words of one dictated clip, for a caller who may reply in the
 * conversation. Throws the refusals above; writes the audit row either way.
 */
export async function dictate(
  db: Db,
  deps: DictationDeps,
  viewers: { read: InboxViewer; reply: InboxViewer },
  conversationId: string,
  clip: DictationClip,
  ctx: DictationCtx,
): Promise<DictationResult> {
  const conv = await loadReplyableConversation(db, viewers, conversationId);
  if (clip.bytes.length === 0) throw errors.badRequest('A dictation carries a recording.');

  const startedAt = new Date();
  const outcome = await transcribe(deps.runtime, {
    bytes: clip.bytes,
    contentType: clip.contentType,
    languageHints: TRANSCRIPTION_LANGUAGE_HINTS,
  });
  // Ids, the outcome word and numbers only: never the transcript.
  const summary = {
    conversationId: conv.id,
    outcome: outcome.ok ? 'ok' : outcome.reason,
    model: outcome.model,
    latencyMs: outcome.latencyMs,
    durationSeconds: outcome.durationSeconds,
    language: outcome.ok ? outcome.language : null,
    bytes: clip.bytes.length,
    contentType: baseContentType(clip.contentType),
  };

  // One ops run per provider call, as the voice-note job records its own; no
  // adapter, no call, no run.
  if (outcome.ok || outcome.reason !== 'NOT_CONFIGURED') {
    await recordRun(db, {
      kind: 'adapter',
      name: 'adapter:inbox.transcription',
      outcome: outcome.ok ? 'ok' : 'failed',
      startedAt,
      operatorId: conv.operatorId,
      branchId: conv.branchId,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      detail: { source: 'dictation', ...summary, status: outcome.ok ? null : outcome.status },
      ...(outcome.ok ? {} : { error: Object.assign(new Error(`inbox dictation ${outcome.reason}`), { name: outcome.reason }) }),
    });
  }

  await withTx(db, { ...ctx, operatorId: conv.operatorId, branchId: conv.branchId }, INBOX_DICTATION_ACTION, (tx) =>
    audit.record(tx, {
      actorAccountId: ctx.actorAccountId ?? null,
      action: INBOX_DICTATION_ACTION,
      entityType: 'inbox.conversation',
      entityId: conv.id,
      operatorId: conv.operatorId,
      branchId: conv.branchId,
      requestId: ctx.requestId ?? null,
      after: summary,
    }),
  );

  if (!outcome.ok) throw dictationRefusal(outcome, deps.runtime);
  return { text: outcome.text, language: outcome.language };
}
