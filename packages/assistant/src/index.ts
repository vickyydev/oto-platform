/**
 * `@oto/assistant` — the Inbox customer assistant's pure core (SCRUM-590,
 * round A1, lane ai-a1a).
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
 *   fake.ts       `FakeAssistantClient`: scripted decisions, every failure.
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
