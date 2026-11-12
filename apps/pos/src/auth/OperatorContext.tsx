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
import { landingUrl, readHandoffTarget } from '@oto/shared/handoff-target';
import { Operator } from '@/types';
import { getOperatorThemePref } from '@/mockApi';
import { INACTIVITY_TIMEOUT_MS, INACTIVITY_WARNING_MS } from '@/auth/timings';
import { staffThemeController, useCustomerTheme } from '@/lib/themePref';
import { useLanguage } from '@/i18n/LanguageContext';
import { authApi, type PosImpersonation } from '@/api/platform';
import { ApiError, NetworkError } from '@/api/client';
import { bridgeApi, holdBoxSession, setBridgeStaffName, prepareConfiguredBridgeUnlock } from '@/api/bridge';
import { forgetStaffToken, readStaffToken, staffTokenLive } from '@/auth/staffToken';
import { currentLane, isBoxLaneTrigger, laneStation, noteLaneFailure, platformNeedsUnlock, platformUnlocked, refreshLane } from '@/lib/lane';
import { loadCatalogFromApi, restorePreparedCatalog } from '@/api/catalogBridge';
import { takeTicketDisplayLeaseForSignOut } from '@/lib/displaySession';
import { branchTradingDate } from '@/lib/pricingMode';
import { saleOpenSince } from '@/pwa/openSale';
import { saleOnScreen } from '@/lib/saleOnScreen';
import { forgetOfflinePreparation, prepareOfflineOperator, readOfflinePreparation, type OfflinePreparation } from './offlinePreparation';
import {
  afterSignIn,
  endedByExpiry,
  sessionDeadline,
  type KeptSaleOffer,
  type KeptTill,
  type SessionEnded,
} from './sessionEnd';

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
  /** SCRUM-648 — this session is a support administrator's view-as window (banner data), or null. */
  viewAs: PosImpersonation | null;
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
  /** A prepared device resumed locked during an outage; the box must still authenticate it. */
  offlinePreparation: OfflinePreparation | null;
  /**
   * SCRUM-878 — the session ended on the platform (its twelve hours ran out,
   * or it was ended from elsewhere), not by Sign out here. The till stays
   * locked over the screen it was on, and the lock screen is the sign-in form
   * with one line saying what happened (`auth/sessionEnd.ts`).
   */
  sessionEnded: SessionEnded | null;
  /** SCRUM-878 — a different person signed in over a kept sale: continue it or discard it. */
  keptOffer: KeptSaleOffer | null;
  continueKept: () => void;
  discardKept: () => void;
  /**
   * SCRUM-878 — which selling screen this is (`App.tsx` keys the till by it).
   * A new session that carries on the screen under the lock keeps it; any
   * other sign-in starts a fresh one.
   */
  tillSeat: string | null;
  /** SCRUM-878 — counts new sessions that carry on the screen: the station is taken again for each. */
  reseat: number;
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
 * The fragment may also carry a target (`&to=/history?phone=…`, SCRUM-591 P1;
 * the assistant's "Take me there" to a member's sales, test night
 * 2026-10-21 W5): after a SUCCESSFUL exchange the address becomes that page,
 * before the router reads it, so the till opens there. The target is checked
 * again here (`readHandoffTarget`, the Console's and the Inbox's rule); a
 * refused one, or a refused exchange, leaves the till at its home.
 *
 * Resolves to null when the session cookie is now set, or to the sentence the
 * lock screen should show.
 */
function acceptHandoffOnArrival(): Promise<string | null> | null {
  const hash = window.location.hash;
  const match = /(?:^|&)handoff=([^&]*)/.exec(hash.slice(1));
  if (!match || !match[1]) return null;
  const raw = match[1];
  const target = readHandoffTarget(hash);
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
    .then(() => {
      if (target) {
        try {
          window.history.replaceState(null, '', landingUrl(import.meta.env.BASE_URL, target));
        } catch {
          // Home is where it would have opened before P1.
        }
      }
      return null;
    })
    .catch(handoffRefusal);
}

const handoffArrival = acceptHandoffOnArrival();

