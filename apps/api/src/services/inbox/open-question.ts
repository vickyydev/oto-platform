import { and, asc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  REPEAT_HANDOVER,
  askedSlotsOf,
  buildPrompt,
  questionsIn,
  readSlotAnswers,
  repeatGuard,
  repeatStep,
  slotsAskedIn,
  type AiAskedSlot,
  type AiDecision,
  type AiEffort,
  type AssistantOutcome,
  type BuiltPrompt,
  type EpisodeMessage,
  type GateVerdict,
  type GroundingSource,
  type PromptInput,
  type PromptMemory,
  type RepeatKind,
  type RepeatRefusal,
  type TurnUsage,
} from '@oto/assistant';
import { aiTurn, conversationOpenQuestion, message, type Db } from '@oto/db';
import { isoDateInTz, newId, type InboxOpenQuestion, type InboxOpenQuestionState } from '@oto/shared';
import { audit } from '../audit';
import type { Exec, Tx } from '../tx';

/**
 * SCRUM-831 — NEVER ASK TWICE (owner, 10 Nov 2026, APPROVED: "the memory is
 * the primary mechanism; the guard is the last net and its firing is
 * counted"). The assistant asked a family "how old will the birthday child
 * be?" twice in one thread after the parent had answered.
 *
 * The turn engine (`ai-engine.ts`) calls this module at four points, and
 * nothing else of the engine changed:
 *
 *   1. THE MEMORY (`loadOpenQuestionMemory`), before the prompt: the
 *      episode's questions (`inbox.conversation_open_question`), each open
 *      one read against the customer's first reply to it — the reply IS the
 *      answer (`@oto/assistant` `readSlotAnswers`: numbers in Thai, Russian
 *      and English words and digits, a date, a time, a park), never a later
 *      line. A question whose line never left is withdrawn; one a person
 *      took over (a staff line, a hand-over) is withdrawn and still read
 *      against the customer's replies to that person, so it can become
 *      answered. The prompt names every question and how it was answered
 *      (`promptMemoryOf`, below the cache breakpoint).
 *   2. THE GUARD (`repeatStage`), after the gate: a reply that asks a slot
 *      the customer already answered (or one asked twice with no answer, or
 *      the child's age where the playbook's answer does not depend on it) is
 *      refused (`@oto/assistant` `repeatGuard`). The turn is decided once
 *      more with the fact given ("the customer already said: 8 years old");
 *      a second draft that still asks it, two unanswered asks, or a rethink
 *      that cannot be sent becomes the hand-over to the thread's own team
 *      with its warm closing line — never silence. Every trip is one audit
 *      row, `inbox.ai.repeat_guard`, with the slot: the owner sees how often
 *      the memory failed.
 *   3. THE COMMIT (`commitOpenQuestions`), under the thread lock: the answers
 *      read are kept, the questions the reply asks are recorded on the line
 *      that asked each, the older open row of a slot asked again withdrawn,
 *      and a hand-over withdraws what is still open (a person has the
 *      thread). Live numbers only: a shadow reply was never asked.
 *   4. THE INBOX (`openQuestionsOf`): the thread shows under the asking line
 *      what the assistant believes ("asked: the child's age · answered 8").
 *
 * NOTHING LOGS TEXT. Audit rows carry slots, kinds, counts and ids — never an
 * answer: an audit row is never erased, and an answer is the customer's.
 * `answer` itself is a short value the server read, never a name.
 */

/** The parks' zone: a date in a reply is counted from the park's day. */
const ZONE = 'Asia/Bangkok';

/** The word a turn carries once its repeat rethink began: a re-claim never rethinks again. */
export const REPEAT_RETHINK_MARK = 'REPEAT_RETHINK';

/** The turn's reason word when the guard handed the thread over. */
export const REPEAT_REASON = 'REPEAT_QUESTION';

/** The audit action every guard trip writes (the owner's counter). */
export const REPEAT_GUARD_ACTION = 'inbox.ai.repeat_guard';

/** The rule word the hand-over records (the turn's audit `gate`, the hand-over pill's `rule`). */
export const REPEAT_RULE = 'repeat_question';

/** A line of the episode as the engine reads it (`ai-engine.ts` `EpisodeRow`). */
export type EpisodeLine = EpisodeMessage & { id: string };

