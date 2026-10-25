import { z } from 'zod';
import type { App } from '../app';
import { errors } from '../lib/errors';
import {
  AssistantSettingsReadSchema, AssistantSettingsWriteSchema, readAssistantSettings, saveAssistantSettings,
  type AssistantDefaults,
} from '../services/assistant-settings';
import { opCtx } from '../services/tx';

/** Operator settings only; all eleven fields retain native env units/defaults. */
export async function assistantSettingsRoutes(app: App): Promise<void> {
  const defaults = (): AssistantDefaults => ({
    internal: {
      personDailyCap: app.env.INTERNAL_AI_PERSON_DAILY_CAP, dailyAskCap: app.env.INTERNAL_AI_DAILY_ASK_CAP,
      dailyTokenCap: app.env.INTERNAL_AI_DAILY_TOKEN_CAP, concurrentPerPerson: app.env.INTERNAL_AI_CONCURRENT_PER_PERSON,
      concurrentPerOperator: app.env.INTERNAL_AI_CONCURRENT_PER_OPERATOR,
    },
    inbox: {
      dailyTurnCap: app.env.INBOX_AI_DAILY_TURN_CAP, dailyTokenCap: app.env.INBOX_AI_DAILY_TOKEN_CAP,
      debounceSeconds: app.env.INBOX_AI_DEBOUNCE_S, debounceMaxSeconds: app.env.INBOX_AI_DEBOUNCE_MAX_S,
      firstBubbleMs: app.env.INBOX_AI_FIRST_BUBBLE_MS, bubbleGapMs: app.env.INBOX_AI_BUBBLE_GAP_MS,
    },
  });
  app.get('/assistant-settings', {
    config: { permission: 'inbox:ai:manage', target: { operator: true } },
    preValidation: async req => {
      req.requireAuth();
      await req.requirePermission('inbox:ai:manage', { operatorOnly: true });
    },
    schema: {
      description: 'Read the operator assistant caps, native fallback and immutable effective-dated USD rates. No provider, enabled state, model choice or credentials.',
      querystring: z.object({}).strict(), response: { 200: AssistantSettingsReadSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return readAssistantSettings(app.db, auth.operatorId, defaults());
  });
  app.put('/assistant-settings', {
    config: { permission: 'inbox:ai:manage', target: { operator: true } },
    preValidation: async req => {
      req.requireAuth();
      // Must run before the global idempotency preHandler can replay a body.
      await req.requirePermission('inbox:ai:manage', { operatorOnly: true });
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0 || key.length > 200) throw errors.badRequest('An Idempotency-Key is required');
    },
    schema: {
      description: 'Atomically replace sparse numeric overrides and append USD rate versions at the expected revision. Requires Idempotency-Key; saved rate history is immutable.',
      querystring: z.object({}).strict(), body: AssistantSettingsWriteSchema,
      response: { 200: AssistantSettingsReadSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return saveAssistantSettings(app.db, opCtx(req), {
      operatorId: auth.operatorId, accountId: auth.accountId, document: req.body, defaults: defaults(),
    });
  });
}
