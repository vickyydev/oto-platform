import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { Permission } from '@oto/shared/permissions';
import { readUiPreferences } from '@oto/shared/ui-preferences';
import { authApi, type EffectivePermission, type MeResponse, type OperatorContext } from '@/api/platform';
import { organisationApi } from '@/api/organisation';
import { ApiError, idemKey, installRequestAuthority } from '@/api/client';
import { handoffArrival } from '@/auth/handoff';
import { accountTheme } from '@/lib/theme';

type SessionState = 'loading' | 'signed-out' | 'signed-in';
type Choice = { id: string; name: string };
type MutationIdentity = { accountId: string; sessionId: string };
class SessionReplaced extends Error {}
type Confirmed = { me: MeResponse; permissions: EffectivePermission[]; context: OperatorContext };
type Frame = {
  state: SessionState; epoch: number; refreshing: boolean; confirmed: Confirmed | null;
  operatorChoices: Choice[]; operatorLoading: boolean; operatorSwitching: boolean;
  operatorError: string | null; handoffError: string | null;
};

interface SessionValue {
  state: SessionState;
  authorityEpoch: number;
  refreshing: boolean;
  isCurrentAuthority: (epoch: number) => boolean;
  me: MeResponse | null;
  permissions: EffectivePermission[];
  locked: boolean;
  handoffError: string | null;
  has: (permission: Permission) => boolean;
  effectiveOperatorId: string | null;
  operatorContext: OperatorContext | null;
  operatorChoices: Choice[];
  operatorError: string | null;
  operatorLoading: boolean;
  operatorSwitching: boolean;
  refreshSession: () => Promise<void>;
  switchOperator: (id: string, expectedEpoch: number) => Promise<void>;
  signIn: (phone: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  switchBranch: (branchId: string) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const nullableId = (value: unknown) => value === null || isId(value);
const messageOf = (failure: unknown) => failure instanceof Error
  ? failure.message : 'The current session could not be confirmed.';
const canSwitch = ({ me, permissions }: Confirmed) => me.isPlatformAdmin && !me.sessionLocked
  && !me.account.mustChangePassword && permissions.some(p => p.permission === 'platform:operator:switch'
    && p.scopeType === 'operator' && p.scopeId === null);

/** Every working scope comes from the verified session, never the home account as a fallback. */
function contextOf(me: MeResponse): OperatorContext {
  const c = me.operatorContext;
  if (!c || !isId(me.account.id) || !isId(me.account.operatorId) || !isId(c.sessionId)
    || !isId(c.homeOperatorId) || !isId(c.effectiveOperatorId) || !nullableId(c.operatorOverride)
    || !nullableId(c.branchId) || !nullableId(c.stationId) || !Number.isSafeInteger(c.revision)
    || c.revision < 0 || c.homeOperatorId !== me.account.operatorId
    || c.effectiveOperatorId !== (c.operatorOverride ?? c.homeOperatorId)
    || c.operatorOverride === c.homeOperatorId || c.branchId !== (me.branch?.id ?? null)
    || (c.stationId !== null && c.branchId === null) || me.account.status !== 'active'
    || typeof me.sessionLocked !== 'boolean' || typeof me.account.mustChangePassword !== 'boolean'
    || typeof me.isPlatformAdmin !== 'boolean') {
    throw new Error('The current operator context could not be confirmed.');
  }
  return c;
}

function identityOf(me: MeResponse, c: OperatorContext) {
  return JSON.stringify([me.account.id, c.sessionId, me.account.status, me.account.operatorId,
    c.homeOperatorId, c.effectiveOperatorId, c.operatorOverride, c.branchId, c.stationId, c.revision,
    me.sessionLocked, me.account.mustChangePassword, me.isPlatformAdmin]);
}

function permissionsOf(value: EffectivePermission[]): EffectivePermission[] {
  if (!Array.isArray(value) || value.some(p => !p || typeof p.permission !== 'string'
    || typeof p.scopeType !== 'string' || !nullableId(p.scopeId))) {
    throw new Error('The current access could not be confirmed.');
  }
  return value;
}

/** The provider outlives each keyed working scope; its refs fence retained callbacks immediately. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [frame, setFrame] = useState<Frame>({ state: 'loading', epoch: 0, refreshing: true,
    confirmed: null, operatorChoices: [], operatorLoading: false, operatorSwitching: false,
    operatorError: null, handoffError: null });
  const epoch = useRef(0);
  const live = useRef<Confirmed | null>(null);
  const mounted = useRef(true);
  const busy = useRef<object | null>(null);
  const owns = useCallback((value: number) => mounted.current && value === epoch.current, []);
  const isCurrentAuthority = useCallback((value: number) => owns(value) && live.current !== null, [owns]);

  const begin = useCallback((switching = false, state: SessionState = 'loading') => {
    const next = ++epoch.current;
    live.current = null;
    busy.current = null;
    accountTheme.release();
    setFrame(old => ({ ...old, state, epoch: next, refreshing: true, confirmed: null,
      operatorChoices: [], operatorLoading: false, operatorSwitching: switching, operatorError: null }));
    return next;
  }, []);

  const signedOut = useCallback(() => {
    begin(false, 'signed-out');
    setFrame(old => ({ ...old, refreshing: false }));
  }, [begin]);

  useEffect(() => installRequestAuthority({
    capture: () => live.current === null ? null : epoch.current,
    isCurrent: isCurrentAuthority,
  }), [isCurrentAuthority]);

  const readCanonical = useCallback(async (request: number, refusal: string | null = null,
    expected?: MutationIdentity) => {
    const requireOriginalSession = (me: MeResponse, context: OperatorContext) => {
      if (expected && (me.account.id !== expected.accountId || context.sessionId !== expected.sessionId)) {
        throw new SessionReplaced('The signed-in session changed.');
      }
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const first = await authApi.me();
        if (!owns(request)) return null;
        const firstContext = contextOf(first);
        requireOriginalSession(first, firstContext);
        const effective = permissionsOf((await authApi.permissions()).permissions);
        if (!owns(request)) return null;
        const current = await authApi.me();
        if (!owns(request)) return null;
        const context = contextOf(current);
        requireOriginalSession(current, context);
        if (identityOf(first, firstContext) !== identityOf(current, context)) continue;
        const confirmed = { me: current, permissions: effective, context };
        const needsChoices = canSwitch(confirmed);
        // Only this complete handshake makes ordinary guarded reads eligible.
        live.current = confirmed;
        accountTheme.adopt(readUiPreferences(current));
        setFrame(old => ({ ...old, state: 'signed-in', confirmed, refreshing: false,
          operatorSwitching: false, operatorLoading: needsChoices, operatorChoices: [],
          operatorError: refusal, handoffError: null }));
        if (needsChoices) {
          try {
            const { operators } = await organisationApi.adminApi.operators();
            if (!owns(request) || live.current !== confirmed) return null;
            if (!Array.isArray(operators) || operators.some(p => !isId(p.id) || typeof p.name !== 'string')
              || new Set(operators.map(p => p.id)).size !== operators.length) {
              throw new Error('The available operators could not be confirmed.');
            }
            setFrame(old => ({ ...old, operatorChoices: operators.map(p => ({ id: p.id, name: p.name })),
              operatorLoading: false }));
          } catch (failure) {
            if (!owns(request) || live.current !== confirmed) return null;
            setFrame(old => ({ ...old, operatorLoading: false,
              operatorError: refusal ?? messageOf(failure) }));
          }
        }
        return confirmed;
      }
      throw new Error('The session changed while it was being read. Retry to confirm its current operator.');
    } catch (failure) {
      if (!owns(request)) return null;
      // A previous mutation owns neither the replacement session nor its error display.
      if (failure instanceof SessionReplaced) throw failure;
      live.current = null;
      accountTheme.release();
      if (failure instanceof ApiError && failure.status === 401) signedOut();
      else setFrame(old => ({ ...old, state: 'signed-in', confirmed: null, refreshing: false,
        operatorLoading: false, operatorSwitching: false, operatorError: refusal ?? messageOf(failure) }));
      throw failure;
    }
  }, [owns, signedOut]);

  const refreshSession = useCallback(async () => { await readCanonical(begin()); }, [begin, readCanonical]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      const refusal = handoffArrival ? await handoffArrival : null;
      if (cancelled) return;
      if (refusal) setFrame(old => ({ ...old, handoffError: refusal }));
      await refreshSession().catch(() => { /* The current frame already contains the refusal. */ });
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
      epoch.current++;
      live.current = null;
      busy.current = null;
      accountTheme.release();
    };
  }, [refreshSession]);

  useEffect(() => {
    const onLocked = () => { void refreshSession().catch(() => {}); };
    window.addEventListener('oto:unauthorized', signedOut);
    window.addEventListener('oto:session-locked', onLocked);
    return () => {
      window.removeEventListener('oto:unauthorized', signedOut);
      window.removeEventListener('oto:session-locked', onLocked);
    };
  }, [refreshSession, signedOut]);

  const signIn = useCallback(async (phone: string, password: string) => {
    const request = begin(false, 'signed-out');
    setFrame(old => ({ ...old, handoffError: null }));
    try {
      await authApi.signIn(phone, password);
      if (!owns(request)) return;
      setFrame(old => ({ ...old, state: 'loading' }));
      await readCanonical(request);
    } catch (failure) {
      if (owns(request) && live.current === null) setFrame(old => ({ ...old, refreshing: false }));
      throw failure;
    }
  }, [begin, owns, readCanonical]);

  const unlock = useCallback(async (password: string) => {
    const request = epoch.current;
    await authApi.unlock(password);
    if (owns(request)) await refreshSession();
  }, [owns, refreshSession]);

  const signOut = useCallback(async () => {
    signedOut();
    await authApi.signOut().catch(() => {});
  }, [signedOut]);

  const changeContext = useCallback(async (expectedEpoch: number, kind: 'operator' | 'branch', id: string) => {
    const before = live.current;
    if (!isCurrentAuthority(expectedEpoch) || !before || before.me.sessionLocked
      || before.me.account.mustChangePassword || !isId(id)) throw new Error('Confirm the current session before switching.');
    if (busy.current) throw new Error('A session switch is already in progress.');
    if (kind === 'operator' && (!canSwitch(before) || frame.operatorLoading || frame.operatorError !== null
      || !frame.operatorChoices.some(p => p.id === id))) throw new Error('This operator is not available to switch.');
    const key = idemKey();
    const request = begin(kind === 'operator');
    const owner = {};
    busy.current = owner;
    let failure: unknown = null;
    try {
      // A bounded retry keeps the exact body, revision and key after a lost acknowledgement.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (kind === 'operator') await authApi.switchOperator(id, before.context.revision, key);
          else await authApi.switchBranch(id, key);
          failure = null;
          break;
        } catch (error) {
          failure = error;
          if (!owns(request)) return;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) break;
        }
      }
      if (!owns(request)) return;
      const refusal = failure === null ? null : messageOf(failure);
      let confirmed: Confirmed | null;
      try {
        confirmed = await readCanonical(request, refusal, {
          accountId: before.me.account.id, sessionId: before.context.sessionId,
        });
      } catch (error) {
        if (!(error instanceof SessionReplaced)) throw error;
        if (owns(request)) await refreshSession();
        return;
      }
      if (!confirmed || !owns(request)) return;
      if (failure !== null) throw failure;
      if ((kind === 'operator' ? confirmed.context.effectiveOperatorId : confirmed.context.branchId) !== id) {
        const message = 'The selected context was not confirmed by the current session.';
        setFrame(old => ({ ...old, operatorError: message }));
        throw new Error(message);
      }
    } finally {
      if (busy.current === owner) busy.current = null;
    }
  }, [begin, frame.operatorChoices, frame.operatorError, frame.operatorLoading,
    isCurrentAuthority, owns, readCanonical, refreshSession]);

  const switchOperator = useCallback((id: string, expectedEpoch: number) =>
    changeContext(expectedEpoch, 'operator', id), [changeContext]);
  const switchBranch = useCallback((branchId: string) =>
    changeContext(frame.epoch, 'branch', branchId), [changeContext, frame.epoch]);

  const value = useMemo<SessionValue>(() => {
    const confirmed = frame.confirmed;
    const permissions = confirmed?.permissions ?? [];
    const held = new Set(permissions.map(p => p.permission));
    return {
      state: frame.state, authorityEpoch: frame.epoch, refreshing: frame.refreshing,
      isCurrentAuthority, me: confirmed?.me ?? null, permissions,
      locked: confirmed?.me.sessionLocked ?? false, handoffError: frame.handoffError,
      has: permission => held.has(permission),
      effectiveOperatorId: confirmed?.context.effectiveOperatorId ?? null,
      operatorContext: confirmed?.context ?? null,
      operatorChoices: frame.operatorChoices, operatorError: frame.operatorError,
      operatorLoading: frame.operatorLoading, operatorSwitching: frame.operatorSwitching,
      refreshSession, switchOperator, signIn, unlock, signOut, switchBranch,
    };
  }, [frame, isCurrentAuthority, refreshSession, switchOperator, signIn, unlock, signOut, switchBranch]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}

/** The name to greet someone by: their own, falling back to the account. */
export function displayName(me: MeResponse | null): string {
  if (!me) return '';
  const full = me.employee?.nickname ?? me.employee?.name;
  if (!full) return me.account.phone;
  return full.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
