import { useEffect, useRef, useState } from 'react';
import { formatKioskPairingCode, type KioskState } from '@oto/shared';
import {
  KioskError,
  kioskApi,
  readKioskCredential,
  rememberKioskCredential,
} from '@/api/kiosk';
import {
  KioskAttract,
  KioskResult,
  KioskScan,
  KioskSetup,
  KioskShell,
  KioskWorking,
} from '@/components/kiosk/KioskScreens';
import { useLanguage } from '@/i18n/LanguageContext';
import { DEFAULT_LANG } from '@/i18n/types';
import { useKioskFlow, useKioskPairing } from '@/lib/kiosk';
import { useScannerBurst } from '@/lib/scannerBurst';

/**
 * S2-20 K2 (SCRUM-217) — `/kiosk`, THE SELF-SERVICE KIOSK.
 *
 * Mounted outside every staff provider, as `/display` is: nobody signs in at a
 * kiosk. It pairs itself the way a customer display does (its own secret, a K
 * code a manager types into Console > Devices), then runs the flow in
 * `lib/kiosk.ts` — attract, scan, print, one screen per ending — on K1's
 * redemption, with Q9's 60-second idle timeout.
 *
 * SCANNING. The park's scanner is a USB keyboard to whatever it is plugged
 * into (`lib/scannerBurst.ts`), so a kiosk computer hears it as a fast burst
 * ending in Enter while no field has focus — and the kiosk has no fields. For
 * a rehearsal with no scanner, `#debug` on the address adds a small field that
 * submits a pasted QR exactly as a scan; nothing else changes.
 */

/** How often the paired screen reads its own state — which is also how the Console sees it up. */
const STATE_POLL_MS = 15_000;

export default function Kiosk() {
  const pairing = useKioskPairing({
    api: kioskApi,
    initialBearer: readKioskCredential(),
    remember: rememberKioskCredential,
  });
  const view = pairing.view;

  return (
    <div className="dark h-[100dvh] w-full min-w-0 overflow-hidden bg-background text-foreground flex flex-col" data-testid="kiosk">
      {view.kind === 'paired' ? (
        <KioskSurface
          key={`${pairing.bearer}:${view.stationId}`}
          bearer={pairing.bearer}
          stationId={view.stationId}
          stationName={view.stationName}
          onUnpaired={pairing.reset}
        />
      ) : (
        <KioskSetup
          code={view.kind === 'code' ? formatKioskPairingCode(view.pairingCode) : null}
          expiresAt={view.kind === 'code' ? view.expiresAt : null}
          state={view.kind}
          persistent={pairing.persistent}
          error={pairing.error}
          onExpire={pairing.expire}
          onNewCode={pairing.newCode}
        />
      )}
    </div>
  );
}

function KioskSurface({
  bearer,
  stationId,
  stationName,
  onUnpaired,
}: {
  bearer: string;
  stationId: string;
  stationName: string;
  onUnpaired: () => void;
}) {
  const { setLang } = useLanguage();
  const [state, setState] = useState<KioskState | null>(null);
  const [reachable, setReachable] = useState(true);
  const unpairedRef = useRef(onUnpaired);
  unpairedRef.current = onUnpaired;

  // The screen's own state, polled: which kiosk, Q9's timeout, and whether the park answers at all.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const read = await kioskApi.state(bearer, stationId, controller.signal);
        if (stopped) return;
        setState(read);
        setReachable(true);
      } catch (err) {
        if (stopped) return;
        if (err instanceof KioskError && err.status === 401) {
          unpairedRef.current();
          return;
        }
        // Not reachable at all; a refusal with a reason is still an answer.
        if (err instanceof KioskError && err.status === 0) setReachable(false);
      }
      if (!stopped) timer = setTimeout(() => void tick(), STATE_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [bearer, stationId]);

  const flow = useKioskFlow({
    api: kioskApi,
    bearer,
    stationId,
    ...(state ? { idleTimeoutMs: state.idleTimeoutMs } : {}),
    onUnpaired,
  });
  const stage = flow.stage;

  // A scan is a guest's move wherever the kiosk is, except while a press is printing.
  useScannerBurst(flow.scanned, { enabled: stage.kind !== 'working' });

  // Each guest starts in the park's default language.
  useEffect(() => {
    if (stage.kind === 'attract') setLang(DEFAULT_LANG);
  }, [stage.kind, setLang]);

  const debug = typeof window !== 'undefined' && /(^|[#&])debug\b/.test(window.location.hash);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col" onPointerDown={flow.activity} onKeyDown={flow.activity}>
      <KioskShell
        footer={
          <div className="shrink-0 px-6 pb-3 text-center text-sm text-foreground/40" data-testid="kiosk-station">
            {state?.branchName ? `${state.branchName} · ` : ''}
            {state?.station.name ?? stationName}
          </div>
        }
      >
        {stage.kind === 'attract' ? (
          <KioskAttract resting={!reachable} onStart={flow.begin} />
        ) : stage.kind === 'scan' ? (
          <KioskScan onStartOver={flow.startOver} />
        ) : stage.kind === 'working' ? (
          <KioskWorking />
        ) : (
          <KioskResult screen={stage.screen} onDone={flow.finish} onScanAgain={flow.tryAgain} />
        )}
      </KioskShell>
      {debug && <DebugScan onScan={flow.scanned} />}
    </div>
  );
}

/** `#debug` only: a pasted QR submitted exactly as a scan, for a rehearsal with no scanner. */
function DebugScan({ onScan }: { onScan: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="absolute bottom-2 left-2 z-50 flex gap-2 rounded-lg bg-black/70 p-2 text-xs text-white"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim()) onScan(code.trim());
        setCode('');
      }}
    >
      <label className="flex items-center gap-2">
        <span>Simulated scan</span>
        <input
          className="w-64 rounded bg-white/10 px-2 py-1 font-mono text-white"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="BK1:…"
          autoComplete="off"
          spellCheck={false}
          data-testid="kiosk-debug-scan"
        />
      </label>
      <button type="submit" className="rounded bg-white/20 px-2">
        Scan
      </button>
    </form>
  );
}
