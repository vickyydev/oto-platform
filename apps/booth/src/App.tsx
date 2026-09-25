import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BoothConfigBundle, SpinResponse } from '@oto/shared';
import { booth, boothCredential } from './booth/client';
import { BoothCallError, type BoothStatus } from './booth/contract';
import { readAssetManifest, readColor, readDesign, type WheelDesign } from './booth/design';
import { boothHost } from './booth/host';
import { kiosk, type KioskState } from './booth/kiosk';
import { sliceIndexFor, visiblePrizes } from './booth/wheel-view';
import { COPY, noWheelScreen, refusalLine, type BilingualLine } from './copy';
import { flags, parseHash } from './flags';
import {
  installPressListener,
  isForbiddenButtonKey,
  PRESS_LOCKOUT_MS,
  RESULT_PRESS_LOCKOUT_MS,
} from './press';
import { configureSounds } from './sound';
import { isPerfLite } from './stageState';
import { DebugOverlay } from './components/DebugOverlay';
import { BoothPicker, ClaimScreen, KioskStarting, NoBoothScreen } from './components/KioskScreens';
import OtoWordmark from './components/OtoWordmark';
import { PairScreen } from './components/PairScreen';
import { ResultModal } from './components/ResultModal';
import { StaffSignIn } from './components/StaffSignIn';
import { Wheel, type WheelSlice } from './components/Wheel';

/**
 * boot     — nothing has answered yet
 * unpaired — no staff member has paired this screen to a booth (SCRUM-244)
 * unsynced — the box has no wheel for this booth: none has been published to
 *            it, or the box has never been able to fetch one
 * ready    — the attract; a press starts a draw
 * starting — the press is with the booth and the wheel has not moved
 * spinning — the wheel is turning toward a slice already decided
 * result   — the prize card
 *
 * `unpaired` and `unsynced` are deliberately different states and look
 * different on the television. "Nobody has given this screen a credential" is
 * fixed by a member of staff standing at the booth with a code; "nobody has
 * published a wheel to this booth" is fixed in the Console and then by the box
 * pulling it. Collapsing them would send whoever is on shift to the wrong
 * place.
 */
type Phase = 'boot' | 'unpaired' | 'unsynced' | 'ready' | 'starting' | 'spinning' | 'result';

interface AppliedConfig {
  version: number;
  bundle: BoothConfigBundle;
}

/** How often the corner of the screen and the diagnostics are refreshed. */
const STATUS_POLL_MS = 5000;
/** How often a newer published wheel is looked for. */
const CONFIG_POLL_MS = 30_000;
/** Nobody at the prize card for this long and the next player starts fresh. */
const IDLE_RESULT_MS = 60_000;
/** The second press of the double-press must land inside this window. */
const REPLAY_DOUBLE_MS = 1500;
/**
 * The beat between the wheel stopping and the prize card, long enough for the
 * winning slice to blink under the pointer so a child sees what they won on
 * the wheel before the card covers it.
 */
const REVEAL_DELAY_MS = 950;
/** A refusal stays under the wheel this long, then the attract takes over again. */
const NOTICE_MS = 6000;
/** Key events kept for the `#debug` input line. */
const INPUT_LOG_MAX = 8;
/** How often a booth box is asked whether it is claimed and which booth it runs. */
const KIOSK_POLL_MS = 5000;
/** How long "staff are signing in" stays over the wheel after a press the form took. */
const HOLD_NOTICE_MS = 4000;

/**
 * Noto Sans Thai from Google Fonts: the face most text styles on this page
 * name right after the park's brand faces, which the page does not carry
 * (D23). Google serves it with Latin letters as well as Thai, so where it
 * loads it draws the English on the television too, not only the Thai.
 *
 * **Asked for from here, once the page has loaded — never from index.html.**
 * A stylesheet written into the page's `<head>` holds back the page's own
 * script until it arrives. While Google did not answer — a browser with no
 * fresh copy of this sheet, on a network that drops traffic to Google rather
 * than refusing it — the television stayed white and the button did nothing
 * until the request gave up: 21 to 30 seconds where it was measured, and
 * about two minutes on a Pi by estimate. A stylesheet added by script holds
 * back nothing: the page is drawn and playing first, and the face swaps in if
 * and when Google answers. Until then, and for good on a booth that never
 * reaches Google, Thai is drawn in 'Booth Thai' (src/kiosk.css) — the same
 * face, built into the page — and English in the device's own sans-serif.
 */
const GOOGLE_FONT_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap';

function requestGoogleFont(): void {
  if (document.querySelector('link[data-booth-google-font]') !== null) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = GOOGLE_FONT_STYLESHEET;
  link.setAttribute('data-booth-google-font', '1');
  document.head.appendChild(link);
}

/**
 * A page served by a booth box starts with the box's own questions: is it
 * claimed, and which booth is it? Only once both are answered is there a
 * wheel to show (SCRUM-223). A page on the staging site never asks — its
 * first screen is "pair this screen", as before.
 */
