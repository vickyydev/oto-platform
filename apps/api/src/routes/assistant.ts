import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AssistantAskCreateSchema,
  AssistantAskFeedbackResultSchema,
  AssistantAskFeedbackSchema,
  AssistantAskListQuerySchema,
  AssistantAskListSchema,
  AssistantAskViewSchema,
  AssistantReviewListSchema,
  AssistantReviewQuerySchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { PermissionDeniedError, SESSION_COOKIE } from '../plugins/session';
import { branchReach } from '../services/access-control';
import { REPLAY_HEADER, wasReplay } from '../services/client-id';
import { holdsAnywhere } from '../services/inbox/read-visibility';
import { askAssistant } from '../services/assistant/engine';
import { listMyAsks, loadAsk, loadAskView, reviewAsks, reviewOneAsk, setAskFeedback } from '../services/assistant/views';
import { opCtx, withTx } from '../services/tx';

/**
 * THE INTERNAL ASSISTANT'S ROUTES (SCRUM-591, round I2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.2, §D, §E).
 *
 *   POST  /assistant/asks                 ask                          assistant:ask:use, anywhere in the operator
 *   GET   /assistant/asks                 my questions                 a session
 *   GET   /assistant/asks/{id}            one of mine; anyone's for    a session; assistant:log:review
 *                                         a reviewer (audited)         operator-wide for another's
 *   PATCH /assistant/asks/{id}/feedback   good | wrong + correction    a session, own asks only, once
 *   GET   /assistant/review/asks          the reviewer's list          assistant:log:review operator-wide (audited)
 *
 * THE ASK'S GUARD SITS ON THE PERSON, NOT ON THE SEAT. `assistant:ask:use` is
 * in every staff bundle, granted at the operator, a branch or — for an Inbox
 * agent — a team's DEPARTMENT. A route guard defaults its target to the
 * session's seat, which a department-scoped agent's grant never covers, so the
 * route declares `dynamicPermission` and the handler asks whether the caller
 * holds it anywhere in their operator (the inbox routes' rule). It is a
 * switch, not a fence (§E.2): every tool call is fenced by the route it calls.
 *
 * A locked session (423) or one that owes a password change (403
 * MUST_CHANGE_PASSWORD) is refused by `requireAuth` before any model call.
 *
 * THE ASK ANSWERS A RESEND ITSELF (`replaysByOwnId`). The ask's id is the
 * caller's; a second POST of the same id is answered from the ask's row as
 * it stands — never from the replay store, which would keep a second copy of
 * the answer for a day (§E.1).
 */

const IdParams = z.object({ id: z.string().uuid() });
const ASK_USE: Permission = 'assistant:ask:use';
const LOG_REVIEW: Permission = 'assistant:log:review';

