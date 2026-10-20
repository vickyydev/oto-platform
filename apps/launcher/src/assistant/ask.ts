/**
 * THE ASK PANEL'S STATE MACHINE (SCRUM-591, round I3a; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §D.1, §D.4).
 *
 * Pure apart from what it is handed (`AskDeps`), so the unit tests drive it
 * with a fake api and a clock that does not wait.
 *
 *   idle ──send──▶ sending ──200──────────────▶ done (answered | refused | link_only | failed | capped | off)
 *                     │      └─200 x-oto-replay▶ done, replayed
 *                     ├─409 ASK_IN_FLIGHT──▶ still-answering ──poll GET /assistant/asks/:id──▶ done
 *                     │                                        └─no end in POLL_LIMIT_MS──▶ unreachable
 *                     ├─403──▶ refused-access (the api's own sentence)
 *                     ├─network / 5xx──▶ unreachable (the fixed failure line; the question is kept)
 *                     └─other 4xx──▶ rejected (the api's own sentence; the question is kept)
 *
 * The id is the caller's (house id rule). A failed send keeps it with the
 * question, so "Ask" again resends the SAME id: if the api did finish the ask
 * the answer comes back from its row (`x-oto-replay`), if it is still running
 * the 409 is followed, and if it never arrived it is asked for the first time.
 * An edited question is a new ask and gets a new id.
 */
import { INTERNAL_LINES } from '@oto/assistant/internal-lines';
import type { Permission } from '@oto/shared/permissions';
import { ApiError } from '@/api/client';
import type { AskFeedbackBody, AskFeedbackResult, AskView } from '@/api/assistant';

/** The permission that shows the panel at all (`assistant:ask:use`, held at any scope). */
export const ASK_PERMISSION: Permission = 'assistant:ask:use';

export type AskPhase =
  | { kind: 'idle' }
  | { kind: 'sending'; id: string; question: string }
  | { kind: 'still-answering'; id: string; question: string }
  | { kind: 'done'; ask: AskView; replayed: boolean }
  /** The api could not be reached, or failed; `line` is the server's own fixed failure line. */
  | { kind: 'unreachable'; id: string; question: string; line: string }
  /** 403: the api's sentence, e.g. "Missing permission assistant:ask:use". */
  | { kind: 'refused-access'; id: string; question: string; message: string }
  /** Any other refusal of the request itself (400, 423, 401): the api's sentence. */
  | { kind: 'rejected'; id: string; question: string; message: string };

export interface AskDeps {
  ask: (id: string, question: string) => Promise<{ view: AskView; replayed: boolean }>;
  one: (id: string) => Promise<AskView>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Every phase on the way, so the panel can show "still answering" while it polls. */
  onPhase?: (phase: AskPhase) => void;
}

/** How often a 409 in flight is looked at again. */
export const POLL_MS = 1500;
/**
 * How long to follow one before saying it could not be reached. The api's own
 * wall time is 45 s (plan §D.1), so an ask still `asking` past this is not
 * coming back on this page; the kept id finds it on the next send.
 */
export const POLL_LIMIT_MS = 60_000;

/**
 * The language of a question, by script — the same rule the api picks its
 * fixed lines by (`questionLanguage` in apps/api/src/services/assistant/engine.ts),
 * so a failure the api never saw reads in the same language as one it did.
 */
export function questionLanguage(question: string): 'th' | 'en' | 'ru' {
  if (/[฀-๿]/.test(question)) return 'th';
  if (/[Ѐ-ӿ]/.test(question)) return 'ru';
  return 'en';
}

/** The fixed failure line, never new copy (`INTERNAL_LINES.failed` in @oto/assistant). */
export function failureLine(question: string): string {
  return INTERNAL_LINES.failed[questionLanguage(question)];
}

/** The id to send under: the kept one when the same question is asked again after a failure. */
export function idForSend(phase: AskPhase, question: string, mint: () => string): string {
  const retryable = phase.kind === 'unreachable' || phase.kind === 'rejected' || phase.kind === 'still-answering';
  return retryable && phase.question === question.trim() ? phase.id : mint();
}

/** Whether the request never meant anything to the api (no answer, or the api fell over). */
function unreachableError(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status >= 500;
}