/** One question of the episode, as this turn reads it. */
export interface EpisodeQuestionRow {
  id: string;
  slot: AiAskedSlot;
  state: InboxOpenQuestionState;
  askedAt: Date;
  askedMessageId: string;
  answer: string | null;
  answeredMessageId: string | null;
}

/** What the turn knows of its questions, and what the commit is to keep of it. */
export interface OpenQuestionMemory {
  /** The episode's questions, oldest first, with this burst's answers applied. */
  questions: EpisodeQuestionRow[];
  /** The answers this turn read: kept at the commit. */
  fills: Array<{ id: string; slot: AiAskedSlot; answer: string | null; answeredMessageId: string }>;
  /** Questions this turn found withdrawn: their line never left, or a person wrote after it. */
  withdrawals: Array<{ id: string; slot: AiAskedSlot }>;
  /** This burst is the customer's reply to a question still waiting for one: the turn reads it as the answer. */
  hadOpen: boolean;
}

// --- 1. The memory -------------------------------------------------------------------------

/** The lines one commit writes are stamped `at + i` ms (`ai-engine.ts` `writeLines`): the asking reply's own lines, and a hand-over's. */
const ONE_COMMIT_MS = 100;

type Read = { state: InboxOpenQuestionState; answer: string | null; answeredMessageId: string | null };
const WITHDRAWN: Read = { state: 'withdrawn', answer: null, answeredMessageId: null };

/** One question as the loader reads it from the table. */
type LoadedRow = EpisodeQuestionRow & { turnId: string; closedAt: Date | null; askedStatus: string | null };

/**
 * Which reply a customer line is: the first reply to the question (`direct`),
 * a reply to a person (`person`: the lines that person wrote just before it,
 * and whether it is the first time a person had the thread), or neither.
 */
type ReplyWindow = { kind: 'direct' } | { kind: 'person'; leads: string[]; first: boolean; replied: boolean } | null;

/** The loader's walk over the lines after a question: the window, whether a person has the thread, and how often the customer answered one. */
interface ReplyWalk {
  window: ReplyWindow;
  person: boolean;
  personReplies: number;
}

/** A person's line opens a window for the customer's reply to it; a person's lines in a row are one lead. */
function personWindow(walk: ReplyWalk, text: string | null): ReplyWindow {
  const w = walk.window;
  if (w?.kind === 'person' && !w.replied) return { ...w, leads: text === null ? w.leads : [...w.leads, text] };
  if (w?.kind === 'person') walk.personReplies += 1;
  return { kind: 'person', leads: text === null ? [] : [text], first: walk.personReplies === 0, replied: false };
}

/** Any other line of the park closes the window. */
function closedWindow(walk: ReplyWalk): ReplyWindow {
  if (walk.window?.kind === 'person' && walk.window.replied) walk.personReplies += 1;
  return null;
}

/**
 * The episode's questions, each read against the customer's reply to it
 * (SCRUM-831 review: never against whatever comes later):
 *
 *   - AN OPEN QUESTION is read against the customer's FIRST reply to it only:
 *     their lines after the asking reply, up to the next line of the park.
 *     A reply that does not answer it leaves it open (an ask the guard still
 *     counts), and a later line never fills it. The turn's own burst is
 *     always read: a provider stamps a line in whole seconds, so a reply sent
 *     in the second the question went out can sort before it (the engine's
 *     `burstOf` allows for the same).
 *   - A PERSON TOOK THE THREAD (a staff line after the question, or the
 *     hand-over that withdrew it): the question is withdrawn, and the
 *     customer's reply to each person's line is still read against it — the
 *     fact is true whoever asked — so a withdrawn question can become
 *     answered. A newer ask of the same slot replaces it.
 *
 * An answer with its unit ("8 years", "восемь лет", a date, a park) is read
 * in any of those replies; a bare one ("8", "Mia") only where the line before
 * it asked that slot, or, the first time a person had the thread, asked
 * nothing. Questions one reply asked are read together (the combined birthday
 * question), so a bare "8" answers only a reply that asked one number.
 */
