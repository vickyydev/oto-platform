import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Operator } from '@/types';
import { INACTIVITY_TIMEOUT_MS, INACTIVITY_WARNING_MS, getOperatorThemePref } from '@/mockApi';
import { useStaffTheme, useCustomerTheme } from '@/lib/themePref';
import { authApi } from '@/api/platform';
import { loadCatalogFromApi } from '@/api/catalogBridge';

/**
 * Operator session — Sprint 1 rebuild: the "operator" (prototype term for the
 * signed-in STAFF member) is now backed by a real API session (phone +
 * password, httpOnly cookie). The inactivity lock keeps the prototype's
 * exact timings (2 min + 15 s warning, mockApi constants); "Scan my face"
 * remains a placeholder for later face auth.
 */
interface OperatorContextValue {
  /** The operator currently logged in, or null when the POS is locked. */
  operator: Operator | null;
  /** Sign in with phone + password against the platform API. */
  signIn: (phone: string, password: string) => Promise<Operator>;
  /** Legacy face-scan entry — kept as a placeholder (throws to the caller). */
  login: () => Operator | null;
  /** Lock the POS immediately, deleting the server-side session. */
  logout: () => void;
  /** True while the pre-logout inactivity warning is showing. */
  warningActive: boolean;
  /** Seconds remaining before auto-logout while the warning is active. */
  secondsLeft: number;
  /** Keep the operator logged in (resets the inactivity timer). */
  stayActive: () => void;
}

const OperatorContext = createContext<OperatorContextValue | null>(null);

// Interactions that count as activity and reset the inactivity timer.
const ACTIVITY_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchstart'] as const;

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
  const [warningActive, setWarningActive] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

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

  const logout = useCallback(() => {
    clearTimers();
    setWarningActive(false);
    setOperator(null);
    void authApi.signOut().catch(() => {
      // Session may already be gone (expiry, deactivation) — locked either way.
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
      setOperator(op);
      applyThemePrefs(op.id);
      return op;
    },
    [applyThemePrefs],
  );

  // Legacy face-scan seam: face auth arrives with the branch agent (M3+).
  const login = useCallback((): Operator | null => null, []);

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

    logoutTimer.current = window.setTimeout(logout, INACTIVITY_TIMEOUT_MS);
  }, [clearTimers, logout]);

  const stayActive = useCallback(() => {
    if (operator) armTimers();
  }, [operator, armTimers]);

  // On mount, resume a still-valid server session (e.g. an accidental reload
  // inside the TTL). Failing quietly keeps the lock screen as the default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
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
        setOperator(op);
        applyThemePrefs(op.id);
      } catch {
        /* not signed in */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyThemePrefs]);

  // While logged in, listen for activity and reset the inactivity timer.
  useEffect(() => {
    if (!operator) {
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
  }, [operator, armTimers, clearTimers]);

  return (
    <OperatorContext.Provider
      value={{ operator, signIn, login, logout, warningActive, secondsLeft, stayActive }}
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
