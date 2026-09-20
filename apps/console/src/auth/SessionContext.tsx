import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Permission } from '@oto/shared/permissions';
import { authApi, type EffectivePermission, type MeResponse } from '@/api/platform';
import { handoffArrival } from '@/auth/handoff';

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

  const load = useCallback(async () => {
    const account = await authApi.me();
    const { permissions: effective } = await authApi.permissions();
    setMe(account);
    setPermissions(effective);
    setState('signed-in');
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
      try {
        await load();
      } catch {
        if (cancelled) return;
        setMe(null);
        setPermissions([]);
        setState('signed-out');
        if (refusal) setHandoffError(refusal);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // A 401 anywhere means the session is gone — expired, deactivated, or signed
  // out from another app.
  useEffect(() => {
    const onUnauthorized = () => {
      setMe(null);
      setPermissions([]);
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
    setMe(null);
    setPermissions([]);
    setState('signed-out');
    await authApi.signOut().catch(() => {
      // Already gone (expiry, revoked elsewhere) — signed out either way.
    });
  }, []);

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
    };
  }, [state, me, permissions, handoffError, signIn, unlock, signOut]);

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