/** Follow an ask in flight until it ends, or until it is plainly not ending here. */
async function follow(id: string, question: string, deps: AskDeps): Promise<AskPhase> {
  const started = deps.now();
  for (;;) {
    await deps.sleep(POLL_MS);
    try {
      const ask = await deps.one(id);
      if (ask.state !== 'asking') return { kind: 'done', ask, replayed: false };
    } catch (err) {
      if (!unreachableError(err)) return fromError(err as ApiError, id, question);
      // A dropped poll is not the end of the ask: keep looking until the limit.
    }
    if (deps.now() - started >= POLL_LIMIT_MS) {
      return { kind: 'unreachable', id, question, line: failureLine(question) };
    }
  }
}

function fromError(err: ApiError, id: string, question: string): AskPhase {
  if (err.status === 403) return { kind: 'refused-access', id, question, message: err.message };
  return { kind: 'rejected', id, question, message: err.message };
}

/** Send one ask and see it to a phase the panel can rest on. */
export async function runAsk(id: string, rawQuestion: string, deps: AskDeps): Promise<AskPhase> {
  const question = rawQuestion.trim();
  const emit = (phase: AskPhase) => {
    deps.onPhase?.(phase);
    return phase;
  };
  emit({ kind: 'sending', id, question });
  try {
    const { view, replayed } = await deps.ask(id, question);
    if (view.state !== 'asking') return emit({ kind: 'done', ask: view, replayed });
    emit({ kind: 'still-answering', id, question });
    return emit(await follow(id, question, deps));
  } catch (err) {
    if (unreachableError(err)) return emit({ kind: 'unreachable', id, question, line: failureLine(question) });
    const apiErr = err as ApiError;
    if (apiErr.status === 409 && apiErr.code === 'ASK_IN_FLIGHT') {
      emit({ kind: 'still-answering', id, question });
      return emit(await follow(id, question, deps));
    }
    return emit(fromError(apiErr, id, question));
  }
}

// --- What an ask shows ------------------------------------------------------

/** The ask's answer as shown: the server's prose or fixed line, with the fixed line as the fallback. */
export function shownAnswer(ask: Pick<AskView, 'state' | 'answer' | 'question'>): string | null {
  if (ask.answer) return ask.answer;
  const lang = questionLanguage(ask.question);
  if (ask.state === 'failed') return INTERNAL_LINES.failed[lang];
  if (ask.state === 'off') return INTERNAL_LINES.off[lang];
  return null;
}

/** States a person can rate: the model answered, refused or linked. A switch or a cap is nothing to rate. */
const RATEABLE: ReadonlySet<AskView['state']> = new Set(['answered', 'refused', 'link_only']);

/** Feedback is once per ask, and only on an ask that ended in something the assistant said. */
export function canGiveFeedback(ask: Pick<AskView, 'state' | 'feedback'>): boolean {
  return ask.feedback === null && RATEABLE.has(ask.state);
}

export interface FeedbackDeps {
  send: (id: string, body: AskFeedbackBody, idempotencyKey: string) => Promise<AskFeedbackResult>;
  mint: () => string;
}

export const CORRECTION_MAX = 1000;
export const QUESTION_MAX = 2000;

/**
 * Give feedback once: the ask comes back with its verdict set, so the
 * buttons it was given by `canGiveFeedback` are gone. A correction goes only
 * with "wrong", trimmed, and is left off when empty.
 */
export async function giveFeedback(
  ask: AskView,
  feedback: 'good' | 'wrong',
  correction: string,
  deps: FeedbackDeps,
): Promise<AskView> {
  if (!canGiveFeedback(ask)) return ask;
  const text = feedback === 'wrong' ? correction.trim().slice(0, CORRECTION_MAX) : '';
  const body: AskFeedbackBody = text ? { feedback, correction: text } : { feedback };
  const result = await deps.send(ask.id, body, deps.mint());
  return { ...ask, feedback: result.feedback, correction: text || null, updatedAt: result.updatedAt };
}

/** Newest first, one row per ask: a fresh ask or a page merged into what is shown. */
export function mergeAsks(current: AskView[], incoming: AskView[]): AskView[] {
  const byId = new Map<string, AskView>();
  for (const ask of [...incoming, ...current]) if (!byId.has(ask.id)) byId.set(ask.id, ask);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