export async function loadOpenQuestionMemory(
  db: Exec,
  conv: { operatorId: string; id: string },
  episodeStart: Date,
  episode: readonly EpisodeLine[],
  burst: readonly EpisodeLine[],
  now: Date,
): Promise<OpenQuestionMemory> {
  const rows: LoadedRow[] = await db
    .select({
      id: conversationOpenQuestion.id,
      slot: conversationOpenQuestion.slot,
      state: conversationOpenQuestion.state,
      turnId: conversationOpenQuestion.turnId,
      askedAt: conversationOpenQuestion.askedAt,
      askedMessageId: conversationOpenQuestion.askedMessageId,
      answer: conversationOpenQuestion.answer,
      answeredMessageId: conversationOpenQuestion.answeredMessageId,
      closedAt: conversationOpenQuestion.closedAt,
      askedStatus: message.providerStatus,
    })
    .from(conversationOpenQuestion)
    .innerJoin(
      message,
      and(eq(message.operatorId, conversationOpenQuestion.operatorId), eq(message.id, conversationOpenQuestion.askedMessageId)),
    )
    .where(
      and(
        eq(conversationOpenQuestion.operatorId, conv.operatorId),
        eq(conversationOpenQuestion.conversationId, conv.id),
        gte(conversationOpenQuestion.askedAt, episodeStart),
      ),
    )
    .orderBy(asc(conversationOpenQuestion.askedAt), asc(conversationOpenQuestion.id));

  const today = isoDateInTz(now, ZONE);
  const memory: OpenQuestionMemory = { questions: [], fills: [], withdrawals: [], hadOpen: false };
  const read = new Map<string, Read>();
  const inBurst = new Set(burst.map((m) => m.id));
  const neverLeft = (r: LoadedRow) => r.askedStatus === 'withdrawn';

  // The asking line never left (a person acted first, plan §A.3): nothing was asked.
  for (const r of rows) if (r.state === 'open' && neverLeft(r)) read.set(r.id, WITHDRAWN);

  // Read: what is open, and what a person took over with no newer ask of its slot since.
  const newest = new Map<AiAskedSlot, LoadedRow>();
  for (const r of rows) if (!neverLeft(r)) newest.set(r.slot, r);
  const readable = rows.filter(
    (r) => !neverLeft(r) && (r.state === 'open' || (r.state === 'withdrawn' && r.closedAt !== null && newest.get(r.slot) === r)),
  );
  const byReply = new Map<string, LoadedRow[]>();
  for (const r of readable) byReply.set(r.turnId, [...(byReply.get(r.turnId) ?? []), r]);

  for (const asked of byReply.values()) {
    const askedAt = Math.min(...asked.map((q) => q.askedAt.getTime()));
    const lineIds = new Set(asked.map((q) => q.askedMessageId));
    const at = episode.findIndex((m) => lineIds.has(m.id));
    const later = at >= 0 ? episode.slice(at + 1) : episode.filter((m) => m.at.getTime() > askedAt);
    const after = [...episode.filter((m) => inBurst.has(m.id) && !later.includes(m)), ...later];
    // The hand-over that withdrew these questions: its own lines are stamped from that moment.
    const withdrawnAt = asked.find((q) => q.state === 'withdrawn')?.closedAt?.getTime() ?? null;
    const ownReply = (m: EpisodeLine) => m.from === 'ai' && m.at.getTime() >= askedAt && m.at.getTime() < askedAt + ONE_COMMIT_MS;
    const handoverLine = (m: EpisodeLine) =>
      withdrawnAt !== null && m.from === 'ai' && m.at.getTime() >= withdrawnAt && m.at.getTime() < withdrawnAt + ONE_COMMIT_MS;

    const pending = new Set(asked.map((q) => q.slot));
    const walk: ReplyWalk = { window: { kind: 'direct' }, person: false, personReplies: 0 };
    for (const line of after) {
      if (pending.size === 0) break;
      if (line.from === 'system' || ownReply(line)) continue;
      // A person took the thread: a staff line, or the hand-over's own line — or, after a hand-over that wrote no line, the customer's next one.
      const tookOver = line.from === 'staff' || (line.from === 'ai' && !walk.person && handoverLine(line));
      const silentHandover = line.from === 'customer' && !walk.person && withdrawnAt !== null && line.at.getTime() > withdrawnAt;
      if (tookOver || silentHandover) {
        if (line.from === 'staff') for (const q of asked) if (q.state === 'open' && pending.has(q.slot)) read.set(q.id, WITHDRAWN);
        walk.window = personWindow(walk, tookOver ? line.text : null);
        walk.person = true;
        if (tookOver) continue;
      } else if (line.from !== 'customer') {
        // The assistant's next reply: a later line is never read as the answer.
        walk.window = closedWindow(walk);
        continue;
      }
      const reply = walk.window;
      if (reply === null || line.text === null) continue;
      const slots = [...pending];
      let bare: AiAskedSlot[] | undefined;
      if (reply.kind === 'person') {
        reply.replied = true;
        const leadAsks = slotsAskedIn(reply.leads);
        const asksNothing = questionsIn(reply.leads).length === 0;
        bare = slots.filter((s) => leadAsks.includes(s) || (reply.first && asksNothing));
      }
      if (inBurst.has(line.id)) memory.hadOpen = true;
      const answers = readSlotAnswers(slots, line.text, today, bare === undefined ? {} : { bare });
      for (const q of asked) {
        if (!pending.has(q.slot) || !(q.slot in answers)) continue;
        read.set(q.id, { state: 'answered', answer: answers[q.slot] ?? null, answeredMessageId: line.id });
        pending.delete(q.slot);
      }
    }
  }

  for (const r of rows) {
    const seen = read.get(r.id);
    if (seen?.state === 'answered') memory.fills.push({ id: r.id, slot: r.slot, answer: seen.answer, answeredMessageId: seen.answeredMessageId! });
    if (seen?.state === 'withdrawn' && r.state === 'open') memory.withdrawals.push({ id: r.id, slot: r.slot });
    // A line that never left asked nothing: it is no ask the guard counts, and the prompt does not name it.
    if (neverLeft(r)) continue;
    memory.questions.push({
      id: r.id,
      slot: r.slot,
      state: seen?.state ?? r.state,
      askedAt: r.askedAt,
      askedMessageId: r.askedMessageId,
      answer: seen ? seen.answer : r.answer,
      answeredMessageId: seen ? seen.answeredMessageId : r.answeredMessageId,
    });
  }
  return memory;
}

