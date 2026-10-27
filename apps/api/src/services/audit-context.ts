import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from '../plugins/session';

type Attribution = Readonly<{ homeOperatorId: string; effectiveOperatorId: string }>;
/** SCRUM-648: whose hands were really on a marked (impersonated) session. */
export type ImpersonationAttribution = Readonly<{ impersonationId: string; actorAccountId: string; subjectAccountId: string }>;
type AuditContext = Readonly<{
  actorAccountId: string; sessionId: string; attribution: Attribution; impersonation: ImpersonationAttribution | null;
}>;
const contexts = new AsyncLocalStorage<AuditContext | null>();

function capturedContext(auth: Readonly<AuthContext> | null): AuditContext | null {
  if (!auth || auth.status !== 'active' || !auth.accountId || !auth.sessionId || !auth.operatorId) return null;
  const override = auth.operatorOverride ?? null, revision = auth.operatorRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  // Older internal callers may name an honest home session only. Missing
  // provenance must never turn a selected operator into somebody's home.
  if (!auth.homeOperatorId && (override !== null || revision !== 0)) return null;
  const home = auth.homeOperatorId ?? auth.operatorId;
  if (!home || (override === null ? auth.operatorId !== home
    : override === home || auth.operatorId !== override)) return null;
  const mark = auth.impersonation ?? null;
  return Object.freeze({ actorAccountId: auth.accountId, sessionId: auth.sessionId,
    attribution: Object.freeze({ homeOperatorId: home, effectiveOperatorId: auth.operatorId }),
    impersonation: mark && mark.subjectAccountId === auth.accountId ? Object.freeze({
      impersonationId: mark.id, actorAccountId: mark.actorAccountId, subjectAccountId: mark.subjectAccountId,
    }) : null });
}

/** Called only with server-verified auth, never an audit entry or request body. */
export function runWithAuditContext<T>(auth: Readonly<AuthContext> | null, continuation: () => T): T {
  return contexts.run(capturedContext(auth), continuation);
}

/** Event ownership and JSON payloads cannot supply or replace this provenance. */
export function auditContextForActor(actorAccountId: string | null): Attribution | null {
  const context = contexts.getStore();
  return actorAccountId !== null && context?.actorAccountId === actorAccountId ? context.attribution : null;
}

/**
 * SCRUM-648 — the impersonation behind a row written as `actorAccountId`, or
 * null. Only the verified session's own subject is ever rewritten.
 */
export function impersonationForActor(actorAccountId: string | null): ImpersonationAttribution | null {
  const context = contexts.getStore();
  return actorAccountId !== null && context?.actorAccountId === actorAccountId ? context.impersonation : null;
}
