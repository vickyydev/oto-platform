import type {
  ImpersonationApproval, ImpersonationTargetApp, SupportSection, TraceKind,
} from '@/api/support';
import type { Tone } from '@/components/Status';

/**
 * SCRUM-648 Support tools: the page's rules as pure functions, so the node
 * tests pin each one without a browser — how sections group by app, what each
 * status says, how a Money oversight link opens a trace, which refusals are
 * shown in which words, and when a write-allowed window may be opened.
 */

export const APP_ORDER = ['crm', 'pos', 'inbox', 'oto_app', 'platform'] as const;
export const APP_NAMES: Record<(typeof APP_ORDER)[number], string> = {
  crm: 'Members (CRM)', pos: 'POS', inbox: 'Inbox', oto_app: 'OTO App', platform: 'Platform',
};
export const TARGET_APP_NAMES: Record<ImpersonationTargetApp, string> = {
  pos: 'POS', oto_app: 'OTO App', radar: 'Radar', inbox: 'Inbox',
};

/** Sections in the fixed app order, each app's own sections in the order the server answered. */
export function groupByApp(sections: readonly SupportSection[]) {
  return APP_ORDER.map(app => ({ app, name: APP_NAMES[app], sections: sections.filter(s => s.app === app) }))
    .filter(group => group.sections.length > 0);
}

export function sectionStatus(section: Pick<SupportSection, 'status' | 'rowCount' | 'permission'>): { tone: Tone; words: string } {
  switch (section.status) {
    case 'found': return { tone: 'ok', words: `${section.rowCount} found` };
    case 'empty': return { tone: 'idle', words: 'Nothing found' };
    case 'denied': return { tone: 'warn', words: section.permission ? `Not on your access (${section.permission})` : 'Not on your access' };
    case 'unavailable': return { tone: 'down', words: 'Could not be read' };
    case 'not_built': return { tone: 'idle', words: 'No reader yet' };
  }
}

/** A masked value, as the server writes it. */
export const MASKED = '[redacted]';
export const isMasked = (value: unknown) => value === MASKED;

const SCALAR = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const HIDDEN_KEYS = new Set(['operatorId']);

/** The scalar fields of one returned record, for the compact list: never more than `limit`. */
export function rowFacts(row: Record<string, unknown>, limit = 8): Array<[string, string | number | boolean | null]> {
  return Object.entries(row).filter(([key, value]) => !HIDDEN_KEYS.has(key) && SCALAR(value)).slice(0, limit) as Array<[string, string | number | boolean | null]>;
}

const TRACE_KINDS: readonly TraceKind[] = ['action', 'sale', 'refund', 'payment_attempt', 'receipt', 'wallet'];

/**
 * The trace a page address asks for: exactly the Money oversight link shape,
 * `?trace=<id>&kind=sale|refund|payment_attempt|receipt|wallet` (an action id
 * when no kind is named). Anything else opens nothing.
 */
export function traceFromSearch(search: string): { id: string; kind: TraceKind } | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const id = params.get('trace')?.trim();
  if (!id || id.length > 128) return null;
  const kind = params.get('kind') ?? 'action';
  return (TRACE_KINDS as readonly string[]).includes(kind) ? { id, kind: kind as TraceKind } : null;
}

