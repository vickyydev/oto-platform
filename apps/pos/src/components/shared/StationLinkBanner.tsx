import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CloudOff, CloudUpload, ServerOff, WifiOff } from 'lucide-react';
import { ApiError, isMissingRoute } from '@/api/client';
import { bridgeApi } from '@/api/bridge';
import type { BridgeStatus } from '@oto/shared';
import { linkState, stationLinkApi, type LinkState, type StationLink } from '@/station/link';
import { heardFrom } from '@/components/station/boxState';
import { useStation } from '@/station/StationContext';

/**
 * The strip that says when this till is working without the internet.
 *
 * It is the one place the park is told the truth about the link, so it is
 * written to be honest rather than reassuring: each state says what STILL
 * works and what does NOT, in that order, because "we are offline" on its own
 * sends somebody to fetch a manager when the right answer is usually "carry on
 * selling". The thing that has to be said out loud is the member list — a box
 * working alone answers a lookup from the copy it last took, and somebody who
 * registered at another till this morning will not be there.
 *
 * WHERE IT SITS. Under the header, above the low-stock strip, in the same
 * clothes that strip already wears: full width, one line, role="status", the
 * same two tints (destructive and amber-500) the prototype uses for "something
 * is wrong" and "something needs watching". No new colour, no new shape, and
 * nothing moved — a link fault simply outranks a low bottle of syrup, so it
 * goes above it.
 *
 * WHEN IT APPEARS. Only when the platform actually says one of these things.
 * A deployment whose API has no `/me/station/link` yet shows nothing at all,
 * rather than a banner making promises about a box agent that is not running
 * there.
 */
export function StationLinkBanner() {
  const { station, fleetAvailable } = useStation();
  const reading = useStationLink(fleetAvailable && station !== null);
  const state = linkState({ link: reading.link, reachable: reading.reachable });
  const prices = useBoxPrices(state === 'box_alone' ? (station?.stationId ?? null) : null);

  if (state === 'fine' || state === 'unknown') return null;
  return (
    <Banner
      state={state}
      link={reading.link}
      silentForSeconds={reading.silentForSeconds}
      prices={prices}
    />
  );
}

/**
 * How old the prices on the box are, while the till is working from it
 * (offline plan OD-5): read from the box itself through the station bridge,
 * because the platform is exactly what is not answering. Null until the box
 * has answered, or when there is no box to ask.
 */