/** The memory as the prompt shows it (`@oto/assistant` `PromptMemory`). */
export function promptMemoryOf(memory: OpenQuestionMemory): PromptMemory {
  return { questions: memory.questions.map((q) => ({ slot: q.slot, askedAt: q.askedAt, state: q.state, answer: q.answer })) };
}

/**
 * The effort a turn's model call runs at: the configured open-question effort
 * (`InboxAiConfig.openQuestionEffort`, unset by default) when a question was
 * open as this burst came, else the client's own.
 */
export function openQuestionEffort(configured: AiEffort | null | undefined, memory: OpenQuestionMemory): AiEffort | undefined {
  return configured && memory.hadOpen ? configured : undefined;
}

// --- 2. The guard --------------------------------------------------------------------------

/** One trip of the guard, as the turn's records keep it: words and counts, never an answer. */
export interface RepeatTrip {
  slot: AiAskedSlot;
  kind: RepeatKind;
  asks: number;
  round: 1 | 2;
  /** What the trip led to: the turn decided again, or the hand-over. */
  outcome: 'rethink' | 'handover';
}

/** The part of a decided turn the guard reads and may replace (`ai-engine.ts` `TurnResult`). */
export interface RepeatDecided {
  decision: AiDecision;
  verdict: GateVerdict;
  usage?: TurnUsage | null;
  latencyMs?: number;
  model?: string | null;
  /** The engine's reason word when the guard handed over (`REPEAT_QUESTION`). */
  turnReason?: string;
  /** The turn's memory and the guard's trips, for the commit. */
  openQuestion?: OpenQuestionTurn;
}

/** What the commit is handed (`TurnResult.openQuestion`). */
export interface OpenQuestionTurn {
  memory: OpenQuestionMemory;
  trips: RepeatTrip[];
}

export interface RepeatStageInput {
  db: Db;
  turn: { id: string; operatorId: string; conversationId: string; reason: string | null; attempts: number };
  conv: { id: string; operatorId: string; branchId: string | null };
  memory: OpenQuestionMemory;
  promptInput: PromptInput;
  first: RepeatDecided;
  /** The engine's model call (its ops run recorded), at the turn's effort. */
  ask: (prompt: BuiltPrompt) => Promise<AssistantOutcome>;
  /** The engine's gate over a decision, with the turn's episode and open lines. */
  gate: (decision: AiDecision, grounding: ReadonlyMap<string, GroundingSource>) => GateVerdict;
  /** An operator rule's ask-first question is the reply: asked once by its own rule, never refused here. */
  askFirst: boolean;
  now: Date;
}

