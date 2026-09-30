/**
 * Registering the till's service worker, and deciding when a new build may
 * take over.
 *
 * The worker itself (`apps/pos/pwa/service-worker.js`) explains what it caches
 * and why. This file is the page's half of the same contract: it asks the
 * browser to look for a new worker often enough that a till which is never
 * closed still gets one, holds the new worker in `waiting` until the shell
 * says the moment is safe, and reports a worker that failed to install to the
 * platform instead of leaving a till silently without one.
 *
 * NOTHING HERE RUNS IN DEVELOPMENT except the cleanup at the bottom. The dev
 * server emits no `sw.js`, so registering would 404 on every reload.
 */

/** What the shell can see about the worker. */
export interface ServiceWorkerState {
  /** The browser has service workers at all. False on a very old iPad. */
  supported: boolean;
  /** A worker is registered and controlling, or about to. */
  registered: boolean;
  /** A new build is installed and waiting for permission to take over. */
  updateReady: boolean;
  /** The build id the controlling worker answered with, once it has. */
  buildId: string | null;
}

let state: ServiceWorkerState = {
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  registered: false,
  updateReady: false,
  buildId: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<ServiceWorkerState>): void {
  const next = { ...state, ...patch };
  if (
    next.supported === state.supported &&
    next.registered === state.registered &&
    next.updateReady === state.updateReady &&
    next.buildId === state.buildId
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeServiceWorker(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between changes, which is what `useSyncExternalStore` requires. */
export function getServiceWorkerState(): ServiceWorkerState {
  return state;
}

// ---------------------------------------------------------------------------
// Reporting a worker that did not install
// ---------------------------------------------------------------------------

/**
 * Where a service-worker failure goes (S2-06).
 *
 * There is NO client-telemetry route to send it to. The api answers 404 on
 * `/api/telemetry/client` — `apps/api/src/app.ts` registers nothing under
 * `/telemetry`; its telemetry plugin is request-timing middleware, not a route
 * — and every load that hit a worker failure was making that dead POST. So the
 * failure is written to the console, where a developer at the till can see it,
 * and no request leaves for a route that does not exist. When the api grows one,
 * this is the single place that would send to it.
 */
type FailureEvent =
  /** `navigator.serviceWorker.register()` rejected. */
  | 'register_failed'
  /** A worker was installing and went `redundant` — it will never serve anything. */
  | 'install_failed'
  /** A periodic `registration.update()` threw. */
  | 'update_check_failed';

function reportFailure(event: FailureEvent, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err ?? '');
  // A worker that failed to install leaves the till with no offline shell, so
  // it is worth a line — but only in the console, since there is no route to
  // POST it to. No phone number can reach this message (a worker error string),
  // so the telemetry redactor has nothing to strip.
  console.warn(`[service-worker] ${event}${message ? `: ${message}` : ''}`, {
    buildId: state.buildId,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * How often the page asks the browser to re-check `sw.js`.
 *
 * Fifteen minutes. A till is open twelve hours, so a deploy at lunchtime is on
 * every counter well before close; and the check is one conditional request
 * for a file of a few kilobytes, which costs a mall Wi-Fi nothing. It is also
 * run whenever the tab becomes visible and whenever the network returns, which
 * between them cover the two moments a person actually notices a stale screen.
 */
const UPDATE_CHECK_MS = 15 * 60 * 1000;

let registration: ServiceWorkerRegistration | null = null;
let started = false;
/** True only after the page itself asked the waiting worker to take over. */
let reloadArmed = false;

export function registerServiceWorker(): void {
  if (started) return;
  started = true;

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    setState({ supported: false });
    return;
  }

  if (!import.meta.env.PROD) {
    void clearDevWorkers();
    return;
  }

  const begin = () => {
    void start();
  };
  // Registering competes with the first paint, so it waits for the load event
  // — unless the load event has already been and gone, which it has whenever
  // this module is reached from a lazily evaluated path.
  if (document.readyState === 'complete') begin();
  else window.addEventListener('load', begin, { once: true });
}

async function start(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  try {
    registration = await navigator.serviceWorker.register(`${base}sw.js`, {
      scope: base,
      // Without this the browser may answer the update check out of its own
      // HTTP cache, and a till would go on running a build that was replaced
      // days ago while every check reported no change.
      updateViaCache: 'none',
    });
  } catch (err) {
    reportFailure('register_failed', err);
    return;
  }

  setState({ registered: true });
  watch(registration);
  askBuildId();

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // `clients.claim()` fires this on the FIRST install too, when the page had
    // no controller at all and nothing was replaced. Reloading then would
    // restart a shell somebody had just opened, so only a take-over this page
    // asked for reloads it.
    if (!reloadArmed) {
      askBuildId();
      return;
    }
    reloadArmed = false;
    window.location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      data &&
      typeof data === 'object' &&
      (data as { type?: unknown }).type === 'OTO_VERSION' &&
      typeof (data as { version?: unknown }).version === 'string'
    ) {
      setState({ buildId: (data as { version: string }).version });
    }
  });

  const check = () => {
    registration?.update().catch((err: unknown) => reportFailure('update_check_failed', err));
  };
  window.setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('online', check);
}

function watch(reg: ServiceWorkerRegistration): void {
  if (reg.waiting && navigator.serviceWorker.controller) setState({ updateReady: true });

  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') {
        // With no controller this is the first install on this device: there
        // is nothing to replace and nothing to wait for.
        if (navigator.serviceWorker.controller) setState({ updateReady: true });
      } else if (installing.state === 'redundant') {
        // Installed-then-redundant is normal (it was superseded); going
        // redundant straight from `installing` means the precache failed, and
        // that leaves the till with no offline shell at all.
        reportFailure('install_failed', new Error('service worker became redundant while installing'));
      }
    });
  });
}

function askBuildId(): void {
  navigator.serviceWorker.controller?.postMessage({ type: 'OTO_VERSION' });
}

/**
 * Hand the waiting worker the till, and reload onto it.
 *
 * Callers decide WHEN (see `ServiceWorkerUpdater`); this only refuses when
 * there is nothing waiting.
 */
export function applyServiceWorkerUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) return;
  reloadArmed = true;
  waiting.postMessage({ type: 'OTO_SKIP_WAITING' });
}

/**
 * A development server has no `sw.js`, but a worker registered by an earlier
 * `vite preview` on the same host and port is still controlling this origin
 * and will go on serving its precached shell — so `pnpm dev` would show a
 * build from whenever that preview was made, with no clue why. One unregister
 * and one reload, once.
 */
async function clearDevWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    if (regs.length === 0) return;
    await Promise.all(regs.map((reg) => reg.unregister()));
    if (navigator.serviceWorker.controller) window.location.reload();
  } catch {
    // Nothing to do, and nothing depends on it in development.
  }
}
