import { AnthropicToolLoopClient, type AiEffort, type ToolLoopClient } from '@oto/assistant';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../../env';
import { handoffConfig, type HandoffConfig, type HandoffSettings } from '../handoff';

/**
 * THE INTERNAL ASSISTANT'S RUNTIME (SCRUM-591, round I2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §E.2, R3).
 *
 * The customer assistant's pattern (`services/inbox/ai-runtime.ts`), copied:
 * what the ask route reads from the environment, read ONCE, and the model
 * client built from it. One object per process (`app.internalAi`).
 *
 * `client` is null when the assistant is off, and ALWAYS null under
 * `NODE_ENV=test`: a suite injects `FakeToolLoopClient` here, and a suite that
 * forgets to gets the switched-off line (`NO_CLIENT`), never a real call. The
 * key is read only into the client's constructor; nothing here logs it.
 *
 * `config` is a plain object a test may change between asks (a cap, the
 * switch); the route reads it per ask.
 */

export interface InternalAiConfig {
  /** `INTERNAL_AI_ENABLED`: the deploy-wide kill switch. */
  enabled: boolean;
  model: string;
  effort: AiEffort;
  timeoutMs: number;
  /** Per ask (§D.1 step 4). */
  maxToolCalls: number;
  wallMs: number;
  /** Asks per account per Bangkok day. */
  personDailyCap: number;
  /** Per operator per Bangkok day. */
  dailyAskCap: number;
  dailyTokenCap: number;
  /** Asks that may be running at once: per account, and per operator (BUSY past either). */
  concurrentPerPerson: number;
  concurrentPerOperator: number;
  /** `INTERNAL_AI_OTOAPP_TOOLS`: round I4's switch. Off, no `oto.*` tool is offered and no hand-off is minted. */
  otoAppTools: boolean;
  /**
   * One server-to-server call to the OTO App (the hand-off exchange, a tool's
   * GET, the logout): `OTOAPP_DIRECTORY_TIMEOUT_MS`, the app's existing
   * per-call limit, bounded further by the ask's remaining wall time.
   */
  otoAppTimeoutMs: number;
  /**
   * The suite hand-off's settings (`HANDOFF_SIGNING_KEY`, `HANDOFF_APP_ORIGINS`,
   * `HANDOFF_TOKEN_TTL_S`), as `POST /auth/handoff` reads them. The assistant
   * mints an `oto_app` hand-off for the asker's own session through the same
   * service (`issueHandoffAudited`), and posts it to the origin the token was
   * minted for — the `oto_app=` entry — so there is no second setting naming
   * the OTO App. Parsed per ask by `otoAppHandoff`, never at boot: an api
   * with no hand-off configured still serves every other ask.
   */
  handoff: HandoffSettings;
}

/**
 * The hand-off configuration with an `oto_app` origin, or null when this
 * deployment has none (unset keys, or no `oto_app=` entry): the OTO App tools
 * are then not offered, whatever the switch says. Never throws.
 */
export function otoAppHandoff(config: InternalAiConfig): { handoff: HandoffConfig; origin: string } | null {
  let parsed: HandoffConfig;
  try {
    parsed = handoffConfig(config.handoff);
  } catch {
    return null;
  }
  const origin = parsed.origins.get('oto_app');
  return origin ? { handoff: parsed, origin } : null;
}

export interface InternalAiRuntime {
  config: InternalAiConfig;
  /** The model. Replaced in tests by a fake; null when there is none to call. */
  client: ToolLoopClient | null;
}

export function internalAiConfigOf(env: Env): InternalAiConfig {
  return {
    enabled: env.INTERNAL_AI_ENABLED === 'true',
    model: env.INTERNAL_AI_MODEL,
    effort: env.INTERNAL_AI_EFFORT,
    timeoutMs: env.INTERNAL_AI_TIMEOUT_MS,
    maxToolCalls: env.INTERNAL_AI_MAX_TOOL_CALLS,
    wallMs: env.INTERNAL_AI_ASK_WALL_MS,
    personDailyCap: env.INTERNAL_AI_PERSON_DAILY_CAP,
    dailyAskCap: env.INTERNAL_AI_DAILY_ASK_CAP,
    dailyTokenCap: env.INTERNAL_AI_DAILY_TOKEN_CAP,
    concurrentPerPerson: env.INTERNAL_AI_CONCURRENT_PER_PERSON,
    concurrentPerOperator: env.INTERNAL_AI_CONCURRENT_PER_OPERATOR,
    otoAppTools: env.INTERNAL_AI_OTOAPP_TOOLS === 'true',
    otoAppTimeoutMs: env.OTOAPP_DIRECTORY_TIMEOUT_MS,
    handoff: {
      signingKey: env.HANDOFF_SIGNING_KEY,
      appOrigins: env.HANDOFF_APP_ORIGINS,
      ttlSeconds: env.HANDOFF_TOKEN_TTL_S,
    },
  };
}

export function buildInternalAiRuntime(env: Env, log?: FastifyBaseLogger): InternalAiRuntime {
  const config = internalAiConfigOf(env);
  let client: ToolLoopClient | null = null;
  if (config.enabled && env.NODE_ENV !== 'test' && env.ANTHROPIC_API_KEY.trim()) {
    client = new AnthropicToolLoopClient({
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
      { model: config.model, effort: config.effort, maxToolCalls: config.maxToolCalls, otoAppTools: config.otoAppTools },
      'internal assistant enabled',
    );
    if (config.otoAppTools && !otoAppHandoff(config)) {
      // Switched on with nowhere to go: said once at boot, by name, so the staging round sees it.
      log?.warn(
        'INTERNAL_AI_OTOAPP_TOOLS is true but HANDOFF_APP_ORIGINS has no oto_app entry (or the hand-off is not configured): the OTO App tools are not offered',
      );
    }
  }
  return { config, client };
}