export async function assistantRoutes(app: App): Promise<void> {
  /** Operator-wide `assistant:log:review` (G3): a branch-scoped grant is not a reviewer's. */
  async function isReviewer(req: FastifyRequest, operatorId: string): Promise<boolean> {
    return branchReach(await req.effectivePermissions(), LOG_REVIEW, operatorId).kind === 'operator';
  }

  app.post(
    '/asks',
    {
      config: { dynamicPermission: true, replaysByOwnId: true },
      schema: {
        description:
          'Ask the internal assistant a question (1–2,000 characters) under a caller-named id. The assistant reads ' +
          'the platform AS THE ASKER: every tool is an existing GET route called in process with the asker’s own ' +
          'session, so it sees exactly what their screens would and a refusal comes back as the route’s own ' +
          'sentence, verbatim, under `refusals`. Answers the ask as it ended: `answered`, `refused`, `link_only` ' +
          '(a link and a fixed line, e.g. a figure the guard could not trace), `failed`, `capped` (a daily cap), ' +
          'or `off` (switched off) — with links the asker may open. A resend of the same id is answered from the ' +
          'ask as it stands (`x-oto-replay`); while it is still running, 409 ASK_IN_FLIGHT. Needs assistant:ask:use ' +
          'anywhere in the operator. Audited as assistant.ask and assistant.tool.call (ids, tool names, counts — ' +
          'never the question or the answer).',
        body: AssistantAskCreateSchema,
        response: { 200: AssistantAskViewSchema },
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      if (!holdsAnywhere(effective, ASK_USE, auth.operatorId)) throw new PermissionDeniedError(ASK_USE);
      const token = req.cookies?.[SESSION_COOKIE];
      // `requireAuth` resolved the session from this very cookie; without it there is no person to ask as.
      if (!token) throw errors.unauthorized();
      const view = await askAssistant(
        { app, db: app.db, runtime: app.internalAi, log: req.log },
        { auth, effective, requestId: req.id, token },
        req.body,
      );
      if (wasReplay(view)) reply.header(REPLAY_HEADER, 'true');
      return view;
    },
  );

  app.get(
    '/asks',
    {
      config: { auth: 'session' },
      schema: {
        description:
          'My questions: the signed-in person’s own asks, newest first, keyset-paged by `cursor` (at most 50). ' +
          'Each with its answer, links, refusal lines, tool calls (as numbers) and feedback. No permission beyond ' +
          'a session: nobody else’s asks are ever in this list.',
        querystring: AssistantAskListQuerySchema,
        response: { 200: AssistantAskListSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listMyAsks(app.db, { operatorId: auth.operatorId, accountId: auth.accountId }, req.query);
    },
  );

  app.get(
    '/asks/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'One ask. The asker reads their own; anybody else’s needs assistant:log:review operator-wide (403 ' +
          'otherwise), and that read is audited as assistant.ask.read naming the ask.',
        params: IdParams,
        response: { 200: AssistantAskViewSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadAsk(app.db, auth.operatorId, req.params.id);
      if (row.accountId === auth.accountId) return loadAskView(app.db, row);
      if (!(await isReviewer(req, auth.operatorId))) throw new PermissionDeniedError(LOG_REVIEW);
      return withTx(app.db, opCtx(req), 'assistant.ask.read', (tx) =>
        reviewOneAsk(tx, { operatorId: auth.operatorId, accountId: auth.accountId, branchId: auth.branchId, requestId: req.id }, row),
      );
    },
  );

  app.patch(
    '/asks/:id/feedback',
    {
      config: { auth: 'session' },
      schema: {
        description:
          'Mark one of my answers good or wrong, once; `wrong` may carry a correction (1–1,000 characters), kept on ' +
          'the ask for the reviewers (the learning loop, never weight training). Own asks only (403); an ask still ' +
          'being answered is 409 ASK_IN_FLIGHT; one already rated is 409 FEEDBACK_GIVEN — the first verdict stands, ' +
          'and a resend under the same Idempotency-Key is answered from it. Answers without the text. Audited as ' +
          'assistant.ask.feedback (the verdict and the correction’s length).',
        params: IdParams,
        body: AssistantAskFeedbackSchema,
        response: { 200: AssistantAskFeedbackResultSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return withTx(app.db, opCtx(req), 'assistant.ask.feedback', (tx) =>
        setAskFeedback(
          tx,
          { operatorId: auth.operatorId, accountId: auth.accountId, branchId: auth.branchId, requestId: req.id },
          req.params.id,
          req.body,
        ),
      );
    },
  );

  app.get(
    '/review/asks',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The reviewers’ view of the ask-log (G3): every ask of the operator, newest first, filtered by feedback, ' +
          'state, asker or date, keyset-paged. Needs assistant:log:review operator-wide. EVERY read is audited as ' +
          'assistant.ask.read naming the asks read.',
        querystring: AssistantReviewQuerySchema,
        response: { 200: AssistantReviewListSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      if (!(await isReviewer(req, auth.operatorId))) throw new PermissionDeniedError(LOG_REVIEW);
      return withTx(app.db, opCtx(req), 'assistant.ask.read', (tx) =>
        reviewAsks(tx, { operatorId: auth.operatorId, accountId: auth.accountId, branchId: auth.branchId, requestId: req.id }, req.query),
      );
    },
  );
}