const IN_BOX = boothHost === 'box';

type KioskGate = 'starting' | 'claim' | 'nobooth' | 'pick' | null;

function kioskGate(state: KioskState | null, choosing: boolean): KioskGate {
  if (!IN_BOX) return null;
  if (state === null) return 'starting';
  if (!state.registered) return 'claim';
  if (state.booths.length === 0) return 'nobooth';
  if (choosing && state.booths.length > 1) return 'pick';
  if (state.selectedStationId === null) return 'pick';
  return null;
}

export default function App() {
  /**
   * A screen that has never been paired opens on the pairing prompt rather
   * than on `boot` (SCRUM-244).
   *
   * Asked at mount and not on a timer: whether this browser holds a credential
   * is a fact about this browser, and every LATER change of it — a revoke, an
   * expiry, a secret that was never valid — arrives as a 401 from a call and
   * is handled by `noteError` below. The fake transport needs none of this and
   * is never sent here, which is what keeps `pnpm dev` a playable wheel.
   */
  const [phase, setPhase] = useState<Phase>(() =>
    !IN_BOX && booth.kind === 'http' && !boothCredential.has() ? 'unpaired' : 'boot',
  );
  const [kioskState, setKioskState] = useState<KioskState | null>(null);
  /** Staff pressed "Change booth": show the picker even though one is chosen. */
  const [choosingBooth, setChoosingBooth] = useState(false);
  const gate = kioskGate(kioskState, choosingBooth);
  /** Which booth the wheel below belongs to; a change starts the wheel again. */
  const boothKey = IN_BOX ? (kioskState?.selectedStationId ?? 'none') : 'paired';
  const wheelLive = gate === null;
  /** A digit typed with the panel shut opens it, and is the PIN's first digit. */
  const [signInSeed, setSignInSeed] = useState<string | null>(null);
  const [config, setConfig] = useState<AppliedConfig | null>(null);
  const [status, setStatus] = useState<BoothStatus | null>(null);
  const [spin, setSpin] = useState<SpinResponse | null>(null);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<BilingualLine | null>(null);
  const [replayArmed, setReplayArmed] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugRequested, setDebugRequested] = useState(flags.debug);
  const [mismatches, setMismatches] = useState(0);
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  const [inputLog, setInputLog] = useState<string[]>([]);
  const [idleKick, setIdleKick] = useState(0);
  /** A press arrived while the staff form had the keyboard (see `onPressWhileTyping`). */
  const [holdNotice, setHoldNotice] = useState(0);

  /**
   * A newer wheel, fetched but not yet shown.
   *
   * D22: configuration is applied in `ready` and nowhere else. A bundle picked
   * up while the wheel is turning would change the slice array under a running
   * animation — the wheel jumps to a new angle mid-spin and lands on the wrong
   * thing — and one picked up while the prize card is open would redraw the
   * wheel behind a guest who is still reading their code.
   */
  const [pendingConfig, setPendingConfig] = useState<AppliedConfig | null>(null);

  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const configRef = useRef<AppliedConfig | null>(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  /** Whether the box has the internet, for the words a refused press gets. */
  const onlineRef = useRef<boolean | null>(null);
  useEffect(() => {
    onlineRef.current = status?.online ?? null;
  }, [status]);

  /**
   * The gate screen on the television, read by the press handler.
   *
   * A layout effect rather than a plain one, so the handler never reads the
   * screen before last: it is set before the browser paints the picker, not
   * after, and a press that lands on a picker already drawn finds it here.
   */
  const gateRef = useRef<KioskGate>(gate);
  useLayoutEffect(() => {
    gateRef.current = gate;
  }, [gate]);

  // The Google stylesheet, once the page has loaded (see GOOGLE_FONT_STYLESHEET).
  useEffect(() => {
    if (document.readyState === 'complete') {
      requestGoogleFont();
      return;
    }
    window.addEventListener('load', requestGoogleFont, { once: true });
    return () => window.removeEventListener('load', requestGoogleFont);
  }, []);

  const signedIn = status?.staffSignedIn ?? false;

  // ---- The booth box's own questions (SCRUM-223) -------------------------

  const refreshKiosk = useCallback(async () => {
    if (!IN_BOX) return;
    try {
      setKioskState(await kiosk.state());
    } catch {
      // The box is starting, or restarting: keep the last answer and ask again.
    }
  }, []);

  useEffect(() => {
    if (!IN_BOX) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      await refreshKiosk();
      if (!cancelled) timer = window.setTimeout(() => void tick(), KIOSK_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshKiosk]);

  // Another booth is another wheel: nothing of the last one carries over.
  const lastBoothKey = useRef(boothKey);
  useEffect(() => {
    if (lastBoothKey.current === boothKey) return;
    lastBoothKey.current = boothKey;
    setConfig(null);
    setPendingConfig(null);
    setSpin(null);
    setTargetIndex(null);
    setStatus(null);
    setPhase('boot');
  }, [boothKey]);

  const recordKey = useCallback((line: string) => {
    setInputLog((current) => [line, ...current].slice(0, INPUT_LOG_MAX));
  }, []);

  /**
   * Every failed call comes through here, and one of them changes the screen.
   *
   * A 401 means this screen is not paired any more — unpaired from the
   * Console, or holding a credential that was never good — and the client has
   * already dropped the stored secret by the time this runs. The booth then
   * shows the pairing prompt instead of a wheel nobody can spin, which is the
   * only state a member of staff can act on. Every other failure is recorded
   * for `#debug` and leaves the screen alone: a booth that cannot reach its
   * service keeps showing the wheel it has, and the corner dot says the link
   * is down.
   */
  const noteError = useCallback((error: unknown): void => {
    setLastErrorCode(errorCode(error));
    if (error instanceof BoothCallError && error.code === 'unpaired') setPhase('unpaired');
  }, []);

  // ---- Configuration ---------------------------------------------------

  const applyConfig = useCallback((next: AppliedConfig | null) => {
    setConfig(next);
    setPendingConfig(null);
    if (next) {
      configureSounds(readAssetManifest(next.bundle.layout.assetManifest));
      setPhase((current) => (current === 'boot' || current === 'unsynced' ? 'ready' : current));
    } else {
      setPhase('unsynced');
    }
  }, []);

  /**
   * Fetch the published wheel and hand it back.
   *
   * Applying it is the caller's decision, because the two callers differ: the
   * poll parks a newer version until the wheel is at rest, while the press
   * path applies one immediately — and can, because at that moment the wheel
   * is not turning. "Only in `ready`" is a rule about a running animation, and
   * between a press and the first degree of movement there is none.
   */
  const fetchConfig = useCallback(async (): Promise<AppliedConfig | null> => {
    const response = await booth.getConfig();
    if (response.version === null || response.bundle === null) return null;
    return { version: response.version, bundle: response.bundle };
  }, []);

  useEffect(() => {
    // A box that is not claimed, or has not been told its booth, has no wheel
    // to fetch yet; the gate screens ask the box instead.
    if (!wheelLive) return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await fetchConfig();
        if (cancelled) return;
        if (next === null) {
          // Never synced. Not an error, and not the offline dot either: this
          // booth has no wheel at all.
          if (configRef.current === null) applyConfig(null);
        } else if (configRef.current === null) {
          applyConfig(next);
        } else if (next.version !== configRef.current.version) {
          if (phaseRef.current === 'ready') applyConfig(next);
          else setPendingConfig(next);
        }
      } catch (error) {
        // A booth that cannot reach its own service keeps showing the wheel it
        // has. The corner dot says the link is down; the screen does not. A
        // screen that has been unpaired is the exception, and `noteError`
        // knows it.
        if (!cancelled) noteError(error);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), CONFIG_POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyConfig, fetchConfig, noteError, wheelLive, boothKey]);

  // The parked bundle goes in the moment the wheel is at rest.
  useEffect(() => {
    if (phase === 'ready' && pendingConfig !== null) applyConfig(pendingConfig);
  }, [phase, pendingConfig, applyConfig]);

  // ---- Status ----------------------------------------------------------

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await booth.getStatus());
    } catch (error) {
      noteError(error);
      setStatus((current) =>
        current === null ? null : { ...current, online: false, printerReachable: 'unknown' },
      );
    }
  }, [noteError]);

  useEffect(() => {
    if (!wheelLive) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      await refreshStatus();
      if (!cancelled) timer = window.setTimeout(() => void tick(), STATUS_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshStatus, wheelLive, boothKey]);

  // ---- The press -------------------------------------------------------

  const design = useMemo<WheelDesign>(() => readDesign(config?.bundle.layout.design), [config]);

  /**
   * The slices: the prizes switched ON, in the bundle's own order (SCRUM-223).
   *
   * A prize switched off in the Console is "not drawn and not shown". The box
   * never drew one; the wheel used to show one anyway, as a slice nobody could
   * win. It is left off here, which is why the slice to stop on is found by
   * the prize the box names (`sliceIndexFor`) rather than by the bundle
   * position `SpinResponse.prizeIndex` counts.
   */
  const slices = useMemo<WheelSlice[]>(() => {
    if (!config) return [];
    return visiblePrizes(config.bundle).map(({ prize }, index) => ({
      id: prize.id,
      label: trimLabel(prize.wheelLabel ?? prize.nameEn, design.labelMaxLines),
      // A prize's own colours go through the same test as the design's
      // palette. They end up in an SVG attribute that is assigned with
      // `innerHTML`, so a colour is not only a colour — see `readColor`.
      color:
        readColor(prize.sliceColor) ?? design.palette[index % design.palette.length] ?? '#FFE72E',
      textColor: readColor(prize.textColor) ?? design.defaultTextColor,
    }));
  }, [config, design]);

  const replayArmedAt = useRef(0);
  const replayTimer = useRef<number | null>(null);
  const revealTimer = useRef<number | null>(null);

  const goToReady = useCallback(() => {
    if (replayTimer.current !== null) {
      window.clearTimeout(replayTimer.current);
      replayTimer.current = null;
    }
    setSpin(null);
    setTargetIndex(null);
    setReplayArmed(false);
    replayArmedAt.current = 0;
    setPhase('ready');
  }, []);

  const startSpin = useCallback(async () => {
    setNotice(null);
    setPhase('starting');
    try {
      /**
       * One key for this press, reused if the first attempt does not answer.
       *
       * The box records the spin, mints the voucher and queues the print
       * before it replies, so a reply lost to a slow mall connection is a
       * prize that already exists on paper. Without a key the page's next
       * attempt draws again and a second slip comes out; with one, the box
       * recognises the press and returns the spin it already made. A NEW
       * press mints a NEW key, so a guest pressing twice still gets two
       * spins — that is the difference D7 asks for.
       */
      const pressKey = crypto.randomUUID();
      let response: SpinResponse;
      try {
        response = await booth.spin({ idempotencyKey: pressKey });
      } catch (err) {
        // Only a press that went unanswered is retried. A refusal is an
        // answer — retrying "no prizes are eligible" just asks twice.
        if (!(err instanceof BoothCallError) || err.code !== 'unreachable') throw err;
        response = await booth.spin({ idempotencyKey: pressKey });
      }

      // --- The seam this page has to defend from its own side -------------
      // The box drew from the bundle IT has cached; this page drew its slices
      // from the bundle it loaded. One publish between those two moments and
      // index 3 is a different prize on each side: the wheel stops on the
      // bracelet workshop while the printer produces a 200 baht voucher.
      // Nothing throws and no test of either side alone can see it, so the
      // check is here, on the array actually on screen.
      let index = resolveIndex(configRef.current, response);
      const stale = !alignedWith(configRef.current, response);
      if (stale) {
        setMismatches((count) => count + 1);
        // Reload rather than animate. The wheel has not moved yet, so
        // swapping the array now is safe, and the fresh bundle is the one the
        // box drew from.
        const fresh = await fetchConfig();
        if (fresh) {
          applyConfig(fresh);
          index = resolveIndex(fresh, response);
        }
      }

      setSpin(response);
      if (index === null) {
        // The prize is real — it has a code, an expiry, and possibly a slip in
        // the printer — but it is not on the wheel this page can draw. Showing
        // the card without the animation is the only honest option left: the
        // alternative is a guest who won something watching nothing happen.
        setTargetIndex(null);
        setPhase('result');
        return;
      }
      setTargetIndex(index);
      setPhase('spinning');
    } catch (error) {
      noteError(error);
      // An unpaired screen has already been moved to its own state by
      // `noteError`; putting a notice under a wheel it is no longer showing
      // would leave "please call staff" sitting on the pairing prompt.
      if (error instanceof BoothCallError && error.code === 'unpaired') return;
      setNotice(noticeFor(error, onlineRef.current));
      setPhase('ready');
    }
  }, [applyConfig, fetchConfig, noteError]);

  /**
   * One press on the prize card ARMS the restart; a second within the window
   * performs it, so a stray press can never close the card while a parent is
   * still reading the code off it.
   */
  const requestPlayAgain = useCallback(() => {
    const now = Date.now();
    if (replayArmedAt.current > 0 && now - replayArmedAt.current <= REPLAY_DOUBLE_MS) {
      goToReady();
      return;
    }
    replayArmedAt.current = now;
    setReplayArmed(true);
    // This press cancelled the idle auto-return; restart its countdown.
    setIdleKick((k) => k + 1);
    if (replayTimer.current !== null) window.clearTimeout(replayTimer.current);
    replayTimer.current = window.setTimeout(() => {
      replayTimer.current = null;
      replayArmedAt.current = 0;
      setReplayArmed(false);
    }, REPLAY_DOUBLE_MS);
  }, [goToReady]);

  const onPress = useCallback(() => {
    /**
     * Nothing while a gate screen is up — the booth picker above all. "Change
     * booth" opens the picker over a wheel that is still `ready`, and the
     * button used to spin that booth behind it: a slip printed, and choosing
     * a booth then reset the page, so the guest never saw a card for it.
     * Whichever booth is chosen, the next press is that booth's.
     */
    if (gateRef.current !== null) return;
    switch (phaseRef.current) {
      case 'ready':
        void startSpin();
        break;
      case 'result':
        requestPlayAgain();
        break;
      // Nothing during boot, an unconfigured booth, the starting beat or the
      // spin itself. The wheel stops on its own, and a press while it turns
      // does not consume the lockout — so the first "play again" press right
      // after the card appears is never dropped.
      case 'boot':
      case 'unsynced':
      case 'starting':
      case 'spinning':
        break;
    }
  }, [requestPlayAgain, startSpin]);

  /**
   * The key the booth's button sends.
   *
   * Enter is refused here as well as by the column's CHECK and the bundle
   * schema, because this page is the last thing between a badge scan — digits
   * and then Enter — and a spin. A booth configured with it falls back to
   * Space rather than refusing to work.
   */
  const buttonKey = useMemo(() => {
    const configured = config?.bundle.settings.buttonKey;
    if (!configured || isForbiddenButtonKey(configured)) return 'Space';
    return configured;
  }, [config]);

  /**
   * The red button while the staff form has the keyboard: the key is the
   * form's, nothing is drawn, and the wheel says why for a few seconds
   * (`isTypingTarget` in src/press.ts gives the reason it waits rather than
   * spins). Only where a press would otherwise have started a spin.
   */
  const onPressWhileTyping = useCallback(() => {
    if (gateRef.current !== null || phaseRef.current !== 'ready') return;
    setHoldNotice((n) => n + 1);
  }, []);

  useEffect(
    () =>
      installPressListener({
        buttonKey,
        lockoutMs: () =>
          phaseRef.current === 'result' ? RESULT_PRESS_LOCKOUT_MS : PRESS_LOCKOUT_MS,
        onPress,
        onPressWhileTyping,
        onKeyRecorded: recordKey,
      }),
    [buttonKey, onPress, onPressWhileTyping, recordKey],
  );

  // ---- Timers ----------------------------------------------------------

  /**
   * The wheel has stopped. The card is held back for a beat so the winning
   * slice can blink under the pointer first.
   *
   * The timer is held in a ref rather than returned as effect cleanup,
   * because this is a callback the wheel fires, not an effect: nothing would
   * have called a returned function, and the card would have opened over a
   * booth that had already been reset.
   */
  const onSpinEnd = useCallback(() => {
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(() => {
      revealTimer.current = null;
      setPhase('result');
    }, REVEAL_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
      if (replayTimer.current !== null) window.clearTimeout(replayTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (phase !== 'result') return;
    const timer = window.setTimeout(goToReady, IDLE_RESULT_MS);
    return () => window.clearTimeout(timer);
  }, [phase, goToReady, idleKick]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Each press the form took restarts the notice's few seconds; the panel
  // closing ends it at once, since the next press will spin.
  useEffect(() => {
    if (holdNotice === 0) return;
    const timer = window.setTimeout(() => setHoldNotice(0), HOLD_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [holdNotice]);
  useEffect(() => {
    if (!signInOpen) setHoldNotice(0);
  }, [signInOpen]);

  // ---- Staff panels ----------------------------------------------------

  /**
   * `#debug` is the only flag that is re-read while the page is running.
   *
   * The transport and the fake's states are boot decisions and stay frozen at
   * load — re-reading those would let a hash typed mid-shift change what the
   * booth is talking to. Diagnostics are different: a booth television has no
   * address bar, staff reach it with a remote or a phone on the same network,
   * and making them reload the game to look at a printer state would mean
   * losing whatever they were trying to diagnose.
   */
  useEffect(() => {
    const onHashChange = () => setDebugRequested(parseHash(window.location.hash).debug);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Staff-only (D16). Asking for it without a session opens the sign-in panel
  // instead, and the overlay follows as soon as somebody is in.
  useEffect(() => {
    if (!debugRequested) return;
    if (signedIn) setDebugOpen(true);
    else setSignInOpen(true);
  }, [debugRequested, signedIn]);

  /**
   * Closing takes the token out of the URL as well, so the overlay does not
   * come back on the next reload — and an auto-close leaves a booth that has
   * been left alone showing the game, not a table of diagnostics.
   */
  const closeDebug = useCallback(() => {
    setDebugOpen(false);
    setDebugRequested(false);
    try {
      const rest = window.location.hash
        .replace(/^#/, '')
        .split(/[,;&\s]+/)
        .filter((token) => token !== '' && token.toLowerCase() !== 'debug');
      window.history.replaceState(null, '', rest.length > 0 ? `#${rest.join(',')}` : ' ');
    } catch {
      // A booth whose history API refuses still closes its overlay.
    }
  }, []);

  // Signing out closes the diagnostics with the session that opened them.
  useEffect(() => {
    if (!signedIn) setDebugOpen(false);
  }, [signedIn]);

  /**
   * On a booth box, the sign-in panel is the first thing staff see once the
   * wheel is up and nobody is signed in (SCRUM-223) — the Pi booted, the box
   * started, and the person setting it up signs in. Once per wheel: closing
   * it leaves the prompt under the wheel, and the wheel plays unattributed.
   */
  const offeredSignIn = useRef<string | null>(null);
  useEffect(() => {
    if (!IN_BOX || phase !== 'ready' || status === null) return;
    if (offeredSignIn.current === boothKey) return;
    offeredSignIn.current = boothKey;
    if (!status.staffSignedIn) setSignInOpen(true);
  }, [phase, status, boothKey]);

  /**
   * A digit typed with the panel shut opens it — a booth with a small number
   * pad has no pointer to touch the corner with. Signed out, the digit is the
   * first of the PIN; signed in, it only opens the panel, where Tab and Enter
   * reach Reprint, Change booth and Sign out. Never the button's own key, and
   * never while a card or a spin is on.
   */
  useEffect(() => {
    if (signInOpen || gate !== null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!/^[0-9]$/.test(event.key) || event.repeat) return;
      if (event.key === buttonKey || event.code === buttonKey) return;
      if (phaseRef.current !== 'ready' && phaseRef.current !== 'unsynced') return;
      event.preventDefault();
      setSignInSeed(signedIn ? null : event.key);
      setSignInOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [signInOpen, signedIn, gate, buttonKey]);

  const closeSignIn = useCallback(() => {
    setSignInOpen(false);
    setSignInSeed(null);
  }, []);

  const changeBooth =
    IN_BOX && (kioskState?.booths.length ?? 0) > 1 ? () => setChoosingBooth(true) : undefined;

  const simulateSpin = useCallback(() => booth.spin({ simulate: true }), []);

  // ---- Render ----------------------------------------------------------

  const isSpinning = phase === 'spinning';

  /**
   * Television performance mode: the ambient attract animation is dropped so
   * the spin and the reveal get every frame (stageState.isPerfLite — auto on
   * Android and smart-television browsers, `#lite` / `#full` to force it). It
   * is a boot decision, so it is read, not watched.
   */
  const liteClass = isPerfLite() ? ' k-lite' : '';

  const prize = useMemo(() => {
    if (!spin || !config) return null;
    return config.bundle.prizes.find((candidate) => candidate.id === spin.prizeId) ?? null;
  }, [spin, config]);

  // ---- A booth box before it has a wheel (SCRUM-223) ---------------------
  if (gate !== null) {
    const screen =
      gate === 'claim' ? (
        <ClaimScreen onClaimed={() => void refreshKiosk()} />
      ) : gate === 'pick' ? (
        <BoothPicker
          booths={kioskState?.booths ?? []}
          current={kioskState?.selectedStationId ?? null}
          onChosen={() => {
            setChoosingBooth(false);
            void refreshKiosk();
          }}
        />
      ) : gate === 'nobooth' ? (
        <NoBoothScreen />
      ) : (
        <KioskStarting />
      );
    return (
      <div className={'k-screen' + liteClass} data-kiosk-surface="1" data-booth-gate={gate}>
        <Ambient />
        {screen}
      </div>
    );
  }

  if (phase === 'unpaired') {
    /**
     * No staff sign-in panel and no status chip here, deliberately.
     *
     * Both are calls to `/booth/*`, and every one of them is refused until
     * this screen is paired — a chip that could only ever show the offline
     * dot, and a PIN pad that could only ever say "that was not right", are
     * two controls that make a booth look broken in the one state where it is
     * merely new. The pairing panel is the only thing there is to do here.
     */
    return (
      <div className={'k-screen' + liteClass} data-kiosk-surface="1">
        <Ambient />
        <PairScreen
          onPaired={() => {
            // Back to boot rather than straight to ready: the config and
            // status polls are still running, and which screen comes next —
            // a wheel, or the screen for a booth with no wheel yet — is their
            // answer to give rather than this callback's.
            setPhase('boot');
            void refreshStatus();
            // And the wheel now, not at the poll's next tick: the effect's
            // first tick 401'd while the screen was unpaired and its next is
            // CONFIG_POLL_MS away, which left a paired television on an
            // empty wheel reading "Starting…" for up to thirty seconds —
            // long enough for staff to decide the pairing failed.
            void fetchConfig()
              .then((next) => applyConfig(next))
              .catch(noteError);
          }}
        />
      </div>
    );
  }

  if (phase === 'unsynced') {
    /**
     * No wheel yet. What it says depends on whether the box has the internet
     * (`noWheelScreen` in src/copy.ts): offline, connect; online, nobody has
     * published this booth's wheel — the guest is asked to fetch staff, and a
     * panel in the pairing prompt's place tells staff where to publish it.
     */
    const noWheel = noWheelScreen(status?.online ?? null);
    return (
      <div className={'k-screen' + liteClass} data-kiosk-surface="1">
        <Ambient />
        <div className="k-body k-body--center">
          <OtoWordmark height={56} />
          <div className="k-setup">
            <p className="k-setup-line">{noWheel.guest.en}</p>
            <p className="k-setup-line k-th">{noWheel.guest.th}</p>
          </div>
          {noWheel.staff !== null && (
            <div className="k-panel k-panel--center" data-booth-panel="no-wheel">
              <div className="k-panel-head">{noWheel.staff.title}</div>
              <p className="k-panel-line">{noWheel.staff.hint}</p>
            </div>
          )}
        </div>
        <StatusChip status={status} transport={booth.kind} onOpen={() => setSignInOpen(true)} />
        <OnDutyBadge status={status} onOpen={() => setSignInOpen(true)} />
        <StaffSignIn
          open={signInOpen}
          signedIn={signedIn}
          staff={status?.staff ?? null}
          seed={signInSeed}
          onClose={closeSignIn}
          onChanged={() => void refreshStatus()}
          onChangeBooth={changeBooth}
          buttonKey={buttonKey}
        />
      </div>
    );
  }

  return (
    <div
      className={'k-screen' + (isSpinning ? ' k-screen--spinning' : '') + liteClass}
      data-kiosk-surface="1"
    >
      <Ambient />

      <div className="k-body">
        <div className="k-logo-row">
          <OtoWordmark height={48} />
        </div>

        <div className="k-hero">
          <span className="k-badge">
            <span className="k-badge-dot" />
            {COPY.todayOnly.en}
          </span>
          <h1 className="k-title">
            Spin <span className="k-title-amp">&amp;</span> <span className="k-title-win">Win</span>
          </h1>
          <p className="k-sub">{COPY.subtitle.en}</p>
        </div>

        <div className="k-wheelwrap">
          <Wheel
            slices={slices}
            targetIndex={targetIndex}
            onSpinEnd={onSpinEnd}
            isSpinning={isSpinning}
          />
        </div>

        <div>
          <ButtonPrompt
            line={promptFor(phase, notice, signedIn)}
            // The pill only invites a press when a press would do something.
            active={phase === 'ready' && notice === null}
          />
          <p className="k-terms">{COPY.terms.en}</p>
        </div>
      </div>

      {holdNotice > 0 && phase === 'ready' && (
        <div className="k-hold" role="status" aria-live="polite" data-booth-hold="1">
          <p className="k-hold-line">{COPY.staffSigningIn.en}</p>
          <p className="k-hold-line k-th">{COPY.staffSigningIn.th}</p>
        </div>
      )}

      <ResultModal
        spin={spin}
        prize={prize}
        open={phase === 'result'}
        promptText={replayArmed ? COPY.playAgainConfirm.en : COPY.playAgain.en}
        onClose={requestPlayAgain}
      />

      <StatusChip status={status} transport={booth.kind} onOpen={() => setSignInOpen(true)} />
      {/* Not over a prize card: that moment is the guest's. */}
      {phase !== 'result' && <OnDutyBadge status={status} onOpen={() => setSignInOpen(true)} />}

      <StaffSignIn
        open={signInOpen}
        signedIn={signedIn}
        staff={status?.staff ?? null}
        seed={signInSeed}
        onClose={closeSignIn}
        onChanged={() => void refreshStatus()}
        onChangeBooth={changeBooth}
        buttonKey={buttonKey}
      />

      <DebugOverlay
        open={debugOpen && signedIn}
        onClose={closeDebug}
        transport={booth.kind}
        configVersion={config?.version ?? null}
        bundle={config?.bundle ?? null}
        status={status}
        lastSpin={spin}
        mismatches={mismatches}
        lastErrorCode={lastErrorCode}
        inputLog={inputLog}
        simulateSpin={simulateSpin}
      />
    </div>
  );
}

/**
 * The line a refused press puts under the wheel: `refusalLine` in src/copy.ts
 * chooses it from the refusal's code and whether the box has the internet, so
 * the choice can be tested on its own. Anything that is not a `BoothCallError`
 * has no code, and ends on "Booth not ready — please call staff".
 *
 * Nothing here reads the server's prose (D15); the code chooses a line written
 * in the page's own deck.
 */
function noticeFor(error: unknown, online: boolean | null): BilingualLine {
  return refusalLine(error instanceof BoothCallError ? error.code : null, online);
}

/**
 * What the pill under the wheel says.
 *
 * With nobody signed in it prompts whoever is looking after the booth to sign
 * in — for their name on the slip — and is not a lock on the game: the wheel
 * still spins and the spin is recorded unattributed. A booth that stopped
 * playing whenever reception got busy is a booth nobody plays.
 */
function promptFor(phase: Phase, notice: BilingualLine | null, signedIn: boolean): BilingualLine {
  if (notice !== null) return notice;
  if (phase === 'boot' || phase === 'starting') return COPY.starting;
  if (phase === 'spinning') return COPY.spinning;
  if (!signedIn) return COPY.staffSignInPrompt;
  return COPY.pressToSpin;
}

/**
 * The SLICE this page would stop on for what the box says was won, or null
 * when it shows no such prize. Slices are the switched-on prizes only, so
 * this is a position on the wheel and not in the bundle (`wheel-view.ts`).
 */
function resolveIndex(config: AppliedConfig | null, response: SpinResponse): number | null {
  return sliceIndexFor(visiblePrizes(config?.bundle), response);
}

/**
 * Whether this page and the box drew from the same wheel: the same published
 * version, and the prize the box names at the position the box names. Either
 * disagreeing means this page's bundle is stale and is reloaded before the
 * wheel moves.
 */
function alignedWith(config: AppliedConfig | null, response: SpinResponse): boolean {
  if (!config || response.configVersion !== config.version) return false;
  return config.bundle.prizes[response.prizeIndex]?.id === response.prizeId;
}

/**
 * A slice label, cut to the number of lines the design allows.
 *
 * Extra lines are folded into the last one rather than dropped: a label whose
 * second half is missing is a prize with the wrong name on it, which is worse
 * on a wheel than a line that runs small.
 */
function trimLabel(label: string, maxLines: number): string {
  const lines = label.split('\n');
  if (lines.length <= maxLines) return label;
  const kept = lines.slice(0, maxLines - 1);
  kept.push(lines.slice(maxLines - 1).join(' '));
  return kept.join('\n');
}

function errorCode(error: unknown): string {
  if (error instanceof BoothCallError) return error.code ?? `http ${error.status ?? '?'}`;
  return 'unknown';
}

/**
 * The attract.
 *
 * There is no attract video and no separate idle screen: the wheel, its
 * breathing glow, the blinking rim lights and these drifting shapes are the
 * idle state, exactly as in the game this replaces. It runs whether or not
 * anybody is signed in, which is the point — a still screen in a shopping
 * mall reads as broken, and the booth is judged from ten metres away.
 *
 * Every piece is CSS: the outgoing game's decorative blobs were PNGs, and no
 * artwork is copied out of `imports/` (D23).
 */
function Ambient() {
  return (
    <>
      <div className="k-blob k-blob--yellow" aria-hidden />
      <div className="k-blob k-blob--pink" aria-hidden />
      <div className="k-blob k-blob--orange" aria-hidden />
      <div className="k-fs k-fs--1" aria-hidden />
      <div className="k-fs k-fs--2" aria-hidden />
      <div className="k-fs k-fs--3" aria-hidden />
      <div className="k-fs k-fs--4" aria-hidden />
      <div className="k-fs k-fs--5" aria-hidden />
      <div className="k-fs k-fs--6" aria-hidden />
    </>
  );
}

function ButtonPrompt({ line, active }: { line: BilingualLine; active: boolean }) {
  return (
    <div className={active ? 'k-cta k-cta--invite' : 'k-cta k-cta--busy'} aria-live="polite">
      <span className={active ? 'k-cta-label k-cta-label--pulse' : 'k-cta-label'}>
        {/* An on-screen replica of the physical red dome, so a child maps the
            pulsing button on the television to the real one under it. */}
        {active && (
          <span className="k-dome k-dome--pulse" aria-hidden>
            <span className="k-dome-shine" />
          </span>
        )}
        {line.en}
      </span>
      {active && <span className="k-shine" />}
    </div>
  );
}

/**
 * The corner of the screen: the offline dot, and the way staff get in.
 *
 * It is the only control a passer-by can see, and it carries nothing but
 * states — no booth name, no version, no address (D15). Touching it opens the
 * sign-in panel, which is how a booth with no keyboard is attended to.
 */
function StatusChip({
  status,
  transport,
  onOpen,
}: {
  status: BoothStatus | null;
  transport: 'fake' | 'http';
  onOpen: () => void;
}) {
  const offline = status !== null && !status.online;
  const pending = status?.vouchersPending ?? 0;
  return (
    <div className="k-chip" role="presentation" onClick={onOpen} data-booth-chip="1">
      <span className={offline ? 'k-chip-dot k-chip-dot--offline' : 'k-chip-dot'} aria-hidden />
      {offline && pending > 0 && <span className="k-chip-count">{pending}</span>}
      {/* A fake booth says so. It is not a guest-facing state and it is not
          personal data — it is the difference between a wheel that records
          what it gives away and one that records nothing, and nobody should
          have to read a URL to tell them apart. */}
      {transport === 'fake' && <span className="k-chip-demo">demo</span>}
    </div>
  );
}

/**
 * Who is on duty, when somebody is (SCRUM-223): the name and staff code, as
 * a name badge would say. The owner asked for the television to show who is
 * signed in; nothing that signs anybody in is shown. The top corner, because
 * the bottom one is the terms line's and the offline dot's, and a name there
 * ran over the terms; narrow enough to stop short of the logo, with a long
 * name cut rather than run into it. A touch opens the staff panel, like the dot.
 */
function OnDutyBadge({ status, onOpen }: { status: BoothStatus | null; onOpen: () => void }) {
  const staff = status?.staffSignedIn ? status.staff : null;
  const onDuty = staff ? [staff.name, staff.code].filter(Boolean).join(' · ') : '';
  if (onDuty === '') return null;
  return (
    <div className="k-onduty" role="presentation" onClick={onOpen} data-booth-on-duty="1">
      <svg className="k-onduty-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        <circle cx="6" cy="3.5" r="2.5" fill="currentColor" />
        <path d="M1 11.5c0-2.9 2.2-4.8 5-4.8s5 1.9 5 4.8z" fill="currentColor" />
      </svg>
      <span className="k-onduty-name">{onDuty}</span>
    </div>
  );
}