/**
 * SCRUM-744 — the API's refusal of a LOCKED session (423 SESSION_LOCKED), as
 * the station provider reads it (`StationContext`).
 *
 * `/me` and `/me/permissions` answer a locked session; the park list and the
 * catalogue do not. A page reloaded at the lock screen therefore resumed with
 * its catalogue refused, kept the POS's built-in sample park, tickets and
 * prices, and never asked again, because an unlock changes nothing that
 * would. The refusal is "not yet", and the whole session is read again at the
 * unlock (`readAgainAtUnlock` below).
 */
const refusedWhileLocked = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 423 && err.code === 'SESSION_LOCKED';

/**
 * SCRUM-878 — the platform's "there is no session here" (401 UNAUTHORIZED,
 * "Not signed in"), as distinct from a wrong password (401
 * INVALID_CREDENTIALS) on a session that is still there.
 */
const sessionGone = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401 && err.code === 'UNAUTHORIZED';

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
  const [viewAs, setViewAs] = useState<PosImpersonation | null>(null);
  const [offlinePreparation, setOfflinePreparation] = useState<OfflinePreparation | null>(null);
  // SCRUM-878 — a session ended on the platform, and the screen it left (`auth/sessionEnd.ts`).
  const [sessionEnded, setSessionEnded] = useState<SessionEnded | null>(null);
  const [keptOffer, setKeptOffer] = useState<KeptSaleOffer | null>(null);
  const [tillSeat, setTillSeatState] = useState<string | null>(null);
  const [reseat, setReseat] = useState(0);
  const operatorRef = useRef(operator);
  operatorRef.current = operator;
  const viewAsRef = useRef(viewAs);
  viewAsRef.current = viewAs;
  const preparedRef = useRef(offlinePreparation);
  preparedRef.current = offlinePreparation;
  const mustChangeRef = useRef(mustChangePassword);
  mustChangeRef.current = mustChangePassword;
  /** When this session ends on this device's clock, and its whole life in hours (`GET /me`). */
  const sessionEnds = useRef<{ deadline: number | null; afterHours: number | null }>({ deadline: null, afterHours: null });
  /** The operator and park this session sits at (`GET /me`). */
  const sessionPlace = useRef<{ operatorId: string | null; branchId: string | null }>({ operatorId: null, branchId: null });
  /** The screen an ended session left under the lock: memory only, nothing that signs anybody in. */
  const keptTill = useRef<KeptTill | null>(null);
  /** When this device last signed in: a refusal of a request sent before it is the old session's. */
  const signedInAt = useRef(0);
  const seatSerial = useRef(0);
  const tillSeatRef = useRef<string | null>(null);
  const setTillSeat = useCallback((seat: string | null) => {
    tillSeatRef.current = seat;
    setTillSeatState(seat);
  }, []);
  const freshSeat = useCallback((accountId: string) => {
    seatSerial.current += 1;
    setTillSeat(`${accountId}#${seatSerial.current}`);
  }, [setTillSeat]);

  const [, setCustomerTheme] = useCustomerTheme();
  const { setLang } = useLanguage();

  const warnTimer = useRef<number | null>(null);
  const logoutTimer = useRef<number | null>(null);
  const countdown = useRef<number | null>(null);
  const pendingSignOut = useRef<Promise<void> | null>(null);
  /**
   * The last session read had its catalogue refused by the lock (SCRUM-744),
   * so the next platform unlock reads the whole session again. Set by each
   * read; a lock in the middle of a shift read everything before it locked,
   * so its unlock reads nothing and the sale under the lock is left alone.
   */
  const readAgainAtUnlock = useRef(false);

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
    setViewAs(null);
    setOfflineUnlock(null);
    setOfflinePreparation(null);
    forgetOfflinePreparation();
    // SCRUM-878 — signing out on purpose keeps no sale for anybody: the next
    // person starts a fresh till, and nothing of this one is offered to them.
    keptTill.current = null;
    setSessionEnded(null);
    setKeptOffer(null);
    setTillSeat(null);
    // The next person's theme arrives with their sign-in; nothing is written
    // to this one's account after the shift ends.
    staffThemeController.release();
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
  }, [clearTimers, setTillSeat]);

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

  /**
   * SCRUM-878 — the platform says this session is gone: its twelve hours ran
   * out (the moment `GET /me` gave), or it was ended from elsewhere.
   *
   * Not a sign-out. The person is no longer signed in — nothing they may do is
   * kept (`held`), and the lock screen becomes the sign-in form with one line
   * saying what happened — but the screen they were on stays under the lock,
   * rendering nothing, exactly as a staff lock keeps it, so the next sign-in
   * on this till can carry on with it (`signIn`, `auth/sessionEnd.ts`).
   *
   * A support administrator's view-as window, an account still owing a
   * password change and a device resumed offline had no selling screen to
   * keep: those go back to the sign-in form as before.
   */
  const endSession = useCallback(() => {
    const op = operatorRef.current;
    // Said once: the minute's heartbeat keeps being refused while nobody is signed in.
    if (!op || keptTill.current) return;
    // Read before anything below moves state.
    const nothingToKeep = Boolean(viewAsRef.current || mustChangeRef.current || preparedRef.current);
    clearTimers();
    // The box session ends with the platform's, as at a lock (offline plan
    // §2.2): the operator and the station stay on screen, so nothing else
    // would drop the ended person's box bearer. The next box action asks the
    // person now signed in for their password, at the box's own door.
    const station = laneStation();
    if (station) void bridgeApi.lock(station);
    setOfflineUnlock(null);
    setOfflinePreparation(null);
    forgetOfflinePreparation();
    setWarningActive(false);
    setHeld(new Set());
    setMustChangePassword(false);
    setViewAs(null);
    setKeptOffer(null);
    if (nothingToKeep) {
      keptTill.current = null;
      setSessionEnded(null);
      setTillSeat(null);
      setLocked(false);
      setOperator(null);
      return;
    }
    const now = Date.now();
    const saleSince = saleOpenSince();
    // Rung up (Pay pressed, not yet closed): a QR or card payment may be
    // waiting on the customer display, so the next person is told so.
    const rungUpSaleId = saleSince !== null && station ? saleOnScreen(station) : null;
    keptTill.current = {
      accountId: op.id,
      name: op.name,
      operatorId: sessionPlace.current.operatorId,
      branchId: sessionPlace.current.branchId,
      stationId: station,
      tradingDate: branchTradingDate(new Date(now)),
      saleSince,
      endedAt: now,
      ...(rungUpSaleId ? { rungUpSaleId } : {}),
    };
    setSessionEnded({
      name: op.name,
      expired: endedByExpiry(sessionEnds.current.deadline, now),
      afterHours: sessionEnds.current.afterHours,
      saleKept: saleSince !== null,
    });
    setLocked(true);
  }, [clearTimers, setTillSeat]);

  const applyThemePrefs = useCallback(
    (operatorId: string, me: Awaited<ReturnType<typeof authApi.me>>) => {
      // SCRUM-653 — the staff theme is the person's own, from their account;
      // the display's stays this device's, remembered per operator in memory.
      staffThemeController.adopt(me.preferences);
      setCustomerTheme(getOperatorThemePref(operatorId)?.customer ?? 'light');
      // The staff-side language starts at the account's. Customer-facing
      // screens with their own provider (/display, /kiosk) keep their own.
      if (me.preferences) setLang(me.preferences.language);
    },
    [setCustomerTheme, setLang],
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
  const hydrate = useCallback(async (): Promise<{
    operator: Operator;
    sessionLocked: boolean;
    held: ReadonlySet<string>;
    mustChangePassword: boolean;
  }> => {
    const me = await authApi.me();
    // SCRUM-878 — when this session ends, counted from this answer, and where it sits.
    sessionEnds.current = {
      deadline: sessionDeadline(me.sessionEnd, Date.now()),
      afterHours: me.sessionEnd?.afterHours ?? null,
    };
    sessionPlace.current = { operatorId: me.account.operatorId, branchId: me.branch?.id ?? null };
    const { permissions } = await authApi.permissions();
    // Manager gating mirrors the prototype's role flag: any admin-side
    // permission beyond branch reads marks the operator as manager.
    const isManager = permissions.some(
      (p) => p.permission.startsWith('admin:') && p.permission !== 'admin:branch:read',
    );
    const op = toOperator(me, isManager);
    // Hydrate branches + wired catalog collections from the API before the
    // till renders, so pricing/packages come from the database.
    let catalogReady = true;
    let catalogNotYet = false;
    await loadCatalogFromApi(me.branch?.code).catch((err: unknown) => {
      catalogReady = false;
      // Catalog load failing must not block the lock screen → surfaced by panels.
      // A locked session's refusal is no answer at all: read again at the unlock.
      catalogNotYet = refusedWhileLocked(err);
    });
    readAgainAtUnlock.current = catalogNotYet;
    const held = new Set(permissions.map((p) => p.permission));
    setHeld(held);
    setMustChangePassword(me.account.mustChangePassword);
    setViewAs(me.impersonation ?? null);
    setOfflineUnlock(null);
    setOfflinePreparation(null);
    prepareOfflineOperator(op, catalogReady && !me.account.mustChangePassword && !me.impersonation);
    setOperator(op);
    // SCRUM-878 — the same session keeps its screen; a sign-in decides for itself.
    if (tillSeatRef.current === null) freshSeat(op.id);
    applyThemePrefs(op.id, me);
    return { operator: op, sessionLocked: me.sessionLocked, held, mustChangePassword: me.account.mustChangePassword };
  }, [applyThemePrefs, freshSeat]);

  const signIn = useCallback(
    async (phone: string, password: string): Promise<Operator> => {
      // A delayed sign-out clears its cookie. Let it finish before issuing a
      // new one, so its response cannot erase the next staff session.
      await pendingSignOut.current;
      // Signing in by hand answers the hand-off notice, whatever it said.
      setHandoffError(null);
      await authApi.signIn(phone, password);
      signedInAt.current = Date.now();
      // The screen a session left under the lock, if any: `hydrate` gives a
      // fresh one only when there is none.
      const screenBefore = tillSeatRef.current;
      const { operator: op, held, mustChangePassword: owesPasswordChange } = await hydrate();
      /**
       * SCRUM-878 — the screen an ended session left under the lock. The same
       * person carries on with it; a different person who may sell is asked
       * first, and the till stays locked over it until they answer; anyone
       * else, or another park, operator or trading day, starts fresh.
       */
      const ended = keptTill.current;
      keptTill.current = null;
      if (owesPasswordChange) {
        // A temporary password (issuing one ends every session, which is how
        // this till got here) opens the change-password form and nothing else:
        // the platform refuses the station and the sale until it is replaced.
        // As `endSession` rules, an account owing a change has no selling
        // screen to keep, so the sign-in is a fresh one: no offer, and no
        // station taken again for a screen that is not carried on.
        setSessionEnded(null);
        setKeptOffer(null);
        if (screenBefore !== null) freshSeat(op.id);
        setLocked(false);
        return op;
      }
      // A screen left since (another page opened from the sign-in form) holds no sale any more.
      const kept = ended && ended.saleSince !== null && saleOpenSince() === null ? { ...ended, saleSince: null } : ended;
      setSessionEnded(null);
      const outcome = afterSignIn(kept, {
        accountId: op.id,
        operatorId: sessionPlace.current.operatorId,
        branchId: sessionPlace.current.branchId,
        tradingDate: branchTradingDate(),
        maySell: held.has('pos:sale:create'),
      });
      if (outcome === 'offer' && kept && kept.saleSince !== null) {
        setKeptOffer({
          startedBy: kept.name, startedAt: kept.saleSince, endedAt: kept.endedAt, stationId: kept.stationId,
          ...(kept.rungUpSaleId ? { rungUpSaleId: kept.rungUpSaleId } : {}),
        });
        setReseat((n) => n + 1);
        return op;
      }
      setKeptOffer(null);
      if (outcome === 'continue') setReseat((n) => n + 1);
      else if (screenBefore !== null) freshSeat(op.id);
      setLocked(false);
      return op;
    },
    [hydrate, freshSeat],
  );

  /** SCRUM-878 — the person now signed in carries on the kept sale: it is theirs from the next press. */
  const continueKept = useCallback(() => {
    setKeptOffer(null);
    setLocked(false);
  }, []);

  /** SCRUM-878 — the kept sale is dropped from this till: a fresh screen for the person signed in. */
  const discardKept = useCallback(() => {
    const op = operatorRef.current;
    setKeptOffer(null);
    if (op) freshSeat(op.id);
    else setTillSeat(null);
    setLocked(false);
  }, [freshSeat, setTillSeat]);

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
   * A till already on the box lane goes to the box first. Without a prepared
   * station, an outage cannot be recovered by calling another cloud route.
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
    // Recovery can arrive between the periodic probes. Check both routes now
    // so one password submission unlocks a returned, still-locked platform.
    // The shared probe is bounded; an outage or forced-offline box stays local.
    if (station && currentLane() === 'box') await refreshLane();
    const connectLocal = station && token ? prepareConfiguredBridgeUnlock(station, { token, password }) : null;
    const throughBox = async (stationId: string): Promise<void> => {
      const answer = await bridgeApi.unlock(stationId, {
        password,
        ...(token ? { token } : {}),
        ...(operator?.id ? { accountId: operator.id } : {}),
      });
      if (answer.accountId !== operator?.id) {
        holdBoxSession(null);
        throw new Error('That unlock belongs to another operator. Sign in again.');
      }
      if (answer.permissions) setHeld(new Set(answer.permissions));
      setMustChangePassword(answer.mustChangePassword);
      setOfflineUnlock({ method: answer.method, cacheAgeSeconds: answer.cacheAgeSeconds });
      setLocked(false);
    };
    if (station && currentLane() === 'box' && !platformNeedsUnlock()) return throughBox(station);
    try {
      await authApi.unlock(password);
      platformUnlocked();
      // The platform remains the online authority. Its successful unlock also
      // supplies the existing password/token proof to a configured local box;
      // this bounded call neither delays online access nor stores the password.
      void connectLocal?.();
      if (currentLane() === 'box') await refreshLane();
      if (offlinePreparation || readAgainAtUnlock.current) {
        // A cold offline page began with no platform permissions or selected
        // shift. Restore those from the authenticated API before resuming.
        // So did a page reloaded at the lock screen, whose park list and
        // catalogue the lock refused (SCRUM-744): read before the till opens,
        // so it opens on the real park and never on the sample one.
        const resumed = await hydrate();
        setLocked(resumed.sessionLocked);
        return;
      }
      setOfflineUnlock(null);
      setLocked(false);
      return;
    } catch (err) {
      // SCRUM-878 — no session behind this lock any more (its twelve hours ran
      // out before the heartbeat said so): not "Not signed in" under a line
      // saying the person still is, but the sign-in form saying it has ended.
      // A wrong password is INVALID_CREDENTIALS and is still said as before.
      if (sessionGone(err)) {
        endSession();
        return;
      }
      if (!isBoxLaneTrigger(err) || !station) throw err;
      noteLaneFailure(err);
    }
    return throughBox(station!);
  }, [operator?.id, offlinePreparation, hydrate, endSession]);

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
      } catch (error) {
        // Not signed in. When a refused hand-off is the reason, the lock
        // screen says so rather than leaving the operator to guess.
        if (cancelled) return;
        if (refusal) setHandoffError(refusal);
        else if (error instanceof NetworkError || (error instanceof ApiError
          && error.status === 502 && error.code === 'UPSTREAM_UNAVAILABLE')) {
          const saved = readOfflinePreparation();
          if (saved) {
            restorePreparedCatalog(saved.catalog);
            setOfflinePreparation(saved);
            setHeld(new Set());
            setLocked(true);
            setOperator(saved.operator);
            freshSeat(saved.operator.id);
          }
        } else {
          // An authoritative refusal cannot be turned into an offline session.
          forgetOfflinePreparation();
        }
      } finally {
        if (!cancelled) setSessionResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrate, freshSeat]);

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
  // SCRUM-878 — with the screen it was on kept under it (`endSession`).
  useEffect(() => {
    if (!operator) return;
    const onUnauthorized = (event: Event) => {
      // A heartbeat sent with no session just before the sign-in answers
      // after it: that refusal is the old session's, not the new one's.
      const sentAt = (event as CustomEvent<{ sentAt?: unknown } | null>).detail?.sentAt;
      if (typeof sentAt === 'number' && sentAt < signedInAt.current) return;
      endSession();
    };
    window.addEventListener('oto:unauthorized', onUnauthorized);
    return () => window.removeEventListener('oto:unauthorized', onUnauthorized);
  }, [operator, endSession]);

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
        viewAs,
        secondsLeft,
        stayActive,
        sessionResolved,
        offlinePreparation,
        sessionEnded,
        keptOffer,
        continueKept,
        discardKept,
        tillSeat,
        reseat,
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