/** The refusal a draft earns: only a reply that is sent asks anything. */
export function refusalOf(d: AiDecision, v: GateVerdict, memory: OpenQuestionMemory): RepeatRefusal | null {
  if (v.action !== 'answer') return null;
  const asked = askedSlotsOf(d.askedSlots, v.bubbles);
  if (asked.length === 0) return null;
  return repeatGuard({ asked, questions: memory.questions, intents: v.intents });
}

/** The hand-over a refused repeat ends in: the thread's own team, its warm closing line, none of the model's words. */
function repeatHandover(v: Extract<GateVerdict, { action: 'answer' }>): GateVerdict {
  return {
    action: 'handover',
    reason: 'OVERRULED_HANDOVER',
    intent: v.intent,
    intents: v.intents,
    language: v.language,
    plan: REPEAT_HANDOVER,
    holdingBubbles: [],
    droppedHoldingRule: REPEAT_RULE,
    branchNamed: v.branchNamed,
  };
}

/** The turn's one claim on a repeat rethink, in one statement (as the engine's `markRethink`). */
async function markRepeatRethink(db: Db, turn: RepeatStageInput['turn'], now: Date): Promise<boolean> {
  const at = new Date(Math.max(now.getTime(), Date.now()));
  const rows = await db
    .update(aiTurn)
    .set({ reason: REPEAT_RETHINK_MARK, leaseUntil: new Date(at.getTime() + 90_000), updatedAt: at })
    .where(
      and(
        eq(aiTurn.operatorId, turn.operatorId),
        eq(aiTurn.id, turn.id),
        eq(aiTurn.state, 'deciding'),
        eq(aiTurn.attempts, turn.attempts),
      ),
    )
    .returning({ id: aiTurn.id });
  return rows.length === 1;
}

/** Every trip is counted: one audit row, the slot and why — never what the customer said. */
async function countTrip(db: Db, input: Pick<RepeatStageInput, 'turn' | 'conv'>, trip: RepeatTrip): Promise<void> {
  await audit.record(db, {
    actorAccountId: null,
    action: REPEAT_GUARD_ACTION,
    entityType: 'inbox.ai_turn',
    entityId: input.turn.id,
    operatorId: input.turn.operatorId,
    branchId: input.conv.branchId,
    requestId: null,
    after: { turnId: input.turn.id, conversationId: input.conv.id, ...trip },
  });
}

const addUsage = (a: TurnUsage | null | undefined, b: TurnUsage | null | undefined): TurnUsage | null =>
  !a && !b
    ? null
    : {
        inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
        outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
        cacheReadTokens: (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
        cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0),
      };

/**
 * THE REPEAT GUARD'S STAGE, in the decide phase with no transaction open,
 * right after the gate. A draft the guard passes goes on unchanged. A refused
 * one is decided ONCE more with the fact beside the conversation; a second
 * refusal, two unanswered asks, a rethink the provider fails, or a second
 * pass that would say nothing becomes the hand-over to the thread's team.
 */
