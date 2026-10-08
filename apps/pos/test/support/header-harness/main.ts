import { createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StationHeader } from '@/components/shared/StationHeader';
import { MobileShell } from '@/components/mobile/MobileShell';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ApiStationPrinter } from '@/api/platform';
import { setActiveBranch, upsertBranch } from '@/store/catalogStore';
import { HARNESS_BRANCHES } from './contexts';
import { readHeader } from './measure';
import '@/fonts.css';
import '@/index.css';

/**
 * SCRUM-505 — the page the header measurement test drives (see
 * `test/scrum-505-header-widths.test.ts`, which serves it). It renders what
 * `App` renders for a signed-in till at the viewport's width: the station
 * header from 768px (`useIsMobile`'s hand-over), the phone shell below it.
 *
 * The platform's answers are given here rather than fetched, so the header
 * draws what a live till draws without a server behind it. With no query
 * string it is staging's own header (a park whose gate has never reported,
 * so the occupancy chip says "no gate"); the query string picks a variant:
 * `gate=live` or `gate=stale` for the occupancy chip, `pricing=holiday` for
 * the longest pricing chip, `printer=bad` or `printer=low` for the printer
 * chip, `operator=`, `park=` and `station=` for the names drawn, `cash=no` for
 * an account without the Cash action, `parks=one` for a single-park account.
 * Open it by hand with `startHeaderHarness()` (`server.ts`) to look at one.
 */
const params = new URLSearchParams(window.location.search);

const printer = (over: Partial<ApiStationPrinter>): ApiStationPrinter => ({
  deviceId: '01990000-0000-7000-8000-00000000e001',
  label: 'Receipt Printer 1',
  role: 'receipt',
  kind: 'receipt',
  reachability: 'reachable',
  paperStatus: 'ok',
  lastError: null,
  lastSeenAt: '2026-10-08T03:00:00.000Z',
  queued: 0,
  ...over,
});

const printers: ApiStationPrinter[] =
  params.get('printer') === 'bad'
    ? [printer({ lastError: 'PRINTER_COVER_OPEN', queued: 1 })]
    : params.get('printer') === 'low'
      ? [printer({ paperStatus: 'low' })]
      : [printer({})];

/** What the platform answers, by path; anything else is a 404, as on a deployment without that route. */
function answer(path: string): unknown {
  if (/\/pricing-mode/.test(path)) {
    return params.get('pricing') === 'holiday'
      ? { date: '2026-04-13', mode: 'weekend', reason: 'Weekend pricing — Songkran', overrideName: 'Songkran' }
      : { date: '2026-10-08', mode: 'weekday', reason: 'Weekday pricing' };
  }
  if (/\/printers$/.test(path)) return { printers };
  if (/\/occupancy$/.test(path)) {
    const gate = params.get('gate');
    // Staging's own state is a park whose gate has never reported: "no gate".
    if (gate === 'live') return { adults: 31, kids: 42, total: 73, stale: false, asOf: '2026-10-08T03:00:00.000Z', gates: 1 };
    if (gate === 'stale') return { adults: 31, kids: 42, total: 73, stale: true, asOf: '2026-10-08T07:02:00.000Z', gates: 1 };
    return { adults: 0, kids: 0, total: 0, stale: true, asOf: null, gates: 0 };
  }
  return undefined;
}

// The occupancy chip reads the park from the catalog store, not the branch
// context: give the store the same park, with its platform id, so the chip
// asks for (and draws) this park's count.
upsertBranch(HARNESS_BRANCHES[0]!);
setActiveBranch(HARNESS_BRANCHES[0]!.id);

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const body = answer(url.pathname);
  return Promise.resolve(
    body === undefined
      ? new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
};

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Page() {
  const isMobile = useIsMobile();
  useEffect(() => {
    document.documentElement.dataset.layout = isMobile ? 'phone' : 'till';
  }, [isMobile]);
  return isMobile
    ? createElement('div', { id: 'phone' }, createElement(MobileShell))
    : createElement(
        'div',
        { id: 'till', className: 'h-[100dvh] w-full flex flex-col bg-background' },
        createElement(StationHeader, { active: 'tickets' }),
      );
}

declare global {
  interface Window {
    __readHeader?: typeof readHeader;
  }
}
window.__readHeader = readHeader;

document.documentElement.classList.add(params.get('theme') === 'dark' ? 'dark' : 'light');
createRoot(document.getElementById('root')!).render(
  createElement(QueryClientProvider, { client: queryClient }, createElement(Page)),
);
