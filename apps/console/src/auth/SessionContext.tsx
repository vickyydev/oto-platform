import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Permission } from '@oto/shared/permissions';
import { readUiPreferences } from '@oto/shared/ui-preferences';
import { authApi, type EffectivePermission, type MeResponse } from '@/api/platform';
import { ApiError, idemKey } from '@/api/client';
import { handoffArrival } from '@/auth/handoff';
import { accountTheme } from '@/lib/theme';

type SessionState = 'loading' | 'signed-out' | 'signed-in';

interface SessionValue {
  state: SessionState;
  me: MeResponse | null;
  permissions: EffectivePermission[];
  /** The session is alive but locked — by this account's till, or another tab. */
  locked: boolean;
  /** Why the launcher's hand-off was refused, when one was carried and failed. */
  handoffError: string | null;
  /** Held at any scope. Reading the platform's own state is not per-branch. */
  has: (permission: Permission) => boolean;
  signIn: (phone: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  switchBranch: (branchId: string) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * One platform session, seen from the console's own origin.
 *
 * Like the launcher, the console has no inactivity timer of its own: the lock
 * is a property of the session row every app shares, so a console left open on
 * a back-office screen would lock the till someone is actively selling on.
 * Locking belongs to the app in front of a person.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [permissions, setPermissions] = useState<EffectivePermission[]>([]);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const sessionRequest = useRef(0);
  const branchSwitching = useRef(false);

  const load = useCallback(async () => {
    const request = ++sessionRequest.current;
    try {
      const account = await authApi.me();
      if (request !== sessionRequest.current) return null;
      const { permissions: effective } = await authApi.permissions();
      // A sign-out, expiry or newer read may have replaced this session while
      // either request was pending. Its old account must not bind writes again.
      if (request !== sessionRequest.current) return null;
      setMe(account);
      setPermissions(effective);
      accountTheme.adopt(readUiPreferences(account));
      setHandoffError(null);
      setState('signed-in');
      return account;
    } catch (error) {
      if (request !== sessionRequest.current) return null;
      accountTheme.release();
      throw error;
    }
  }, []);

  // On mount, resume a still-valid session. Someone arriving from the launcher
  // carries a hand-off token instead of a cookie, so that exchange has to
  // finish BEFORE /me is asked anything — otherwise the console decides it has
  // no session and shows a sign-in prompt to somebody who has just signed in
  // next door. The token is already spent by the time this runs (see
  // auth/handoff.ts); all that is awaited here is its answer.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const refusal = handoffArrival ? await handoffArrival : null;
      if (cancelled) return;
      if (refusal) setHandoffError(refusal);
      try {
        await load();
      } catch {
        if (cancelled) return;
        setMe(null);
        setPermissions([]);
        setState('signed-out');
      }
    })();
    return () => {
      cancelled = true;
      sessionRequest.current++;
      accountTheme.release();
    };
  }, [load]);

  // A 401 anywhere means the session is gone — expired, deactivated, or signed
  // out from another app.
  useEffect(() => {
    const onUnauthorized = () => {
      sessionRequest.current++;
      setMe(null);
      setPermissions([]);
      accountTheme.release();
      setState('signed-out');
    };
    window.addEventListener('oto:unauthorized', onUnauthorized);
    return () => window.removeEventListener('oto:unauthorized', onUnauthorized);
  }, []);

  // A 423 means the shared session was locked elsewhere. Re-read /me, which is
  // exempt from the lock, so the page shows the locked panel instead of an
  // error nobody can act on.
  useEffect(() => {
    const onLocked = () => {
      void load().catch(() => {
        setMe(null);
        setPermissions([]);
        setState('signed-out');
      });
    };
    window.addEventListener('oto:session-locked', onLocked);
    return () => window.removeEventListener('oto:session-locked', onLocked);
  }, [load]);

  const signIn = useCallback(
    async (phone: string, password: string) => {
      setHandoffError(null);
      await authApi.signIn(phone, password);
      await load();
    },
    [load],
  );

  const unlock = useCallback(
    async (password: string) => {
      await authApi.unlock(password);
      await load();
    },
    [load],
  );

  const signOut = useCallback(async () => {
    sessionRequest.current++;
    setMe(null);
    setPermissions([]);
    accountTheme.release();
    setState('signed-out');
    await authApi.signOut().catch(() => {
      // Already gone (expiry, revoked elsewhere) — signed out either way.
    });
  }, []);

  // A retained callback from an earlier account must never seat the new one.
  // Capture the render's epoch, then re-check it after each awaited request.
  const sessionEpoch = sessionRequest.current;
  const switchBranch = useCallback(async (branchId: string) => {
    if (sessionEpoch !== sessionRequest.current || state !== 'signed-in' || !me || me.sessionLocked) {
      throw new Error('Sign in again before switching branch.');
    }
    if (branchSwitching.current) throw new Error('A branch switch is already in progress.');
    branchSwitching.current = true;
    try {
      try {
        await authApi.switchBranch(branchId, idemKey());
      } catch (failure) {
        // A lost response or server error may follow a committed switch.
        // An explicit client refusal keeps its native error and current seat.
        const refused = failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
        if (!refused && sessionEpoch === sessionRequest.current) {
          sessionRequest.current++;
          setMe(null);
          setPermissions([]);
          accountTheme.release();
          setState('signed-out');
        }
        throw failure;
      }
      if (sessionEpoch !== sessionRequest.current) throw new Error('The signed-in account changed.');
      // The write may have moved the server session. Until its canonical read
      // finishes, the previous branch must offer no active-branch controls.
      setMe(null);
      setPermissions([]);
      setState('loading');
      const confirmationEpoch = sessionEpoch + 1;
      try {
        const current = await load();
        if (!current || current.branch?.id !== branchId) throw new Error('The selected branch could not be confirmed.');
      } catch (failure) {
        if (sessionRequest.current === confirmationEpoch) {
          sessionRequest.current++;
          setMe(null);
          setPermissions([]);
          accountTheme.release();
          setState('signed-out');
        }
        throw failure;
      }
    } finally {
      branchSwitching.current = false;
    }
  }, [load, me, sessionEpoch, state]);

  const value = useMemo<SessionValue>(() => {
    const held = new Set(permissions.map((p) => p.permission));
    return {
      state,
      me,
      permissions,
      locked: me?.sessionLocked ?? false,
      handoffError,
      has: (permission) => held.has(permission),
      signIn,
      unlock,
      signOut,
      switchBranch,
    };
  }, [state, me, permissions, handoffError, signIn, unlock, signOut, switchBranch]);

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
  // The seed carries a desk in the name ("Som (Reception)"); a header wants the
  // person, not the desk.
  return full.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