export async function repeatStage(input: RepeatStageInput): Promise<RepeatDecided> {
  const { first, memory } = input;
  const trips: RepeatTrip[] = [];
  const carried = (r: RepeatDecided): RepeatDecided => ({ ...r, openQuestion: { memory, trips } });
  if (input.askFirst) return carried(first);
  const refusal = refusalOf(first.decision, first.verdict, memory);
  if (!refusal || first.verdict.action !== 'answer') return carried(first);

  const handOver = async (r: RepeatDecided, round: 1 | 2, why: RepeatRefusal, v: Extract<GateVerdict, { action: 'answer' }>) => {
    const trip: RepeatTrip = { slot: why.slot, kind: why.kind, asks: why.asks, round, outcome: 'handover' };
    trips.push(trip);
    await countTrip(input.db, input, trip);
    return carried({ ...r, verdict: repeatHandover(v), turnReason: REPEAT_REASON });
  };

  // A re-claim after a lost lease mid-rethink never rethinks twice.
  const rethought = input.turn.reason === REPEAT_RETHINK_MARK;
  if (repeatStep(refusal, rethought) === 'handover') return handOver(first, 1, refusal, first.verdict);
  // No longer this claim's (a person acted, or the lease was lost): the commit finds it so and writes nothing.
  if (!(await markRepeatRethink(input.db, input.turn, input.now))) return carried(first);
  const trip: RepeatTrip = { slot: refusal.slot, kind: refusal.kind, asks: refusal.asks, round: 1, outcome: 'rethink' };
  trips.push(trip);
  await countTrip(input.db, input, trip);

  const hint = { slot: refusal.slot, kind: refusal.kind as Exclude<RepeatKind, 'asked_twice'>, answer: refusal.answer };
  const built = buildPrompt({ ...input.promptInput, repeat: hint });
  if (!built.ok) return handOver(first, 2, refusal, first.verdict);
  const outcome = await input.ask(built.prompt);
  const spent: RepeatDecided = {
    ...first,
    model: outcome.model ?? first.model ?? null,
    usage: addUsage(first.usage, outcome.usage),
    latencyMs: (first.latencyMs ?? 0) + Math.max(0, Math.round(outcome.latencyMs)),
  };
  if (!outcome.ok) return handOver(spent, 2, refusal, first.verdict);
  const verdict = input.gate(outcome.decision, built.prompt.grounding);
  const second: RepeatDecided = { ...spent, decision: outcome.decision, verdict };
  // A second pass that would say nothing is no answer to what the customer asked.
  if (verdict.action === 'silent') return handOver(second, 2, refusal, first.verdict);
  const again = refusalOf(outcome.decision, verdict, memory);
  if (again && verdict.action === 'answer') return handOver(second, 2, again, verdict);
  return carried(second);
}

/** The repeat guard already decided this turn again: the wrong-topic rethink (SCRUM-678) does not add a third call. */
export function rethoughtForRepeat(openQuestion: OpenQuestionTurn | undefined): boolean {
  return (openQuestion?.trips ?? []).some((t) => t.outcome === 'rethink');
}

/**
 * The wrong-topic rethink's second round (SCRUM-678) through the same net: a
 * draft asking again what the customer answered is refused (the rethink then
 * ends in its unclear hand-over) and the trip is counted.
 */
export async function repeatRefusedAfterRethink(
  db: Db,
  turn: RepeatStageInput['turn'],
  conv: RepeatStageInput['conv'],
  decision: AiDecision,
  verdict: GateVerdict,
  openQuestion: OpenQuestionTurn | undefined,
): Promise<boolean> {
  if (!openQuestion) return false;
  const refusal = refusalOf(decision, verdict, openQuestion.memory);
  if (!refusal) return false;
  const trip: RepeatTrip = { slot: refusal.slot, kind: refusal.kind, asks: refusal.asks, round: 2, outcome: 'handover' };
  openQuestion.trips.push(trip);
  await countTrip(db, { turn, conv }, trip);
  return true;
}

// --- 3. The commit -------------------------------------------------------------------------

/** What the commit wrote, as one line of the turn's audit: slots only. */
export interface OpenQuestionCommit {
  asked: AiAskedSlot[];
  answered: AiAskedSlot[];
  withdrawn: AiAskedSlot[];
}

/**
 * Under the thread lock, on a live number: the answers this turn read are
 * kept (an open question's, or one a person took over), a hand-over
 * withdraws every question still open (a person has the
 * thread), and the questions the sent reply asks are recorded, each on the
 * line that asked it — an older open row of the same slot withdrawn first.
 * One audit row when anything changed, slots only.
 */
