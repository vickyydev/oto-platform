import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoothConfigBundle, SpinResponse } from '@oto/shared';
import { booth } from './booth/client';
import { BoothCallError, type BoothStatus } from './booth/contract';
import { readAssetManifest, readColor, readDesign, type WheelDesign } from './booth/design';
import { COPY, type BilingualLine } from './copy';
import { flags, parseHash } from './flags';
import {
  installPressListener,
  isForbiddenButtonKey,
  PRESS_LOCKOUT_MS,
  RESULT_PRESS_LOCKOUT_MS,
} from './press';
import { configureSounds } from './sound';
import { DebugOverlay } from './components/DebugOverlay';
import OtoWordmark from './components/OtoWordmark';
import { ResultModal } from './components/ResultModal';
import { StaffSignIn } from './components/StaffSignIn';
import { Wheel, type WheelSlice } from './components/Wheel';

/**
 * boot     — nothing has answered yet
 * unsynced — no wheel has ever been published to this booth
 * ready    — the attract; a press starts a draw
 * starting — the press is with the booth and the wheel has not moved
 * spinning — the wheel is turning toward a slice already decided
 * result   — the prize card
 */
type Phase = 'boot' | 'unsynced' | 'ready' | 'starting' | 'spinning' | 'result';

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

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot');
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

  const signedIn = status?.staffSignedIn ?? false;

  const recordKey = useCallback((line: string) => {
    setInputLog((current) => [line, ...current].slice(0, INPUT_LOG_MAX));
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
        // has. The corner dot says the link is down; the screen does not.
        if (!cancelled) setLastErrorCode(errorCode(error));
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), CONFIG_POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyConfig, fetchConfig]);

  // The parked bundle goes in the moment the wheel is at rest.
  useEffect(() => {
    if (phase === 'ready' && pendingConfig !== null) applyConfig(pendingConfig);
  }, [phase, pendingConfig, applyConfig]);

  // ---- Status ----------------------------------------------------------

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await booth.getStatus());
    } catch (error) {
      setLastErrorCode(errorCode(error));
      setStatus((current) =>
        current === null ? null : { ...current, online: false, printerReachable: 'unknown' },
      );
    }
  }, []);

  useEffect(() => {
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
  }, [refreshStatus]);

  // ---- The press -------------------------------------------------------

  const design = useMemo<WheelDesign>(() => readDesign(config?.bundle.layout.design), [config]);

  /**
   * The slices, in the bundle's own order and including every prize it
   * carries — `SpinResponse.prizeIndex` indexes this array, and dropping an
   * inactive prize here would shift every index after it.
   */
  const slices = useMemo<WheelSlice[]>(() => {
    if (!config) return [];
    return config.bundle.prizes.map((prize, index) => ({
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
      const stale =
        index !== response.prizeIndex || response.configVersion !== configRef.current?.version;
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
      setLastErrorCode(errorCode(error));
      setNotice(
        error instanceof BoothCallError && error.code === 'not_configured'
          ? COPY.notSetUp
          : COPY.notReady,
      );
      setPhase('ready');
    }
  }, [applyConfig, fetchConfig]);

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

  useEffect(
    () =>
      installPressListener({
        buttonKey,
        lockoutMs: () =>
          phaseRef.current === 'result' ? RESULT_PRESS_LOCKOUT_MS : PRESS_LOCKOUT_MS,
        onPress,
        onKeyRecorded: recordKey,
      }),
    [buttonKey, onPress, recordKey],
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

  const simulateSpin = useCallback(() => booth.spin({ simulate: true }), []);

  // ---- Render ----------------------------------------------------------

  const isSpinning = phase === 'spinning';
  const prize = useMemo(() => {
    if (!spin || !config) return null;
    return config.bundle.prizes.find((candidate) => candidate.id === spin.prizeId) ?? null;
  }, [spin, config]);

  if (phase === 'unsynced') {
    return (
      <div className="k-screen" data-kiosk-surface="1">
        <Ambient />
        <div className="k-body k-body--center">
          <OtoWordmark height={56} />
          <div className="k-setup">
            <p className="k-setup-line">{COPY.notSetUp.en}</p>
            <p className="k-setup-line k-th">{COPY.notSetUp.th}</p>
          </div>
        </div>
        <StatusChip status={status} transport={booth.kind} onOpen={() => setSignInOpen(true)} />
        <StaffSignIn
          open={signInOpen}
          signedIn={signedIn}
          onClose={() => setSignInOpen(false)}
          onChanged={() => void refreshStatus()}
        />
      </div>
    );
  }

  return (
    <div className={'k-screen' + (isSpinning ? ' k-screen--spinning' : '')} data-kiosk-surface="1">
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

      <ResultModal
        spin={spin}
        prize={prize}
        open={phase === 'result'}
        promptText={replayArmed ? COPY.playAgainConfirm.en : COPY.playAgain.en}
        onClose={requestPlayAgain}
      />

      <StatusChip status={status} transport={booth.kind} onOpen={() => setSignInOpen(true)} />

      <StaffSignIn
        open={signInOpen}
        signedIn={signedIn}
        onClose={() => setSignInOpen(false)}
        onChanged={() => void refreshStatus()}
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
 * What the pill under the wheel says.
 *
 * "Staff: sign in to start" is a prompt to whoever is looking after the booth,
 * not a lock on the game: the wheel still spins with nobody signed in and the
 * spin is recorded unattributed. A booth that stopped playing whenever
 * reception got busy is a booth nobody plays.
 */
function promptFor(phase: Phase, notice: BilingualLine | null, signedIn: boolean): BilingualLine {
  if (notice !== null) return notice;
  if (phase === 'boot' || phase === 'starting') return COPY.starting;
  if (phase === 'spinning') return COPY.spinning;
  if (!signedIn) return COPY.staffSignInPrompt;
  return COPY.pressToSpin;
}

/**
 * The prize this page would draw for what the box says was won, or null when
 * it holds no such prize.
 *
 * The published index is trusted only when the id under it agrees; otherwise
 * the id is looked up, because the id is the identity and the index is a slot.
 */
function resolveIndex(config: AppliedConfig | null, response: SpinResponse): number | null {
  const prizes = config?.bundle.prizes ?? [];
  if (prizes[response.prizeIndex]?.id === response.prizeId) return response.prizeIndex;
  const found = prizes.findIndex((prize) => prize.id === response.prizeId);
  return found >= 0 ? found : null;
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
