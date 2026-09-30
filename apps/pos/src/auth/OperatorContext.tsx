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
import { bridgeApi, setBridgeStaffName } from '@/api/bridge';
import { forgetStaffToken, readStaffToken, staffTokenLive } from '@/auth/staffToken';
import { currentLane, isBoxLaneTrigger, laneStation, noteLaneFailure } from '@/lib/lane';
import { loadCatalogFromApi } from '@/api/catalogBridge';
import { takeTicketDisplayLeaseForSignOut } from '@/lib/displaySession';

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
   * This account is on a temporary password (SCRUM-235). The API refuses every
   * guarded route with MUST_CHANGE_PASSWORD until it is replaced, so the till
   * has nothing to show but the form that replaces it.
   */
  mustChangePassword: boolean;
  /**
   * Replace the password and re-hydrate the session. Resolves once the till is
   * open for business, so the caller can stop showing the form.
   */
  changePassword: (current: string, next: string) => Promise<void>;
  /**
   * Set when the last unlock was decided by the BOX rather than the platform
   * (S2-06): which rule allowed it, and how old the copy of the staff list
   * was. Null on an ordinary unlock, and cleared on the next online one.
   */
  offlineUnlock: { method: string; cacheAgeSeconds: number | null } | null;
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
  // Who a receipt printed by the box lane names (offline plan Round 4): a
  // till's box holds no staff names, and the till knows who is standing at it.
  useEffect(() => {
    setBridgeStaffName(operator?.name ?? null);
  }, [operator?.name]);
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [locked, setLocked] = useState(false);
  const [offlineUnlock, setOfflineUnlock] = useState<
    { method: string; cacheAgeSeconds: number | null } | null
  >(null);
  const [warningActive, setWarningActive] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  const [, setStaffTheme] = useStaffTheme();
  const [, setCustomerTheme] = useCustomerTheme();

  const warnTimer = useRef<number | null>(null);
  const logoutTimer = useRef<number | null>(null);
  const countdown = useRef<number | null>(null);
  const pendingSignOut = useRef<Promise<void> | null>(null);

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
    // Suspend before clearing React state; the server releases this
    // browser's own lease while its session still exists, even when locked.
    const displayLease = takeTicketDisplayLeaseForSignOut();
    clearTimers();
    setWarningActive(false);
    setLocked(false);
    setOperator(null);
    setHeld(new Set());
    setMustChangePassword(false);
    setOfflineUnlock(null);
    /**
     * And the shift token (S2-06). The server revokes it too — that is what
     * puts it on every box's deny-list — but this device must not keep a
     * credential for a shift that has ended, whether or not the sign-out
     * request below ever reaches anybody.
     */
    forgetStaffToken();
    // The box session ends with the shift (offline plan Round 3).
    const station = laneStation();
    if (station) void bridgeApi.lock(station);
    if (!pendingSignOut.current) {
      const ending = displayLease.then((stationLeaseId) => authApi.signOut(stationLeaseId)).then(() => undefined).catch(() => {
        // Session may already be gone (expiry, deactivation) — signed out either way.
      });
      pendingSignOut.current = ending;
      void ending.finally(() => {
        if (pendingSignOut.current === ending) pendingSignOut.current = null;
      });
    }
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
    // A box session ends at lock (offline plan §2.2): the next unlock proves
    // the password again, at whichever door answers.
    const station = laneStation();
    if (station) void bridgeApi.lock(station);
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

  /**
   * Read who this session is and what it may do, and put it into state.
   *
   * Shared by sign-in, the on-mount resume and the forced password change
   * (SCRUM-235), because all three have to leave the till in the same
   * condition — and a temp-password account reaches two of them. `/me` and
   * `/me/permissions` are the routes the API exempts from the
   * MUST_CHANGE_PASSWORD refusal, so they answer for such an account; the
   * catalog load does not, which is why its failure has never been fatal here.
   */
  const hydrate = useCallback(async (): Promise<{ operator: Operator; sessionLocked: boolean }> => {
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
    setMustChangePassword(me.account.mustChangePassword);
    setOperator(op);
    applyThemePrefs(op.id);
    return { operator: op, sessionLocked: me.sessionLocked };
  }, [applyThemePrefs]);

  const signIn = useCallback(
    async (phone: string, password: string): Promise<Operator> => {
      // A delayed sign-out clears its cookie. Let it finish before issuing a
      // new one, so its response cannot erase the next staff session.
      await pendingSignOut.current;
      // Signing in by hand answers the hand-off notice, whatever it said.
      setHandoffError(null);
      await authApi.signIn(phone, password);
      const { operator: op } = await hydrate();
      setLocked(false);
      return op;
    },
    [hydrate],
  );

  /**
   * Replace a temporary password from inside the till (SCRUM-235).
   *
   * `POST /auth/change-password` is on the API's exempt list, so it is
   * reachable by exactly the account that is otherwise refused everywhere.
   * Re-hydrating afterwards is what clears `mustChangePassword` and lets the
   * station picker open — the flag is the account's, so it is re-read from the
   * server rather than assumed from a 200.
   */
  const changePassword = useCallback(
    async (current: string, next: string): Promise<void> => {
      await authApi.changePassword(current, next);
      await hydrate();
    },
    [hydrate],
  );

  /**
   * Unlock, with the box as the fallback (S2-06; the station bridge since
   * offline plan Round 3).
   *
   * The platform is asked first, because its answer is the true one: it checks
   * the password against the account as it stands this second. Only when
   * NOTHING answered — a `NetworkError`, which is the client's word for a
   * request that never reached a server, as distinct from one that was refused
   * — or the platform said the station is forced offline, does the till turn
   * to the box it is standing on, through the station bridge
   * (`POST /box/v1/station/:id/unlock`), which verifies the shift token and
   * the password against the copy it took while it still had the internet.
   * A till already on the box lane goes to the box first. The cloud's
   * `/auth/unlock-offline` is asked only by a till with no station to reach.
   *
   * The order matters and is not interchangeable. Asking the box first would
   * mean an account deactivated this morning could still unlock a till that
   * has perfectly good internet, because the box's copy is older than the
   * decision. A refusal from the platform is therefore final and is never
   * retried against the cache.
   *
   * **Where this runs today.** On staging the box is virtual and its bridge
   * is the api's own mount, so the box path runs when the Console forces the
   * station offline (`apps/api/test/offline-capability.test.ts`). A browser
   * that cannot reach the api at all reaches its box only when the box is a
   * Pi on the counter's own network — the bench step of plan §4, round 5.
   */
  const unlock = useCallback(async (password: string): Promise<void> => {
    const held = readStaffToken();
    const token = staffTokenLive(held) ? (held?.token ?? null) : null;
    const station = laneStation();
    const throughBox = async (stationId: string): Promise<void> => {
      const answer = await bridgeApi.unlock(stationId, {
        password,
        ...(token ? { token } : {}),
        ...(operator?.id ? { accountId: operator.id } : {}),
      });
      setOfflineUnlock({ method: answer.method, cacheAgeSeconds: answer.cacheAgeSeconds });
      setLocked(false);
    };
    if (station && currentLane() === 'box') return throughBox(station);
    try {
      await authApi.unlock(password);
      setOfflineUnlock(null);
      setLocked(false);
      return;
    } catch (err) {
      if (!isBoxLaneTrigger(err)) throw err;
      noteLaneFailure(err);
    }
    if (station) return throughBox(station);
    const answer = await authApi.unlockOffline(token, password);
    // What the banner says afterwards: this unlock was allowed by a copy of
    // the staff list of a known age, not by the platform.
    setOfflineUnlock({ method: answer.authMethod, cacheAgeSeconds: answer.cacheAgeSeconds });
    setLocked(false);
  }, [operator?.id]);

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
        const { sessionLocked } = await hydrate();
        if (cancelled) return;
        // A reload inside a locked session comes back locked.
        setLocked(sessionLocked);
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
  }, [hydrate]);

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
      setMustChangePassword(false);
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
        mustChangePassword,
        changePassword,
        signIn,
        unlock,
        offlineUnlock,
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
