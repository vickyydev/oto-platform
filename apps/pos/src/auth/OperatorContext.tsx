import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Permission } from '@oto/shared/permissions';
import { Operator } from '@/types';
import { getOperatorThemePref } from '@/mockApi';
import { INACTIVITY_TIMEOUT_MS, INACTIVITY_WARNING_MS } from '@/auth/timings';
import { useStaffTheme, useCustomerTheme } from '@/lib/themePref';
import { authApi } from '@/api/platform';
import { ApiError } from '@/api/client';
import { loadCatalogFromApi } from '@/api/catalogBridge';

/**
 * Operator session — the "operator" (prototype term for the signed-in STAFF
 * member) is backed by a real API session (phone + password, httpOnly
 * cookie), which the suite launcher can also hand over (S2-02).
 *
 * S2-01a changed what inactivity does. Sprint 1 signed the operator OUT after
 * two minutes, which deleted the server session — so coming back needed the
 * network, and a till on a dropped connection was dead until it returned.
 * Now it LOCKS: the session stays, the same password unlocks it, and Sign out
 * is the only action that ends a session. That distinction is what lets a
 * box unlock a till offline later (S2-06).
 */
interface OperatorContextValue {
  /** The operator currently signed in, or null at the sign-in screen. */
  operator: Operator | null;
  /** True while the session is locked on inactivity — still signed in. */
  locked: boolean;
  /** Sign in with phone + password against the platform API. */
  signIn: (phone: string, password: string) => Promise<Operator>;
  /** Re-enter the password to unlock the SAME session. */
  unlock: (password: string) => Promise<void>;
  /**
   * Whether this account holds a permission anywhere — any branch, any scope.
   * Enough to decide what a screen offers; never enough to decide what may
   * happen, which the API settles against the scope of the thing being touched.
   */
  can: (permission: Permission) => boolean;
  /** Lock now, without waiting for the timer. */
  lockNow: () => void;
  /**
   * Why the launcher's hand-off was refused, when the POS was opened with one
   * and it did not work. Shown on the lock screen: an operator who has just
   * been bounced has to know whether to sign in again or fetch a manager.
   */
  handoffError: string | null;
  /** End the session on the server and return to the sign-in screen. */
  logout: () => void;
  /** True while the pre-logout inactivity warning is showing. */
  warningActive: boolean;
  /** Seconds remaining before auto-logout while the warning is active. */
  secondsLeft: number;
  /** Keep the operator logged in (resets the inactivity timer). */
  stayActive: () => void;
  /**
   * False until the on-mount session resume has finished. Gates (e.g. the
   * admin console) wait for this before deciding between sign-in and content,
   * so a reload inside a valid session doesn't flash the lock screen.
   */
  sessionResolved: boolean;
}

const OperatorContext = createContext<OperatorContextValue | null>(null);

// Interactions that count as activity and reset the inactivity timer.
const ACTIVITY_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchstart'] as const;

/**
 * What each hand-off refusal means for the person standing at the till. The
 * split that matters is between "start again yourself" and "something is
 * wired wrong, tell a manager" — the operator cannot tell those apart from a
 * sign-in form appearing where they expected the till.
 */
const HANDOFF_REFUSALS: Record<string, string> = {
  expired: 'The sign-in from the launcher took too long and expired. Sign in here to open the till.',
  replayed: 'That launcher link had already been used. Sign in here to open the till.',
  revoked: 'The session was signed out before this till opened. Sign in here to start a new one.',
  audience:
    'The launcher sent a sign-in meant for a different app. Sign in here, and tell a manager if it keeps happening.',
  origin:
    'The launcher sent a sign-in meant for a different address. Sign in here, and tell a manager if it keeps happening.',
};

function handoffRefusal(err: unknown): string {
  const fallback = 'The launcher could not open the till for you. Sign in here to continue.';
  if (!(err instanceof ApiError)) return fallback; // offline, or the api is down
  const details = err.details as { reason?: string } | undefined;
  const reason = details?.reason ?? err.code.replace(/^HANDOFF_/, '').toLowerCase();
  return HANDOFF_REFUSALS[reason] ?? fallback;
}