/** The words for a refusal the server gave an impersonation, by its code. */
export const IMPERSONATION_REFUSALS: Record<string, string> = {
  IMPERSONATION_SELF: 'You cannot view the suite as yourself.',
  IMPERSONATION_SUBJECT_PRIVILEGED: 'This account holds platform or Console authority, so it can never be viewed as.',
  IMPERSONATION_NESTED: 'A view-as window cannot open another one.',
  IMPERSONATION_SUBJECT_INACTIVE: 'Only an active account can be viewed as.',
  IMPERSONATION_SUBJECT_NO_APP: 'This account cannot open that app, so there is nothing to view as.',
  IMPERSONATION_SUBJECT_NO_SEAT: 'This account has no park to be seated at.',
  IMPERSONATION_REASON_REQUIRED: 'A window that can change things needs a reason and a reference.',
  SECOND_APPROVAL_REQUIRED: 'A second platform administrator must approve a window that can change things.',
  IMPERSONATION_READ_ONLY: 'This is a read-only view-as window: nothing can be changed from it.',
  APPROVAL_EXPIRED: 'The approval ran out before the window was opened. Ask again.',
  APPROVAL_CONTEXT_CHANGED: 'The approved window is not the one being opened.',
  FORBIDDEN: 'Viewing as another account needs console:support:impersonate held by a platform administrator.',
};
export function refusalWords(code: string | undefined, message: string): string {
  return (code && IMPERSONATION_REFUSALS[code]) || message;
}

export interface StartDraft {
  subjectAccountId: string;
  targetApp: ImpersonationTargetApp;
  mode: 'read_only' | 'write_allowed';
  reason: string;
  reference: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The approved request this draft would open, if there is one: same subject, app, reason and reference. */
export function matchingApproval(draft: StartDraft, approvals: readonly ImpersonationApproval[]) {
  return approvals.find(a => a.mine && a.state === 'approved' && a.subjectAccountId === draft.subjectAccountId
    && a.targetApp === draft.targetApp && a.reason === draft.reason.trim() && a.reference === draft.reference.trim()) ?? null;
}

export type StartGate =
  | { kind: 'start'; ready: boolean; missing: string[] }
  | { kind: 'request'; ready: boolean; missing: string[] }
  | { kind: 'waiting'; ready: false; missing: string[] };

/**
 * What the start button may do. Read-only opens at once. Write-allowed needs a
 * reason and a reference, and — while dual control applies — an approval
 * another administrator gave to exactly this window: until then the only
 * action is to ask for one, and while asked it waits.
 */
export function startGate(draft: StartDraft, input: { dualControl: boolean; approvals: readonly ImpersonationApproval[] }): StartGate {
  const missing: string[] = [];
  if (!UUID.test(draft.subjectAccountId.trim())) missing.push('The account id of the person to view as');
  if (draft.mode === 'read_only') return { kind: 'start', ready: missing.length === 0, missing };
  if (!draft.reason.trim()) missing.push('A reason');
  if (!draft.reference.trim()) missing.push('A reference (ticket or incident)');
  if (!input.dualControl) return { kind: 'start', ready: missing.length === 0, missing };
  if (matchingApproval(draft, input.approvals)) return { kind: 'start', ready: missing.length === 0, missing };
  const pending = input.approvals.some(a => a.mine && a.state === 'pending' && a.subjectAccountId === draft.subjectAccountId.trim()
    && a.targetApp === draft.targetApp && a.reason === draft.reason.trim() && a.reference === draft.reference.trim());
  if (pending) return { kind: 'waiting', ready: false, missing: ['A second platform administrator’s approval'] };
  return { kind: 'request', ready: missing.length === 0, missing };
}

/** "12:04 left": the window's countdown, never below zero. */
export function remaining(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(ms / 60_000), seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The banner's sentence: who is really there, as whom, where, in which mode. */
export function bannerWords(w: { actor: { name: string | null }; subject: { name: string | null }; targetApp: ImpersonationTargetApp;
  mode: 'read_only' | 'write_allowed' }, viewer: 'actor' | 'subject_session'): string {
  const app = TARGET_APP_NAMES[w.targetApp];
  const subject = w.subject.name ?? 'a staff account';
  const actor = w.actor.name ?? 'A support administrator';
  const mode = w.mode === 'read_only' ? 'read-only' : 'changes allowed';
  return viewer === 'actor'
    ? `You (${actor}) are viewing ${app} as ${subject} — ${mode}`
    : `${actor} is viewing ${app} as ${subject} — ${mode}`;
}
