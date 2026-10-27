import type { SuiteFlagPreview, SuiteFlags } from '@/api/suite-controls';

/**
 * SCRUM-643 (S2-23 release controls, planner ruling Q24): the rules the
 * Release controls page enforces before it lets a platform administrator
 * press a confirm button. Pure, so each rule is pinned on its own.
 *
 * The three safety rules, as S2-23 words them:
 *  (a) every kill switch carries an expiry — default 60 minutes, at most the
 *      server's KILL_SWITCH_MAX_TTL_MIN — and the page says when it reverts;
 *  (b) the blast-radius preview of EXACTLY the pending choice is on screen
 *      before the confirm button enables;
 *  (c) each flip takes the typed confirmation phrase and a reason.
 *
 * The server checks every one of these again; the page only refuses to offer
 * a button that can only fail.
 */

export type CatalogueEntry = SuiteFlags['catalogue'][number];
export type FlagOverride = SuiteFlags['overrides'][number];
export type PendingApproval = SuiteFlags['approvals'][number];
export type ScopeType = CatalogueEntry['scopes'][number];

/** The registry's names for the six suite apps, as the launcher shows them. */
export const SUITE_APP_NAMES: Record<CatalogueEntry['targetApp'], string> = {
  pos: 'POS', console: 'Admin', oto_app: 'OTO App', radar: 'Radar', booth: 'Lucky Wheel', inbox: 'Inbox',
};

export const SCOPE_WORDS: Record<ScopeType, string> = {
  platform: 'Every park group', operator: 'This park group', branch: 'One park', station: 'One station',
};

/**
 * Q24: only the integrated switches are offered — pause outbound messaging
 * and block new sign-ins per app. Every other named switch is listed and
 * never offered, because the server refuses it with FLAG_UNSUPPORTED.
 */
export function isActionableSwitch(entry: CatalogueEntry): boolean {
  return entry.kind === 'kill_switch' && entry.supported && entry.valueType === 'boolean';
}

/** One place, one value: what a switch-on would change, and what its preview must be for. */
export interface SwitchChoice {
  key: string;
  scopeType: ScopeType;
  scopeId: string | null;
  operatorId: string | null;
  /** The value as the preview route takes it ('true' for a boolean switch turned on). */
  value: string;
}

/** A choice names its place completely: platform has no ids; every other scope its own and its park group's. */
export function choiceComplete(choice: SwitchChoice | null): choice is SwitchChoice {
  if (!choice) return false;
  if (choice.scopeType === 'platform') return choice.scopeId === null && choice.operatorId === null;
  if (!choice.scopeId || !choice.operatorId) return false;
  return choice.scopeType !== 'operator' || choice.scopeId === choice.operatorId;
}

/** Rule (b): the preview on screen is for this exact switch, place and value — nothing older or nearby. */
export function previewMatches(preview: SuiteFlagPreview | null, choice: SwitchChoice | null): boolean {
  if (!preview || !choiceComplete(choice)) return false;
  return preview.flagKey === choice.key && preview.scopeType === choice.scopeType
    && preview.scopeId === choice.scopeId && preview.operatorId === choice.operatorId
    && String(preview.value) === choice.value;
}

/** The preview route's query for a choice; absent ids are left out rather than sent empty. */
export function previewQuery(choice: SwitchChoice) {
  return {
    key: choice.key, scopeType: choice.scopeType, value: choice.value,
    ...(choice.scopeId ? { scopeId: choice.scopeId } : {}),
    ...(choice.operatorId ? { operatorId: choice.operatorId } : {}),
  };
}

/** Rule (a): a whole number of minutes, at least one, never past the server's maximum. */
export function expiryProblem(minutes: number | null, maxTtlMinutes: number | null): string | null {
  if (minutes === null || !Number.isInteger(minutes) || minutes < 1) return 'Choose how many minutes it lasts (at least 1).';
  if (maxTtlMinutes !== null && minutes > maxTtlMinutes) return `The server allows at most ${maxTtlMinutes} minutes.`;
  return null;
}

export function autoRevertAt(nowMs: number, minutes: number): string {
  return new Date(nowMs + minutes * 60_000).toISOString();
}

export interface Gate { ready: boolean; missing: string[] }
const gate = (missing: Array<string | null | false>): Gate => {
  const left = missing.filter((item): item is string => typeof item === 'string');
  return { ready: left.length === 0, missing: left };
};
const typed = (confirmation: string, phrase: string) =>
  confirmation === phrase ? null : `Type ${phrase} exactly to confirm.`;
const reasoned = (reason: string) => reason.trim().length > 0 ? null : 'Give a reason.';

/** Switching ON: place, preview of exactly that place, expiry, reason, typed phrase. */
export function switchOnGate(input: {
  choice: SwitchChoice | null; preview: SuiteFlagPreview | null; minutes: number | null; maxTtlMinutes: number;
  reason: string; confirmation: string; busy: boolean;
}): Gate {
  const complete = choiceComplete(input.choice);
  return gate([
    !complete && 'Choose where the switch applies.',
    complete && !previewMatches(input.preview, input.choice) && 'Preview the blast radius of exactly this choice.',
    expiryProblem(input.minutes, input.maxTtlMinutes),
    reasoned(input.reason),
    input.choice ? typed(input.confirmation, input.choice.key) : null,
    input.busy && 'Sending…',
  ]);
}

