import type { FastifyError } from 'fastify';
import { z } from 'zod';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { DICTATION_RATE, dictate, dictationRateLimited, dictationTooLong, dictationUnsupportedFormat } from '../services/inbox/dictation';
import { holdsAnywhere, viewerScopeOf, type InboxViewer } from '../services/inbox/read-visibility';
import { INBOX_REPLY, replyViewerOf } from '../services/inbox/reply';
import { TRANSCRIBABLE_AUDIO_CONTENT_TYPES } from '../services/inbox/transcription';
import { opCtx } from '../services/tx';

/**
 * THE COMPOSER'S DICTATION ROUTE (SCRUM-834; part (a) is the voice-note job).
 *
 *   POST /inbox/conversations/{id}/dictation   the recording in, the words out
 *
 * The body is the browser's recording as its own bytes under its audio content
 * type (the brochure's way, `inbox-reply.ts`), never JSON: the parsers below
 * take exactly the AUDIO formats the transcription provider takes — never a
 * video container, a dictation being a microphone's recording and nothing
 * else — at most the provider's byte limit, and Fastify's own refusals of a
 * bigger or a stranger body are said in the route's codes. `dynamicPermission`,
 * as every inbox route: the reply permission sits at a team's department as
 * often as at a branch, so the handler checks it against the conversation
 * itself. `secretResponse`: the answer is the words the person spoke, kept
 * nowhere until they press Send — the replay store would hold a day's
 * dictations outside the message table and its erasure, so no key is claimed
 * and a retry asks the provider again (`route-write-conformance.test.ts`).
 * `rateLimit`: twenty a minute per caller (`DICTATION_RATE`), spent from the
 * api's own bucket (`plugins/rate-limit.ts`) and refused as the route's own
 * 429 — a provider call each, so a bound a person never meets and a script
 * does. The deployment's ceiling and whether a provider is on ride on
 * `GET /inbox/me` (`dictation`), so the composer's clock reads the real
 * value and the microphone is hidden where every clip would be refused.
 */

const IdParams = z.object({ id: z.string().uuid() });

export const InboxDictationSchema = z.object({
  /** The words heard, whitespace folded. */
  text: z.string(),
  /** ISO 639-1 (`th`, `en`, `ru`, …), or null when nothing said which. */
  language: z.string().nullable(),
});

export async function inboxDictationRoutes(app: App): Promise<void> {
  const limits = app.inboxTranscription;

  // The recording's bytes arrive raw under their audio type. These parsers
  // live in this plugin only, so no other route accepts them.
  app.addContentTypeParser(
    [...TRANSCRIBABLE_AUDIO_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: limits.maxBytes },
    (_req, body, done) => done(null, body),
  );

  app.post(
    '/conversations/:id/dictation',
    {
      config: {
        dynamicPermission: true,
        secretResponse: true,
        rateLimit: {
          ...DICTATION_RATE,
          // The plugin throws what this returns (`plugins/rate-limit.ts`):
          // the route's own code, with the seconds its `retry-after` says.
          errorResponseBuilder: (_req, ctx) => dictationRateLimited(Math.ceil(ctx.ttl / 1000)),
        },
      },
      bodyLimit: limits.maxBytes,
      // Fastify refuses an oversize body or an unknown type before the
      // handler runs; say it as the route's own sentence.
      errorHandler: (err: FastifyError) => {
        if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') throw dictationTooLong(limits, null);
        if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') throw dictationUnsupportedFormat();
        throw err;
      },
      schema: {
        description:
          'Transcribe a reply the person dictated into the composer (SCRUM-834): the request body is the browser’s ' +
          'recording as its own bytes under its audio content type — one of the audio types the provider takes: ' +
          `${TRANSCRIBABLE_AUDIO_CONTENT_TYPES.join(', ')} (a \`;codecs=…\` parameter is allowed; never a video ` +
          'container) — at most 25 MB and no longer than the deployment’s voice-note ceiling (TRANSCRIPTION_MAX_SECONDS, ' +
          'read by the composer from GET /inbox/me as `dictation.maxSeconds`). The same provider, model and limits as ' +
          'a customer’s voice note. Answers the words and the language heard (ISO 639-1, or null) for the composer to ' +
          'show; NO message is written, and the audio is dropped after the call. Refusals, each in a plain sentence: ' +
          '409 DICTATION_NOT_AVAILABLE (no provider on this deployment), 413 DICTATION_TOO_LONG (details: maxSeconds, ' +
          'maxBytes, durationSeconds), 415 DICTATION_UNSUPPORTED_FORMAT, 422 DICTATION_NOTHING_HEARD, 429 ' +
          `DICTATION_RATE_LIMITED (more than ${DICTATION_RATE.max} in a minute from one caller; details: ` +
          'retryAfterSeconds), 502 DICTATION_FAILED (details: reason, retryable). Needs inbox:conversation:reply at a ' +
          'scope covering the conversation — the same check as replying in it; a conversation the caller cannot see is ' +
          '404. Audited as inbox.dictation (ids, length, bytes, language, outcome — never the words); the answer is not ' +
          'kept for replay, so no Idempotency-Key is taken.',
        params: IdParams,
        body: z.any(),
        response: { 200: InboxDictationSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      if (!holdsAnywhere(effective, INBOX_REPLY, auth.operatorId)) throw new PermissionDeniedError(INBOX_REPLY);
      const read: InboxViewer = {
        accountId: auth.accountId,
        operatorId: auth.operatorId,
        scope: viewerScopeOf(effective, auth.accountId, auth.operatorId),
      };
      const viewers = { read, reply: replyViewerOf(effective, auth.accountId, auth.operatorId) };
      // A body of no bytes never reaches a parser; a parsed non-audio body
      // (JSON, text) is a format no provider takes.
      if (req.body === undefined || req.body === null) throw errors.badRequest('A dictation carries a recording.');
      if (!Buffer.isBuffer(req.body)) throw dictationUnsupportedFormat();
      return dictate(
        app.db,
        { runtime: app.inboxTranscription, log: req.log },
        viewers,
        req.params.id,
        { bytes: new Uint8Array(req.body), contentType: String(req.headers['content-type'] ?? '') },
        { ...opCtx(req), now: new Date() },
      );
    },
  );
}
