import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from '@/api/client';
import { inboxApi, type InboxMe } from '@/api/inbox';
import { handoffArrival } from '@/auth/handoff';

/**
 * Where the session stands, read off ONE call: `GET /inbox/me`. It is the
 * Inbox's identity (plan §3.3), and the api's session guard answers it with
 * everything else the shell needs to know — 401 no session, 423 locked by
 * another app, 403 `MUST_CHANGE_PASSWORD` or a missing `app:inbox:access`.
 * So, unlike the Console, the Inbox does not read `/me` at all.
 */
export type SessionState = 'loading' | 'signed-out' | 'locked' | 'must-change-password' | 'no-access' | 'ready';

interface SessionValue {
  state: SessionState;
  me: InboxMe | null;
  /** Why the launcher's hand-off was refused, when one was carried and failed. */
  handoffError: string | null;
  signIn: (phone: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

/** What a refused `/inbox/me` means for the shell. */
export function stateForRefusal(err: unknown): SessionState {
  if (!(err instanceof ApiError)) return 'signed-out';
  if (err.status === 423) return 'locked';
  if (err.status === 403 && err.code === 'MUST_CHANGE_PASSWORD') return 'must-change-password';
  if (err.status === 403) return 'no-access';
  return 'signed-out';
}

/**
 * One platform session, seen from the Inbox's own origin.
 *
 * Like the Console and the launcher, the Inbox has no inactivity timer of its
 * own: the lock is a property of the session row every app shares, so an
 * inbox left open on a desk would lock the till someone is selling on.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>('loading');
  const [me, setMe] = useState<InboxMe | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await inboxApi.me();
      setMe(next);
      setState('ready');
    } catch (err) {
      setMe(null);
      setState(stateForRefusal(err));
      throw err;
    }
  }, []);

  // Someone arriving from the launcher carries a hand-off token instead of a
  // cookie, so that exchange finishes BEFORE the api is asked anything —
  // otherwise the Inbox decides there is no session and shows a sign-in form
  // to somebody who has just signed in next door.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const refusal = handoffArrival ? await handoffArrival : null;
      if (cancelled) return;
      try {
        await load();
      } catch {
        if (!cancelled && refusal) setHandoffError(refusal);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // A 401 anywhere: the session is gone. A 423: locked elsewhere — re-read,
  // which lands on the locked panel.
  useEffect(() => {
    const onUnauthorized = () => {
      setMe(null);
      setState('signed-out');
    };
    const onLocked = () => void load().catch(() => undefined);
    window.addEventListener('oto:unauthorized', onUnauthorized);
    window.addEventListener('oto:session-locked', onLocked);
    return () => {
      window.removeEventListener('oto:unauthorized', onUnauthorized);
      window.removeEventListener('oto:session-locked', onLocked);
    };
  }, [load]);

  const signIn = useCallback(
    async (phone: string, password: string) => {
      setHandoffError(null);
      await api.post('/auth/sign-in', { phone, password });
      await load().catch(() => undefined);
    },
    [load],
  );

  const unlock = useCallback(
    async (password: string) => {
      await api.post('/auth/unlock', { password });
      await load().catch(() => undefined);
    },
    [load],
  );

  // Signing out returns to the launcher (plan §4.2): the Inbox is one tile of
  // the suite, and its own sign-in form is only for an address opened cold.
  const signOut = useCallback(async () => {
    await api.post('/auth/sign-out').catch(() => {
      // Already gone (expiry, revoked elsewhere): signed out either way.
    });
    setMe(null);
    setState('signed-out');
    if (LAUNCHER_URL) window.location.assign(LAUNCHER_URL);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ state, me, handoffError, signIn, unlock, signOut }),
    [state, me, handoffError, signIn, unlock, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