/** Switching OFF restores service: one administrator, a reason and the typed phrase. */
export function switchOffGate(input: { key: string; reason: string; confirmation: string; busy: boolean }): Gate {
  return gate([reasoned(input.reason), typed(input.confirmation, input.key), input.busy && 'Sending…']);
}

/** Approving or applying someone's reviewed request: the preview of exactly that operation, and the phrase. */
export function reviewGate(input: { choice: SwitchChoice | null; preview: SuiteFlagPreview | null; confirmation: string; busy: boolean }): Gate {
  return gate([
    !previewMatches(input.preview, input.choice) && 'Preview the blast radius of exactly this request.',
    input.choice ? typed(input.confirmation, input.choice.key) : 'This request cannot be read.',
    input.busy && 'Sending…',
  ]);
}

export function maintenanceSetGate(input: {
  appKey: string; message: string; minutes: number | null; maxTtlMinutes: number | null;
  reason: string; confirmation: string; busy: boolean;
}): Gate {
  return gate([
    input.message.trim().length === 0 && 'Write the message the tile shows.',
    expiryProblem(input.minutes, input.maxTtlMinutes),
    reasoned(input.reason),
    typed(input.confirmation, input.appKey),
    input.busy && 'Sending…',
  ]);
}

export function maintenanceClearGate(input: { appKey: string; reason: string; confirmation: string; busy: boolean }): Gate {
  return gate([reasoned(input.reason), typed(input.confirmation, input.appKey), input.busy && 'Sending…']);
}

/** The stored row's revision at exactly this place (0: nothing stored there yet), expired or not. */
export function revisionAt(overrides: readonly FlagOverride[], key: string, scopeType: ScopeType, scopeId: string | null): number {
  return overrides.find(row => row.flagKey === key && row.scopeType === scopeType && row.scopeId === scopeId)?.revision ?? 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPES: readonly ScopeType[] = ['platform', 'operator', 'branch', 'station'];

/** The reviewed operation as stored (`key`, not `flagKey`); anything malformed is not offered for approval. */
export interface ApprovalOperation {
  key: string;
  targetApp: string;
  scopeType: ScopeType;
  scopeId: string | null;
  operatorId: string | null;
  value: boolean | string;
  expiresAt: string;
  reason: string;
}
export function operationOf(approval: PendingApproval): ApprovalOperation | null {
  const op = approval.operation;
  const id = (value: unknown) => value === null || (typeof value === 'string' && UUID.test(value));
  if (typeof op.key !== 'string' || typeof op.targetApp !== 'string' || typeof op.reason !== 'string'
    || typeof op.expiresAt !== 'string' || Number.isNaN(Date.parse(op.expiresAt))
    || !SCOPES.includes(op.scopeType as ScopeType) || !id(op.scopeId) || !id(op.operatorId)
    || (typeof op.value !== 'boolean' && typeof op.value !== 'string')) return null;
  return { key: op.key, targetApp: op.targetApp, scopeType: op.scopeType as ScopeType, scopeId: op.scopeId as string | null,
    operatorId: op.operatorId as string | null, value: op.value, expiresAt: op.expiresAt, reason: op.reason };
}

export function choiceOfOperation(op: ApprovalOperation | null): SwitchChoice | null {
  return op ? { key: op.key, scopeType: op.scopeType, scopeId: op.scopeId, operatorId: op.operatorId, value: String(op.value) } : null;
}

export interface ApprovalStep {
  /** The one action this administrator could take on this request now. */
  kind: 'approve' | 'apply' | 'none';
  enabled: boolean;
  /** Why it is not available, said on the card rather than hidden. */
  why: string | null;
}

/**
 * Dual control: a different administrator approves; then the requester or
 * the approver applies. A request I made myself shows its approve control
 * disabled, with the reason.
 */
export function approvalStep(approval: PendingApproval, me: string | null, canWrite: boolean, nowMs: number): ApprovalStep {
  if (Date.parse(approval.requestExpiresAt) <= nowMs) {
    return { kind: 'none', enabled: false, why: approval.state === 'approved'
      ? 'This approval ran out before it was applied; ask again.'
      : 'This request was not approved within ten minutes; ask again.' };
  }
  if (approval.state === 'pending') {
    if (!canWrite) return { kind: 'approve', enabled: false, why: 'Approving needs a platform administrator.' };
    if (me !== null && me === approval.requesterAccountId) {
      return { kind: 'approve', enabled: false, why: 'You asked for this switch. A different platform administrator must approve it.' };
    }
    return { kind: 'approve', enabled: true, why: null };
  }
  if (approval.state === 'approved') {
    if (!canWrite) return { kind: 'apply', enabled: false, why: 'Applying needs a platform administrator.' };
    if (me === null || (me !== approval.requesterAccountId && me !== approval.approverAccountId)) {
      return { kind: 'apply', enabled: false, why: 'Only the administrator who asked or the one who approved can apply it.' };
    }
    return { kind: 'apply', enabled: true, why: null };
  }
  return { kind: 'none', enabled: false, why: null };
}

/** Who did it, as the reader is: "You" for their own account, otherwise the recorded account id. */
export function personWords(accountId: string | null, me: string | null): string {
  if (!accountId) return 'Not recorded';
  return accountId === me ? 'You' : `Account ${accountId}`;
}
