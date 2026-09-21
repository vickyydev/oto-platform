import { useCallback, useEffect, useState } from 'react';
import { Loader2, Printer, RefreshCw } from 'lucide-react';
import { api, apiUrl, ApiError } from '@/api/client';
import { isMissingRoute, type BoxRow } from '@/api/fleet';
import { Button } from '@/components/ui/button';
import { EmptyState, Loading, RouteUnavailable, StaleNote, Unreadable } from '@/components/Panel';
import { StatusPill, type Tone } from '@/components/Status';
import type { BoxDeviceList } from '@/lib/deviceList';

/**
 * What came out of the machine, and what is still waiting to (S2-06).
 *
 * WHY A PREVIEW AT ALL. A printer simulator that only said "printed" would go
 * green on a receipt with the guest's name missing, a Thai line rendered as
 * empty boxes, or a layout eight millimetres too wide for the head — which is
 * the class of fault this pipeline is most likely to have and the class a
 * person spots instantly by looking. So the simulator rebuilds the picture
 * from the bytes it was sent, with the renderer's own reader, and this shows
 * it. `packages/print` proves the bytes carry the rendered dots; this is where
 * somebody checks that the dots say the right thing.
 *
 * WHY ONLY FOR THE BOX RUNNING HERE. A printout is a rendered receipt: a
 * member's name and what they bought, or a child's name and an allergy line.
 * Pushing that up from a Raspberry Pi would put it on the telemetry wire,
 * which the box protocol's first rule forbids — so a Pi's previews stay on the
 * Pi and this panel says so rather than showing an empty box.
 */
interface Printout {
  seq: number;
  at: string;
  widthDots: number;
  heightDots: number;
  jobBytes: number;
  truncated: boolean;
  setup?: string[];
  previewUrl: string;
}

interface SimulatorEvent {
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}

interface PrintJobRow {
  id: string;
  kind: string;
  status: 'queued' | 'printed' | 'failed' | 'skipped';
  deviceLabel: string | null;
  role: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  queuedAt: string;
  finishedAt: string | null;
}

const printApi = {
  jobs: (boxId: string, limit = 12) =>
    api.get<{ jobs: PrintJobRow[] }>(
      `/boxes/${encodeURIComponent(boxId)}/print-jobs?limit=${limit}`,
    ),
  printouts: (deviceId: string, limit = 4) =>
    api.get<{ printouts: Printout[]; events: SimulatorEvent[] }>(
      `/devices/${encodeURIComponent(deviceId)}/printouts?limit=${limit}`,
    ),
};

const STATUS_TONE: Record<PrintJobRow['status'], Tone> = {
  printed: 'ok',
  queued: 'warn',
  failed: 'down',
  /** Neither good nor bad: a printout nobody configured a printer for. */
  skipped: 'idle',
};

