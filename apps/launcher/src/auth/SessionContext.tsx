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

type SessionState = 'loading' | 'signed-out' | 'signed-in';

interface SessionValue {
  state: SessionState;
  me: MeResponse | null;
  permissions: EffectivePermission[];
  /** The session is alive but locked — by this account's till, or another tab. */
  locked: boolean;
  /** Held at any scope. App access is a yes/no, not a per-branch decision. */
  has: (permission: Permission) => boolean;
  signIn: (phone: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * One platform session, seen from the launcher's own origin.
 *
 * The launcher deliberately has no inactivity timer of its own. The lock is a
 * property of the session row shared by every app, so a launcher left open on
 * a back-office screen would lock the till someone is actively selling on.
 * Locking belongs to the app in front of a person.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [permissions, setPermissions] = useState<EffectivePermission[]>([]);

  const load = useCallback(async () => {
    const account = await authApi.me();
    const { permissions: effective } = await authApi.permissions();
    setMe(account);
    setPermissions(effective);
    setState('signed-in');
  }, []);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch {
      setMe(null);
      setPermissions([]);
      setState('signed-out');
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A 401 anywhere means the session is gone — expired, deactivated, or signed
  // out from another app. Back to the sign-in panel rather than a grid of
  // tiles that all refuse.
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
    const onLocked = () => void refresh();
    window.addEventListener('oto:session-locked', onLocked);
    return () => window.removeEventListener('oto:session-locked', onLocked);
  }, [refresh]);

  const signIn = useCallback(
    async (phone: string, password: string) => {
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
      has: (permission) => held.has(permission),
      signIn,
      unlock,
      signOut,
      refresh,
    };
  }, [state, me, permissions, signIn, unlock, signOut, refresh]);

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
  // The seed carries a desk in the name ("Som (Reception)"); the greeting wants
  // the person, not the desk.
  return full.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