/**
 * Take the launcher's hand-off token out of the URL and spend it, once, as
 * this module loads.
 *
 * The fragment is destroyed before React renders anything: a token left in
 * the address bar is copied, bookmarked and pasted into a chat window long
 * after its sixty seconds are up. Spending it here rather than inside the
 * resume effect also means a provider that mounts twice cannot exchange it
 * twice — the second mount awaits this same promise and sees the same answer.
 *
 * Resolves to null when the session cookie is now set, or to the sentence the
 * lock screen should show.
 */
function acceptHandoffOnArrival(): Promise<string | null> | null {
  const match = /(?:^|&)handoff=([^&]*)/.exec(window.location.hash.slice(1));
  if (!match || !match[1]) return null;
  const raw = match[1];
  // Strip before anything else can fail: a fragment that survives a bad token
  // is still a fragment somebody can copy.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    token = raw; // a JWS needs no escaping; a malformed one is the api's to refuse
  }
  return authApi
    .handoffExchange(token)
    .then(() => null)
    .catch(handoffRefusal);
}

const handoffArrival = acceptHandoffOnArrival();

/** Map the API session to the prototype's Operator shape the whole UI reads. */
function toOperator(me: Awaited<ReturnType<typeof authApi.me>>, isManager: boolean): Operator {
  return {
    id: me.account.id,
    name: me.employee?.name ?? me.account.phone,
    role: isManager ? 'manager' : 'staff',
  };
}

