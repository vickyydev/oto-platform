/**
 * `@oto/assistant` — the pure core of both OTO assistants:
 *
 *   - the Inbox CUSTOMER assistant (SCRUM-590, round A1, lane ai-a1a), and
 *   - the INTERNAL assistant for colleagues (SCRUM-591, round I1, lane ia-1a;
 *     `docs/progress/plans/internal-assistant-build/PLAN.md` §B, §D, §E):
 *     the tool-use loop, its fake, the colleague persona, the answer schema
 *     and its guards. The customer persona, gates and persona guard are not
 *     used by it, and nothing of the customer assistant changed for it.
 *
 * `docs/progress/plans/inbox-ai-build/PLAN.md` is the authority (§B, §C.4,
 * §D.1, §D.4, §F.1). The package has the shape of `@oto/messaging`: pure
 * Node, no database, no routes, no environment reads, its own Vitest checks.
 * The turn engine (A2) owns scheduling, the claim, the commit, the daily caps
 * and the circuit breaker; this package decides nothing about the database.
 *
 *   intents.ts    the brief's two lists as intents; one server action each.
 *   decision.ts   the model's structured decision (zod) and every reason word.
 *   guards.ts     the persona guard and the traceability guard; bubble shape.
 *   gate.ts       the server's gates and the per-episode cap: the model
 *                 proposes, the table and the guards dispose.
 *   persona/      the voice per language and the absolute prohibitions.
 *   prompt.ts     block 1 (static), block 2 (knowledge, cached), the episode
 *                 below the breakpoint; the KB size refusal.
 *   pacing.ts     typing time per bubble.
 *   client.ts     `AssistantClient`, the Anthropic implementation (logging
 *                 off; errors as class + status + request id only).
 *   fake.ts       `FakeAssistantClient`: scripted decisions, every failure;
 *                 `FakeCoherenceReviewer`: scripted reviews (SCRUM-677).
 *   review.ts     the coherence reviewer (SCRUM-677): operations only over
 *                 a composed reply, the server's hard rules over them, the
 *                 call within its deadline, fail-open.
 *
 * The internal assistant (Phase 3). The engine (I2) owns the routes, the
 * tool registry and adapters, caps, audit and the ask-log.
 *   internal-answer.ts   the final answer (text, link keys, language) and the
 *                        loop's failure words (Phase 2's, plus three).
 *   persona/internal.ts  the colleague voice in th/en/ru, its rules as data,
 *                        the assistant label, the server's fixed lines.
 *   internal-prompt.ts   the static block (cached, identical for every asker)
 *                        and the per-asker block.
 *   internal-guards.ts   URL stripping, shape, the traceability guard over the
 *                        ask's tool summaries. No persona guard.
 *   refusal-words.ts     a refusal in plain words for the model, and the
 *                        server's rewrite of permission strings out of prose.
 *   tool-loop.ts         `runToolLoop` (one loop for both transports),
 *                        `interpretToolLoopReply`, `AnthropicToolLoopClient`.
 *   tool-loop-fake.ts    `FakeToolLoopClient`: scripted tool calls and answers
 *                        through the real loop.
 */

export * from './intents';
export * from './decision';
export * from './guards';
export * from './gate';
export * from './persona';
export * from './prompt';
export * from './pacing';
export * from './client';
export * from './fake';
export * from './review';
export * from './internal-answer';
export * from './internal-prompt';
export * from './internal-guards';
export * from './refusal-words';
export * from './tool-loop';
export * from './tool-loop-fake';
export * from './operator-rules';
export * from './persona/teach';