export function PrintPanel({
  box,
  deviceList,
  onRetryDevices,
}: {
  box: BoxRow;
  /**
   * The box's devices and what they are worth. "No simulated printer on this
   * box" is a claim about the box, and it may only be made from a list that
   * was actually read — not from one that has not arrived, and not from one
   * whose request failed.
   */
  deviceList: BoxDeviceList;
  onRetryDevices: () => void;
}) {
  const simulatedPrinters = deviceList.devices.filter(
    (d) => !d.archived && d.transport === 'simulated' && d.kind.endsWith('printer'),
  );
  /**
   * Which printer's paper is on screen. Null means "nobody has chosen and
   * there is nothing to choose from", never "still deciding".
   *
   * It is NOT seeded from `simulatedPrinters[0]` here. `useState`'s initial
   * value is read once, at mount, and this panel mounts before the drawer's
   * device list has arrived — so seeding it left `selected` null for good, no
   * preview was ever requested, and the panel sat on "Loading the previews…"
   * until somebody happened to press a printer chip. The panel exists so a
   * person can look at the receipt; one that shows a spinner until you guess
   * at a button does not do that. The effect below adopts the first printer
   * when the list turns up, and leaves a choice already made alone.
   */
  const [selected, setSelected] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PrintJobRow[] | null>(null);
  /** When `jobs` was read, so a queue kept after a failed refresh can say so. */
  const [jobsReadAt, setJobsReadAt] = useState<number | null>(null);
  /** Why the last read of the queue failed. Null when the last read worked. */
  const [jobsFailed, setJobsFailed] = useState<string | null>(null);
  const [printouts, setPrintouts] = useState<Printout[] | null>(null);
  const [missing, setMissing] = useState(false);
  /** The box's previews live on the box; this one is not here. */
  const [elsewhere, setElsewhere] = useState(false);
  /** Why the previews could not be read, when that was not the reason above. */
  const [previewsFailed, setPreviewsFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Two reads, two failures, and each is reported where its consequence shows
  // rather than as one banner over the panel: a queue that could not be read
  // and previews that could not be read are different things to be told.
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const { jobs: rows } = await printApi.jobs(box.id);
      setJobs(rows);
      setJobsReadAt(Date.now());
      setJobsFailed(null);
      setMissing(false);
    } catch (err) {
      if (isMissingRoute(err)) {
        setMissing(true);
      } else {
        // Kept, rather than turned into "nothing has been printed on this box"
        // or left under a spinner that will never stop: the queue below is
        // whatever was last read, labelled with when that was.
        setJobsFailed(err instanceof Error ? err.message : 'The print queue could not be read.');
      }
      setBusy(false);
      return;
    }

    if (!selected) {
      setPrintouts(null);
      setBusy(false);
      return;
    }
    try {
      const { printouts: rows } = await printApi.printouts(selected);
      setPrintouts(rows);
      setElsewhere(false);
      setPreviewsFailed(null);
    } catch (err) {
      setPrintouts(null);
      // "This paper is not here" is a claim about WHERE the printout is, and
      // only two answers establish it: the 409s the API raises for a box that
      // is not in this process and for a device that is a real printer. Any
      // other failure — a 500, a dropped connection, the edge answering for
      // the origin — establishes nothing about the box, so it is reported as
      // the failed read it is rather than as an explanation.
      const notHere =
        err instanceof ApiError &&
        (err.code === 'BOX_NOT_IN_PROCESS' || err.code === 'DEVICE_NOT_SIMULATED');
      setElsewhere(notHere);
      setPreviewsFailed(
        notHere ? null : err instanceof Error ? err.message : 'The previews could not be read.',
      );
    } finally {
      setBusy(false);
    }
  }, [box.id, selected]);

  /**
   * Adopt a printer as soon as there is one, and let go of one that has gone.
   *
   * Keyed on the ids rather than the array, because the drawer rebuilds the
   * device list on every refresh — and on every re-render that recomputes it —
   * so an array identity would re-run this forever. Nothing polls devices
   * today; refreshes are a person pressing a button. The defence is kept
   * anyway, because it costs a `join` and the alternative is a render loop
   * whenever something does start refreshing on a timer.
   * A choice a person has made is left alone while that printer still exists;
   * if it is archived or removed from the box, the panel falls back to the
   * first remaining one rather than pointing at a device that is not there.
   */
  const printerIds = simulatedPrinters.map((p) => p.id).join(',');
  useEffect(() => {
    const ids = printerIds ? printerIds.split(',') : [];
    setSelected((current) => (current && ids.includes(current) ? current : (ids[0] ?? null)));
  }, [printerIds]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <section>
        <h3 className="text-sm font-bold mb-2">Printing</h3>
        <RouteUnavailable
          what="The print record"
          detail="This deployment's API has no print routes yet."
        />
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-bold">Printing</h3>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {jobsFailed && jobs !== null && jobsReadAt !== null && (
        <StaleNote readAt={jobsReadAt} message={jobsFailed} onRetry={() => void load()} />
      )}

      {jobs === null && jobsFailed ? (
        <Unreadable
          what="This box's print queue"
          message={jobsFailed}
          onRetry={busy ? undefined : () => void load()}
        />
      ) : jobs === null ? (
        <Loading what="the print queue" />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="Nothing has been printed on this box"
          detail="A test print from the Print Templates panel, or from a station, appears here."
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border mb-4">
          {jobs.map((job) => (
            <li key={job.id} className="px-3 py-2 flex flex-wrap items-center gap-2 text-sm">
              <StatusPill tone={STATUS_TONE[job.status]}>{job.status}</StatusPill>
              <span className="font-semibold">{job.kind.replace(/_/g, ' ')}</span>
              <span className="text-xs text-muted-foreground">
                {job.deviceLabel ?? 'no printer'}
                {job.role ? ` · ${job.role}` : ''}
              </span>
              {job.attempts > 1 && (
                <span className="text-xs text-muted-foreground">{job.attempts} attempts</span>
              )}
              {job.errorCode && (
                <span className="text-xs text-destructive break-words">
                  {job.errorCode}
                  {job.errorMessage ? ` — ${job.errorMessage}` : ''}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {new Date(job.queuedAt).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Which printers this box has is a question about the device list, and
          the three answers that are not "it has none" say so plainly. */}
      {deviceList.state === 'stale' && deviceList.readAt !== null && (
        <StaleNote
          readAt={deviceList.readAt}
          message={deviceList.error}
          onRetry={deviceList.refreshing ? undefined : onRetryDevices}
        />
      )}

      {deviceList.state === 'unread' ? (
        <Loading what="this box's devices" />
      ) : deviceList.state === 'failed' ? (
        <Unreadable
          what="This box's devices"
          message={deviceList.error}
          onRetry={deviceList.refreshing ? undefined : onRetryDevices}
        />
      ) : simulatedPrinters.length === 0 ? (
        <EmptyState
          title="No simulated printer on this box"
          detail="A real printer's output is on paper, so there is nothing to show here."
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {simulatedPrinters.map((printer) => (
              <button
                key={printer.id}
                type="button"
                onClick={() => setSelected(printer.id)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold border ${
                  selected === printer.id ? 'bg-foreground/10' : 'text-muted-foreground'
                }`}
              >
                <Printer className="inline h-3.5 w-3.5 mr-1" />
                {printer.label}
              </button>
            ))}
          </div>

          {elsewhere ? (
            <EmptyState
              title="This box's paper is not here"
              detail="Previews are held by the box that printed them. Only the box running inside this api process can show them from the Console."
            />
          ) : previewsFailed ? (
            <Unreadable
              what="This printer's paper"
              message={previewsFailed}
              onRetry={busy ? undefined : () => void load()}
            />
          ) : printouts === null ? (
            <Loading what="the previews" />
          ) : printouts.length === 0 ? (
            <EmptyState
              title="Nothing has come out of this printer yet"
              detail="Run a test print, then refresh."
            />
          ) : (
            <ul className="flex gap-3 overflow-x-auto pb-1">
              {printouts
                .slice()
                .reverse()
                .map((printout) => (
                  <li key={printout.seq} className="shrink-0">
                    <div className="rounded-lg border bg-white p-1">
                      <img
                        /* `previewUrl` is written from the API's root, and
                           this browser can only reach the API through the
                           `/api` prefix the proxy and the static rewrite
                           forward. Unprefixed it asks the Console's own origin
                           and the panel shows a broken image. */
                        src={apiUrl(printout.previewUrl)}
                        alt={`Printout ${printout.seq}, ${printout.widthDots} by ${printout.heightDots} dots`}
                        /* The image is 1 bit per pixel at 203 dpi; scaling it
                           down smoothly turns a crisp receipt into grey mush,
                           so it is shown at a readable width with the browser
                           told not to interpolate. */
                        className="block w-[220px] h-auto [image-rendering:pixelated]"
                      />
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      #{printout.seq} · {printout.widthDots}×{printout.heightDots} dots ·{' '}
                      {printout.jobBytes.toLocaleString()} bytes
                      {printout.truncated && (
                        <span className="text-destructive"> · cut off mid-job</span>
                      )}
                    </div>
                    {printout.setup && printout.setup.length > 0 && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground font-mono break-words max-w-[220px]">
                        {printout.setup.slice(0, 3).join(' · ')}
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