export function OperatorProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [locked, setLocked] = useState(false);
  const [warningActive, setWarningActive] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const [, setStaffTheme] = useStaffTheme();
  const [, setCustomerTheme] = useCustomerTheme();

  const warnTimer = useRef<number | null>(null);
  const logoutTimer = useRef<number | null>(null);
  const countdown = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (warnTimer.current !== null) window.clearTimeout(warnTimer.current);
    if (logoutTimer.current !== null) window.clearTimeout(logoutTimer.current);
    if (countdown.current !== null) window.clearInterval(countdown.current);
    warnTimer.current = null;
    logoutTimer.current = null;
    countdown.current = null;
  }, []);

  const can = useCallback((permission: Permission) => held.has(permission), [held]);

  const logout = useCallback(() => {
    clearTimers();
    setWarningActive(false);
    setLocked(false);
    setOperator(null);
    setHeld(new Set());
    void authApi.signOut().catch(() => {
      // Session may already be gone (expiry, deactivation) — signed out either way.
    });
  }, [clearTimers]);

  /**
   * Inactivity reached, or the operator locked deliberately. The screen locks
   * immediately — before the API call resolves — so a till left alone is
   * never showing customer data while a request is in flight.
   */
  const lockNow = useCallback(() => {
    clearTimers();
    setWarningActive(false);
    setLocked(true);
    void authApi.lock().catch(() => {
      // Offline or already locked: the screen is locked regardless, and the
      // unlock below re-verifies against the server when it answers again.
    });
  }, [clearTimers]);

  const applyThemePrefs = useCallback(
    (operatorId: string) => {
      const savedPref = getOperatorThemePref(operatorId);
      if (savedPref) {
        setStaffTheme(savedPref.staff);
        setCustomerTheme(savedPref.customer);
      } else {
        setStaffTheme('light');
        setCustomerTheme('light');
      }
    },
    [setStaffTheme, setCustomerTheme],
  );

  const signIn = useCallback(
    async (phone: string, password: string): Promise<Operator> => {
      // Signing in by hand answers the hand-off notice, whatever it said.
      setHandoffError(null);
      await authApi.signIn(phone, password);
      const me = await authApi.me();
      const { permissions } = await authApi.permissions();
      // Manager gating mirrors the prototype's role flag: any admin-side
      // permission beyond branch reads marks the operator as manager.
      const isManager = permissions.some(
        (p) => p.permission.startsWith('admin:') && p.permission !== 'admin:branch:read',
      );
      const op = toOperator(me, isManager);
      // Hydrate branches + wired catalog collections from the API before the
      // till renders, so pricing/packages come from the database.
      await loadCatalogFromApi(me.branch?.code).catch(() => {
        // Catalog load failing must not block the lock screen → surfaced by panels.
      });
      setHeld(new Set(permissions.map((p) => p.permission)));
      setOperator(op);
      setLocked(false);
      applyThemePrefs(op.id);
      return op;
    },
    [applyThemePrefs],
  );

  const unlock = useCallback(async (password: string): Promise<void> => {
    await authApi.unlock(password);
    setLocked(false);
  }, []);

  // (Re)arm the inactivity countdown. Called on login and on every interaction.
  const armTimers = useCallback(() => {
    clearTimers();
    setWarningActive(false);

    const warnAfter = Math.max(0, INACTIVITY_TIMEOUT_MS - INACTIVITY_WARNING_MS);
    warnTimer.current = window.setTimeout(() => {
      setWarningActive(true);
      setSecondsLeft(Math.ceil(INACTIVITY_WARNING_MS / 1000));
      countdown.current = window.setInterval(() => {
        setSecondsLeft((s) => (s > 1 ? s - 1 : 0));
      }, 1000);
    }, warnAfter);

    logoutTimer.current = window.setTimeout(lockNow, INACTIVITY_TIMEOUT_MS);
  }, [clearTimers, lockNow]);

  const stayActive = useCallback(() => {
    if (operator && !locked) armTimers();
  }, [operator, locked, armTimers]);

  // On mount, resume a still-valid server session (e.g. an accidental reload
  // inside the TTL). Failing quietly keeps the lock screen as the default.
  //
  // An operator arriving from the launcher carries a hand-off token instead of
  // a cookie, so that exchange has to finish BEFORE /me is asked anything —
  // otherwise the till decides it has no session and shows a sign-in prompt to
  // somebody who has just signed in next door. The token is already spent by
  // the time this runs (see acceptHandoffOnArrival); all that is awaited here
  // is its answer, so there is one /me either way.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const refusal = handoffArrival ? await handoffArrival : null;
      if (cancelled) return;
      try {
        const me = await authApi.me();
        const { permissions } = await authApi.permissions();
        if (cancelled) return;
        const isManager = permissions.some(
          (p) => p.permission.startsWith('admin:') && p.permission !== 'admin:branch:read',
        );
        await loadCatalogFromApi(me.branch?.code).catch(() => {});
        if (cancelled) return;
        const op = toOperator(me, isManager);
        setHeld(new Set(permissions.map((p) => p.permission)));
        setOperator(op);
        // A reload inside a locked session comes back locked.
        setLocked(me.sessionLocked);
        applyThemePrefs(op.id);
      } catch {
        // Not signed in. When a refused hand-off is the reason, the lock
        // screen says so rather than leaving the operator to guess.
        if (!cancelled && refusal) setHandoffError(refusal);
      } finally {
        if (!cancelled) setSessionResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyThemePrefs]);

  // While signed in and unlocked, listen for activity and reset the timer.
  // A locked till must NOT re-arm on touch: tapping the lock screen is not a
  // reason to keep the session alive.
  useEffect(() => {
    if (!operator || locked) {
      clearTimers();
      return;
    }
    armTimers();
    const onActivity = () => armTimers();
    ACTIVITY_EVENTS.forEach((e) =>
      window.addEventListener(e, onActivity, { passive: true })
    );
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      clearTimers();
    };
  }, [operator, locked, armTimers, clearTimers]);

  // Session died server-side (expiry, deactivation, force sign-out, password
  // reset elsewhere): any API 401 returns the POS to the SIGN-IN screen —
  // not the lock screen, because there is no session left to unlock.
  useEffect(() => {
    if (!operator) return;
    const onUnauthorized = () => {
      clearTimers();
      setWarningActive(false);
      setLocked(false);
      setOperator(null);
      setHeld(new Set());
    };
    window.addEventListener('oto:unauthorized', onUnauthorized);
    return () => window.removeEventListener('oto:unauthorized', onUnauthorized);
  }, [operator, clearTimers]);

  // A request refused with 423 means the server considers this session
  // locked (another tab locked it, or the box did). Follow it.
  useEffect(() => {
    if (!operator) return;
    const onLocked = () => setLocked(true);
    window.addEventListener('oto:session-locked', onLocked);
    return () => window.removeEventListener('oto:session-locked', onLocked);
  }, [operator]);

  return (
    <OperatorContext.Provider
      value={{
        operator,
        locked,
        signIn,
        unlock,
        can,
        lockNow,
        handoffError,
        logout,
        warningActive,
        secondsLeft,
        stayActive,
        sessionResolved,
      }}
    >
      {children}
    </OperatorContext.Provider>
  );
}

export function useOperator(): OperatorContextValue {
  const ctx = useContext(OperatorContext);
  if (!ctx) throw new Error('useOperator must be used within an OperatorProvider');
  return ctx;
}
