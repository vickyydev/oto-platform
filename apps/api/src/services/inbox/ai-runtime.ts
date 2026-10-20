import { AnthropicAssistantClient, type AiEffort, type AssistantClient, type RandomSource } from '@oto/assistant';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../../env';

/**
 * THE CUSTOMER ASSISTANT'S RUNTIME (SCRUM-590, round A2 lane a; plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §B.7, §D.4, §D.6).
 *
 * What the turn engine reads from the environment, read ONCE, and the model
 * client built from it. One object per process (`app.inboxAi`), handed to the
 * ingest (scheduling) and to `job:inbox.ai` (deciding), so the routes and the
 * job agree on the switch and the debounce.
 *
 * `client` is null when the assistant is off, and ALWAYS null under
 * `NODE_ENV=test`: a suite injects `FakeAssistantClient` here, and a suite
 * that forgets to gets silence (`NO_CLIENT`), never a real call. The key is
 * read only into the client's constructor; nothing here logs it.
 */

export interface InboxAiConfig {
  /** `INBOX_AI_ENABLED`: the deploy-wide kill switch (§D.4 guard 6). */
  enabled: boolean;
  model: string;
  effort: AiEffort;
  timeoutMs: number;
  /** §A.1: a turn falls due this long after the customer's last bubble… */
  debounceMs: number;
  /** …and never later than this after the first. */
  debounceMaxMs: number;
  /** §D.4 guard 4, per operator per Bangkok day. */
  dailyTurnCap: number;
  dailyTokenCap: number;
}

/** What the ingest needs to write a turn: the switch and the debounce. */
export type InboxAiSchedule = Pick<InboxAiConfig, 'enabled' | 'debounceMs' | 'debounceMaxMs'>;

export interface InboxAiRuntime {
  config: InboxAiConfig;
  /** The model. Replaced in tests by a fake; null when there is none to call. */
  client: AssistantClient | null;
  /** Pacing's jitter source (§B.6); tests pin it. */
  random: RandomSource;
}

export function inboxAiConfigOf(env: Env): InboxAiConfig {
  return {
    enabled: env.INBOX_AI_ENABLED === 'true',
    model: env.INBOX_AI_MODEL,
    effort: env.INBOX_AI_EFFORT,
    timeoutMs: env.INBOX_AI_TIMEOUT_MS,
    debounceMs: env.INBOX_AI_DEBOUNCE_S * 1000,
    debounceMaxMs: Math.max(env.INBOX_AI_DEBOUNCE_MAX_S, env.INBOX_AI_DEBOUNCE_S) * 1000,
    dailyTurnCap: env.INBOX_AI_DAILY_TURN_CAP,
    dailyTokenCap: env.INBOX_AI_DAILY_TOKEN_CAP,
  };
}

export function buildInboxAiRuntime(env: Env, log?: FastifyBaseLogger): InboxAiRuntime {
  const config = inboxAiConfigOf(env);
  let client: AssistantClient | null = null;
  if (config.enabled && env.NODE_ENV !== 'test' && env.ANTHROPIC_API_KEY.trim()) {
    client = new AnthropicAssistantClient({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL.trim() || undefined,
      model: config.model,
      effort: config.effort,
      timeoutMs: config.timeoutMs,
    });
  }
  if (config.enabled) {
    // The boot line the staging proof reads (§F.5 item 1): the model, never the key.
    log?.info(
      { model: config.model, effort: config.effort, debounceS: config.debounceMs / 1000 },
      'inbox assistant enabled',
    );
  }
  return { config, client, random: Math.random };
}

/** The ingest's view: the switch and the debounce only. */
export function scheduleOf(runtime: Pick<InboxAiRuntime, 'config'>): InboxAiSchedule {
  return {
    enabled: runtime.config.enabled,
    debounceMs: runtime.config.debounceMs,
    debounceMaxMs: runtime.config.debounceMaxMs,
  };
}
