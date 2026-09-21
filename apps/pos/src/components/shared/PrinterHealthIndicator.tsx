import { useEffect, useState } from 'react';
import { Printer, AlertTriangle } from 'lucide-react';
import { useStation } from '@/station/StationContext';
import { printApi, type ApiStationPrinter } from '@/api/platform';

/**
 * The red indicator in the station header (S2-06).
 *
 * PROJECT_CONTEXT §7.3 asks for it in so many words: "the station screen shows
 * a red indicator before staff notice a missing receipt". So this is not a
 * status page — it is the smallest thing that catches somebody's eye while
 * they are doing something else, and it is silent when every printer is well.
 *
 * **It reads the platform, not the box.** The box pings its printers on every
 * heartbeat and reports what they said; this reads the device rows that
 * heartbeat updated. Asking the box directly would look fresher and would show
 * nothing at all in the case that matters most — the box being unreachable —
 * because the thing that cannot answer is the thing being asked. The cost is
 * staleness: up to one heartbeat interval before the platform knows, plus up
 * to one poll below before this does.
 */
const POLL_MS = 30_000;

type Severity = 'ok' | 'warn' | 'bad';

function severityOf(printers: ApiStationPrinter[]): Severity {
  if (printers.some((p) => p.reachability === 'unreachable' || p.paperStatus === 'out')) return 'bad';
  if (printers.some((p) => p.paperStatus === 'low' || p.queued > 0)) return 'warn';
  return 'ok';
}

function describe(printers: ApiStationPrinter[]): string {
  const bad = printers.filter((p) => p.reachability === 'unreachable' || p.paperStatus === 'out');
  if (bad.length > 0) {
    return bad
      .map((p) => `${p.label}: ${p.paperStatus === 'out' ? 'out of paper' : 'not answering'}`)
      .join(' · ');
  }
  const low = printers.filter((p) => p.paperStatus === 'low');
  const waiting = printers.filter((p) => p.queued > 0);
  const parts: string[] = [];
  if (low.length > 0) parts.push(`${low.map((p) => p.label).join(', ')}: paper low`);
  if (waiting.length > 0) {
    const n = waiting.reduce((sum, p) => sum + p.queued, 0);
    parts.push(`${n} job${n === 1 ? '' : 's'} waiting`);
  }
  return parts.join(' · ');
}

export function PrinterHealthIndicator() {
  const { station } = useStation();
  const stationId = station?.stationId ?? null;
  const [printers, setPrinters] = useState<ApiStationPrinter[] | null>(null);

  useEffect(() => {
    if (!stationId) {
      setPrinters(null);
      return;
    }
    let live = true;
    const read = async (): Promise<void> => {
      try {
        const { printers: rows } = await printApi.stationPrinters(stationId);
        if (live) setPrinters(rows);
      } catch {
        /**
         * Deliberately silent. A till that cannot reach the platform already
         * says so in the link banner above this, and a second red thing saying
         * the same in different words is how a header stops being read.
         */
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [stationId]);

  // Nothing to say: no station picked, nothing loaded yet, no printers on it,
  // or every printer well. The header stays as it was.
  if (!printers || printers.length === 0) return null;
  const severity = severityOf(printers);
  if (severity === 'ok') return null;

  const detail = describe(printers);
  return (
    <span
      role="status"
      title={detail}
      aria-label={`Printers: ${detail}`}
      className={`shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 h-9 text-sm font-semibold ${
        severity === 'bad'
          ? 'bg-destructive/15 text-destructive'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
      }`}
    >
      {severity === 'bad' ? (
        <AlertTriangle className="w-4 h-4 shrink-0" />
      ) : (
        <Printer className="w-4 h-4 shrink-0" />
      )}
      <span className="hidden xl:inline max-w-[220px] truncate font-normal">{detail}</span>
      <span className="xl:hidden">Printer</span>
    </span>
  );
}