export async function commitOpenQuestions(
  tx: Tx,
  a: {
    conv: { id: string; operatorId: string; branchId: string | null };
    turnId: string;
    openQuestion: OpenQuestionTurn | undefined;
    decision: AiDecision | undefined;
    /** The verdict the turn acts on; null for a silent turn. */
    verdict: GateVerdict | undefined;
    /** The turn hands the thread to a person (with or after its answer). */
    handover: boolean;
    /** The lines the turn wrote, in order, with the ids `writeLines` gave them. */
    lines: ReadonlyArray<{ id: string; body: string | null }>;
    at: Date;
  },
): Promise<OpenQuestionCommit> {
  const done: OpenQuestionCommit = { asked: [], answered: [], withdrawn: [] };
  const memory = a.openQuestion?.memory;
  const scope = and(eq(conversationOpenQuestion.operatorId, a.conv.operatorId), eq(conversationOpenQuestion.conversationId, a.conv.id));
  const stillOpen = eq(conversationOpenQuestion.state, 'open');
  // A question a person took over is answered too when the customer's reply to them says it.
  const notAnswered = inArray(conversationOpenQuestion.state, ['open', 'withdrawn']);

  for (const f of memory?.fills ?? []) {
    const rows = await tx
      .update(conversationOpenQuestion)
      .set({ state: 'answered', answer: f.answer, answeredMessageId: f.answeredMessageId, closedAt: a.at, updatedAt: a.at })
      .where(and(scope, eq(conversationOpenQuestion.id, f.id), notAnswered))
      .returning({ id: conversationOpenQuestion.id });
    if (rows.length > 0) done.answered.push(f.slot);
  }
  const withdraw = async (where: ReturnType<typeof and>) => {
    const rows = await tx
      .update(conversationOpenQuestion)
      .set({ state: 'withdrawn', closedAt: a.at, updatedAt: a.at })
      .where(and(scope, stillOpen, where))
      .returning({ slot: conversationOpenQuestion.slot });
    done.withdrawn.push(...rows.map((r) => r.slot));
  };
  const gone = (memory?.withdrawals ?? []).map((w) => w.id);
  if (gone.length > 0) await withdraw(inArray(conversationOpenQuestion.id, gone));
  if (a.handover) await withdraw(sql`true`);

  const v = a.verdict;
  if (!a.handover && v?.action === 'answer' && a.decision) {
    const sent = a.lines.filter((l): l is { id: string; body: string } => l.body !== null && l.body.trim() !== '');
    for (const slot of askedSlotsOf(a.decision.askedSlots, sent.map((l) => l.body))) {
      const line =
        sent.find((l) => slotsAskedIn([l.body]).includes(slot)) ?? [...sent].reverse().find((l) => questionsIn([l.body]).length > 0) ?? sent.at(-1);
      if (!line) continue;
      await withdraw(eq(conversationOpenQuestion.slot, slot));
      await tx.insert(conversationOpenQuestion).values({
        id: newId(),
        operatorId: a.conv.operatorId,
        conversationId: a.conv.id,
        slot,
        state: 'open',
        turnId: a.turnId,
        askedMessageId: line.id,
        askedAt: a.at,
        createdAt: a.at,
        updatedAt: a.at,
      });
      done.asked.push(slot);
    }
  }

  if (done.asked.length + done.answered.length + done.withdrawn.length > 0) {
    await audit.record(tx, {
      actorAccountId: null,
      action: 'inbox.ai.open_question',
      entityType: 'inbox.conversation',
      entityId: a.conv.id,
      operatorId: a.conv.operatorId,
      branchId: a.conv.branchId,
      requestId: null,
      after: { turnId: a.turnId, ...done },
    });
  }
  return done;
}

// --- 4. The inbox, and the erasure ---------------------------------------------------------

/** A thread's questions, oldest first, as the inbox shows them under the asking line. */
export async function openQuestionsOf(db: Exec, operatorId: string, conversationId: string): Promise<InboxOpenQuestion[]> {
  const rows = await db
    .select()
    .from(conversationOpenQuestion)
    .where(and(eq(conversationOpenQuestion.operatorId, operatorId), eq(conversationOpenQuestion.conversationId, conversationId)))
    .orderBy(asc(conversationOpenQuestion.askedAt), asc(conversationOpenQuestion.id))
    .limit(200);
  return rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    state: r.state,
    askedMessageId: r.askedMessageId,
    askedAt: r.askedAt.toISOString(),
    answer: r.answer,
    answeredMessageId: r.answeredMessageId,
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
  }));
}

/**
 * The erasure of a contact, and the retention purge of a thread: the answers
 * read from their messages go with the messages' words. The rows stay (slots
 * and ids), so the counts still add up.
 */
export async function eraseOpenQuestionAnswers(tx: Exec, operatorId: string, conversationIds: readonly string[], at: Date): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const rows = await tx
    .update(conversationOpenQuestion)
    .set({ answer: null, updatedAt: at })
    .where(
      and(
        eq(conversationOpenQuestion.operatorId, operatorId),
        inArray(conversationOpenQuestion.conversationId, [...conversationIds]),
        isNotNull(conversationOpenQuestion.answer),
      ),
    )
    .returning({ id: conversationOpenQuestion.id });
  return rows.length;
}