function useBoxPrices(stationId: string | null): BridgeStatus['catalogue'] | null {
  const [prices, setPrices] = useState<BridgeStatus['catalogue'] | null>(null);
  useEffect(() => {
    setPrices(null);
    if (!stationId) return;
    let stopped = false;
    const read = () => {
      void bridgeApi
        .status(stationId)
        .then((status) => {
          if (!stopped) setPrices(status.catalogue);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 60_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [stationId]);
  return prices;
}

// ---------------------------------------------------------------------------
// Reading the link
// ---------------------------------------------------------------------------

interface LinkReading {
  link: StationLink | null;
  /** False once this till's own calls have stopped being answered at all. */
  reachable: boolean;
  /** How long the platform has been silent, for the banner to say so. */
  silentForSeconds: number | null;
}

/** Twenty seconds while somebody is looking at the screen, nothing while they are not. */
const POLL_MS = 20_000;

/**
 * A deployment without the route still gets asked, at a minute rather than
 * twenty seconds. The 404 is worth the request on its own: an answer of any
 * kind is proof the platform is reachable, which is the half of this banner
 * that works before the S2-05 routes land.
 */
const POLL_MISSING_MS = 60_000;

/**
 * Two misses before the till says it is cut off. One is a dropped request on a
 * mall Wi-Fi, which happens all day and means nothing; two in a row, forty
 * seconds apart, is a link that has actually gone.
 */
const MISSES_BEFORE_CUT_OFF = 2;

function useStationLink(enabled: boolean): LinkReading {
  const [link, setLink] = useState<StationLink | null>(null);
  const [missing, setMissing] = useState(false);
  const [misses, setMisses] = useState(0);
  const [lastAnswerAt, setLastAnswerAt] = useState<number | null>(null);
  // The iPad's own verdict, which it reaches before any request times out.
  const [browserOnline, setBrowserOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const inFlight = useRef(false);

  const read = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const answer = await stationLinkApi.read();
      setLink(answer);
      setMissing(false);
      setMisses(0);
      setLastAnswerAt(Date.now());
    } catch (err) {
      // An ApiError means the platform answered — a 404 for a route this
      // deployment has not got, a 401 the shell is already handling, a 403 for
      // a station this session no longer holds. None of them is a lost link,
      // and treating them as one would put a red strip on a working till.
      if (err instanceof ApiError) {
        if (isMissingRoute(err)) {
          setMissing(true);
          setLink(null);
        }
        setMisses(0);
        setLastAnswerAt(Date.now());
      } else {
        setMisses((n) => n + 1);
      }
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLink(null);
      setMisses(0);
      return;
    }
    void read();
    const every = missing ? POLL_MISSING_MS : POLL_MS;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, every);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    // The browser knows about the Wi-Fi before a request can time out, so a
    // till that has just been carried out of range says so at once — and asks
    // again the moment it is back rather than waiting out the interval.
    const onOnline = () => {
      setBrowserOnline(true);
      void read();
    };
    const onOffline = () => setBrowserOnline(false);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [enabled, read, missing]);

  const reachable = enabled ? browserOnline && misses < MISSES_BEFORE_CUT_OFF : true;
  return {
    link,
    reachable,
    silentForSeconds: lastAnswerAt === null ? null : Math.round((Date.now() - lastAnswerAt) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

/** The two tints the low-stock strip already uses, and no third one. */
const TONES: Record<'bad' | 'watch', string> = {
  bad: 'bg-destructive/15 text-destructive border-destructive/30',
  watch: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
};

interface Wording {
  tone: 'bad' | 'watch';
  icon: ReactNode;
  headline: string;
  /** The facts beside the headline — a box name, a count, an age. */
  detail: string;
  /** What a person can still do. Empty only where the honest answer is nothing. */
  works: string[];
  /** What they cannot, and what to do instead where there is something. */
  broken: string[];
  /** One closing line: what happens next without anybody doing anything. */
  next?: string;
}

function Banner({
  state,
  link,
  silentForSeconds,
  prices,
}: {
  state: Exclude<LinkState, 'fine' | 'unknown'>;
  link: StationLink | null;
  silentForSeconds: number | null;
  prices: BridgeStatus['catalogue'] | null;
}) {
  const [open, setOpen] = useState(false);
  const words = wordingFor(state, link, silentForSeconds, prices);

  return (
    <div className={`shrink-0 border-b ${TONES[words.tone]}`}>
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-6 py-1.5 text-sm font-semibold">
        <span className="shrink-0">{words.icon}</span>
        <span className="shrink-0">{words.headline}</span>
        {words.detail && <span className="min-w-0 truncate font-normal opacity-80">{words.detail}</span>}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto shrink-0 underline underline-offset-4 font-semibold"
        >
          {open ? 'Hide' : 'What still works'}
        </button>
      </div>

      {open && (
        <div className="px-6 pb-2.5 grid gap-x-8 gap-y-2 sm:grid-cols-2 text-sm font-normal">
          <Column title="Still works" lines={words.works} empty="Nothing on this screen." />
          <Column title="Does not work" lines={words.broken} />
          {words.next && <p className="sm:col-span-2 opacity-80">{words.next}</p>}
        </div>
      )}
    </div>
  );
}

function Column({ title, lines, empty }: { title: string; lines: string[]; empty?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-bold uppercase tracking-wide opacity-70">{title}</p>
      {lines.length === 0 ? (
        <p className="mt-1 opacity-80">{empty}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {lines.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="opacity-60">
                ·
              </span>
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How old the box's copy of the members, the prices and today's bookings is. */
function cacheAge(link: StationLink | null): string {
  if (!link) return 'it is holding';
  if (link.cacheAgeSeconds !== null && link.cacheAgeSeconds !== undefined) {
    return `it took ${heardFrom(link.cacheAgeSeconds)}`;
  }
  if (link.cacheAppliedAt) {
    const at = new Date(link.cacheAppliedAt);
    if (!Number.isNaN(at.getTime())) {
      return `it took at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  return 'it is holding';
}

function queued(link: StationLink | null): number {
  return link?.outboxDepth ?? 0;
}

function wordingFor(
  state: Exclude<LinkState, 'fine' | 'unknown'>,
  link: StationLink | null,
  silentForSeconds: number | null,
  prices: BridgeStatus['catalogue'] | null = null,
): Wording {
  // OD-5: prices sell normally for a day after the box last took them, then
  // with this line, and past a week the box stops selling at all.
  const pricesLine =
    prices?.state === 'stale' && prices.ageSeconds !== null
      ? `prices last updated ${heardFrom(prices.ageSeconds)}`
      : prices?.state === 'refused'
        ? 'prices over a week old'
        : '';
  const boxName = link?.boxName ?? 'the box at this counter';
  const waiting = queued(link);
  const waitingLine =
    waiting > 0 ? `${waiting} ${waiting === 1 ? 'thing' : 'things'} waiting to sync` : '';

  switch (state) {
    case 'till_cut_off':
      return {
        tone: 'bad',
        icon: <WifiOff className="w-4 h-4" />,
        headline: 'This screen cannot reach the platform',
        detail:
          silentForSeconds !== null && silentForSeconds > 0
            ? `nothing answered for ${heardFrom(silentForSeconds)}`
            : 'nothing is answering',
        // Said plainly rather than softened. This till is a screen onto the
        // platform; with nothing answering it, what is on it is the last thing
        // it loaded and nothing typed into it is going anywhere.
        works: [],
        broken: [
          'Nothing typed in now is being saved anywhere.',
          'A payment taken on this screen would not be recorded.',
          'What is on screen is whatever it last loaded, however old that is.',
        ],
        next: 'Check this iPad’s Wi-Fi first — the counter’s box may be perfectly fine. The banner clears itself the moment the platform answers again.',
      };

    case 'box_silent':
      return {
        tone: 'bad',
        icon: <ServerOff className="w-4 h-4" />,
        headline: `${boxName} is not answering`,
        detail: link?.boxStatus === 'disabled' ? 'it was taken out of service' : 'it has gone quiet',
        works: [
          'Looking a member up, prices, and everything else this screen reads from the platform.',
        ],
        broken: [
          'Printing. Receipts and bands come off the printers plugged into that box.',
          'Anything else on it — the scanner, the card terminal, the cash drawer.',
        ],
        next: 'Somebody has to look at the box itself; this screen cannot bring it back. Console → Devices shows what it last reported and when.',
      };

    case 'box_alone':
      return {
        tone: 'watch',
        icon: <CloudOff className="w-4 h-4" />,
        headline: 'Working from the box alone — no internet',
        detail: [waitingLine, pricesLine, link?.offlineReason ?? ''].filter(Boolean).join(' · '),
        works: [
          'Finding members, signing a family up, confirming the children, and pricing the order — the box answers, and nothing is lost.',
          'Printing: the printers are plugged into the box, so receipts and bands are unaffected.',
          `Members, prices and today’s bookings, from the copy ${cacheAge(link)}.`,
        ],
        broken: [
          'Taking payment. Keep the order and take payment when the connection is back.',
          ...(prices?.state === 'refused'
            ? ['Pricing: the prices on this box are over a week old. Connect it to the internet once to refresh them.']
            : []),
          'Finding anybody who registered at another till, or online, since that copy was taken. Enter them again here — the two are merged when the box syncs.',
          'Anything rung up here showing in the Console or in a report until the box is back.',
        ],
        next:
          waiting > 0
            ? `Everything rung up now queues on the box — ${waiting} already — and syncs by itself when the link returns.`
            : 'Everything rung up now queues on the box and syncs by itself when the link returns.',
      };

    case 'catching_up':
      return {
        tone: 'watch',
        icon: <CloudUpload className="w-4 h-4" />,
        headline: 'Catching up after being offline',
        detail: [
          waitingLine,
          link?.oldestUnackedSeconds ? `oldest ${heardFrom(link.oldestUnackedSeconds)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        works: ['Everything. The box has the internet back and is sending what it queued.'],
        broken: [
          `Reports and the Console are behind by ${waiting > 0 ? `these ${waiting}` : 'what is still queued'} until it finishes.`,
        ],
        next: 'If the number is not falling, the Console’s Failures page says why.',
      };
  }
}
