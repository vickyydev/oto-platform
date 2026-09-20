import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { isMissingRoute } from '@/api/client';
import { failuresApi, type FailureGroup, type OpsRun } from '@/api/observability';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/Drawer';
import { EmptyState, ErrorNote, Fact, Loading, Panel, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusMark, StatusPill, toneForOutcome } from '@/components/Status';
import { PresetButton, PresetRow, SelectFilter } from '@/components/Filters';
import { useSession } from '@/auth/SessionContext';
import { elapsed, formatExact, formatWhen, millis, timeAgo } from '@/lib/time';

const WINDOWS = [
  { hours: 1, label: 'Last hour' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
];

const KINDS = [
  { value: 'job', label: 'Jobs' },
  { value: 'http', label: 'API errors' },
  { value: 'client', label: 'Client' },
  { value: 'device', label: 'Devices' },
  { value: 'integration', label: 'Integrations' },
  { value: 'process', label: 'Process' },
  { value: 'sync', label: 'Sync' },
];

/**
 * Everything that did not succeed, grouped by fingerprint.
 *
 * The grouping is the whole point. One printer that cannot be reached produces
 * a failure every thirty seconds; as sixty rows it reads as sixty problems and
 * buries the one other thing that broke this afternoon. As one row with a count
 * of sixty it reads as what it is — and the count is the useful number, because
 * it separates "happened once" from "happening continuously".
 */
export function Failures() {
  const { me, has } = useSession();
  const timezone = me?.branch?.timezone;
  const canManage = has('admin:ops:manage');

  const [windowHours, setWindowHours] = useState(24);
  const [kind, setKind] = useState('');
  const [groups, setGroups] = useState<FailureGroup[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<FailureGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await failuresApi.groups({ windowHours, kind: kind || undefined, limit: 50 });
      setGroups(page.groups);
      setCursor(page.nextCursor ?? null);
      setMissing(false);
    } catch (err) {
      if (isMissingRoute(err)) {
        setMissing(true);
        setGroups([]);
      } else {
        setError(err instanceof Error ? err.message : 'Could not read the failure list');
      }
    } finally {
      setLoading(false);
    }
  }, [windowHours, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await failuresApi.groups({ windowHours, kind: kind || undefined, cursor, limit: 50 });
      setGroups((prev) => [...prev, ...page.groups]);
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the next page');
    } finally {
      setLoadingMore(false);
    }
  };

  const total = groups.reduce((sum, g) => sum + g.count, 0);

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <PresetRow>
              {WINDOWS.map((w) => (
                <PresetButton key={w.hours} active={windowHours === w.hours} onClick={() => setWindowHours(w.hours)}>
                  {w.label}
                </PresetButton>
              ))}
            </PresetRow>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2 ml-auto"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SelectFilter label="Kind" value={kind} onChange={setKind} options={KINDS} anyLabel="Everything" />
          </div>
        </div>
      </Panel>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <Panel
        title={groups.length === 0 ? 'Failures' : `${groups.length} problem${groups.length === 1 ? '' : 's'}`}
        description={
          groups.length === 0
            ? undefined
            : `${total} failed run${total === 1 ? '' : 's'} in this window, grouped by what went wrong.`
        }
      >
        {missing ? (
          <RouteUnavailable
            what="The failure record"
            detail="Failed runs are recorded as soon as the operations API is deployed here; this page then fills itself in."
          />
        ) : loading ? (
          <Loading what="failures" />
        ) : groups.length === 0 ? (
          <EmptyState
            title="Nothing failed in this window"
            detail="Every run that finished, finished successfully."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {groups.map((group) => (
              <GroupRow
                key={group.fingerprint}
                group={group}
                timezone={timezone}
                canManage={canManage}
                onOpen={() => setOpen(group)}
                onRetried={() => void load()}
              />
            ))}
          </ul>
        )}

        {cursor && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Load more
            </Button>
          </div>
        )}
      </Panel>

      {open && (
        <GroupDrawer
          group={open}
          timezone={timezone}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onRetried={() => void load()}
        />
      )}
    </div>
  );
}

function GroupRow({
  group,
  timezone,
  canManage,
  onOpen,
  onRetried,
}: {
  group: FailureGroup;
  timezone?: string | null;
  canManage: boolean;
  onOpen: () => void;
  onRetried: () => void;
}) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusMark tone="down" />
        <button
          type="button"
          onClick={onOpen}
          className="font-mono text-sm font-semibold min-w-0 break-all text-left hover:underline underline-offset-4"
        >
          {group.name}
        </button>
        <Chip>{group.kind}</Chip>
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums"
          style={{
            color: 'hsl(var(--status-down))',
            backgroundColor: 'hsl(var(--status-down) / 0.12)',
          }}
          title={`${group.count} failed runs in this window`}
        >
          ×{group.count}
        </span>
        <span className="text-sm text-muted-foreground ml-auto whitespace-nowrap">
          {timeAgo(group.lastSeenAt)}
        </span>
      </div>

      {group.lastError && (
        <p className="mt-1.5 text-sm text-muted-foreground line-clamp-2 break-words">{group.lastError}</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>first seen {formatWhen(group.firstSeenAt, timezone)}</span>
        {group.requestId && <span className="font-mono break-all">request {group.requestId}</span>}
        {group.actionId && <span className="font-mono break-all">action {group.actionId}</span>}
        <span className="ml-auto flex items-center gap-2">
          <RetryButton group={group} canManage={canManage} onRetried={onRetried} />
          <button type="button" onClick={onOpen} className="font-semibold hover:text-foreground">
            Details
          </button>
        </span>
      </div>
    </li>
  );
}

/**
 * Retry is offered only where the API says the run is safe to re-run. Anything
 * that took money, printed, opened a gate or told a device to do something has
 * already half-happened; re-running it from a console is how one failure
 * becomes two events.
 */
function RetryButton({
  group,
  canManage,
  onRetried,
  size = 'link',
}: {
  group: FailureGroup;
  canManage: boolean;
  onRetried: () => void;
  size?: 'link' | 'button';
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!canManage || group.retryable === false || !group.lastRunId) return null;

  const retry = async () => {
    if (!group.lastRunId) return;
    setBusy(true);
    setNote(null);
    try {
      await failuresApi.retry(group.lastRunId);
      setNote('Retried');
      onRetried();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  if (size === 'button') {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="gap-2" onClick={() => void retry()} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          Retry the latest run
        </Button>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void retry()}
      disabled={busy}
      className="font-semibold hover:text-foreground disabled:opacity-50"
    >
      {busy ? 'Retrying…' : (note ?? 'Retry')}
    </button>
  );
}

function GroupDrawer({
  group,
  timezone,
  canManage,
  onClose,
  onRetried,
}: {
  group: FailureGroup;
  timezone?: string | null;
  canManage: boolean;
  onClose: () => void;
  onRetried: () => void;
}) {
  const [runs, setRuns] = useState<OpsRun[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void failuresApi
      .runs(group.fingerprint)
      .then(({ runs: list }) => {
        if (!cancelled) setRuns(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRuns([]);
        setMissing(isMissingRoute(err));
      });
    return () => {
      cancelled = true;
    };
  }, [group.fingerprint]);

  return (
    <Drawer
      title={group.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Chip>{group.kind}</Chip>
          <span>
            {group.count} failed run{group.count === 1 ? '' : 's'}, most recent {timeAgo(group.lastSeenAt)}
          </span>
        </span>
      }
      onClose={onClose}
      footer={<RetryButton group={group} canManage={canManage} onRetried={onRetried} size="button" />}
    >
      {group.lastError && (
        <div>
          <h3 className="text-sm font-bold mb-2">The last error</h3>
          <pre className="rounded-xl border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
            {group.lastError}
          </pre>
        </div>
      )}

      <div>
        <h3 className="text-sm font-bold mb-2">What this is</h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="Fingerprint">
            <span className="font-mono text-xs break-all">{group.fingerprint}</span>
          </Fact>
          <Fact label="Kind">{group.kind}</Fact>
          <Fact label="First seen">{formatExact(group.firstSeenAt, timezone)}</Fact>
          <Fact label="Last seen">{formatExact(group.lastSeenAt, timezone)}</Fact>
          {group.requestId && (
            <Fact label="Request id">
              <span className="font-mono text-xs break-all">{group.requestId}</span>
            </Fact>
          )}
          {group.actionId && (
            <Fact label="Action id">
              <span className="font-mono text-xs break-all">{group.actionId}</span>
            </Fact>
          )}
          {group.stationId && (
            <Fact label="Station">
              <span className="font-mono text-xs break-all">{group.stationId}</span>
            </Fact>
          )}
          {group.retryable === false && <Fact label="Retry">Not safe to re-run from here</Fact>}
        </dl>
      </div>

      <div>
        <h3 className="text-sm font-bold mb-2">Recent runs</h3>
        {missing ? (
          <RouteUnavailable what="The run history" />
        ) : runs === null ? (
          <Loading what="runs" />
        ) : runs.length === 0 ? (
          <EmptyState title="No individual runs returned" />
        ) : (
          <ul className="flex flex-col divide-y">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
                <StatusPill tone={toneForOutcome(run.outcome)}>{run.outcome}</StatusPill>
                <span className="text-sm text-muted-foreground">{formatWhen(run.startedAt, timezone)}</span>
                {run.attempt ? <Chip>attempt {run.attempt}</Chip> : null}
                <span className="text-sm text-muted-foreground ml-auto tabular-nums">
                  {run.durationMs !== null && run.durationMs !== undefined
                    ? millis(run.durationMs)
                    : run.finishedAt
                      ? elapsed(
                          (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
                        )
                      : '—'}
                </span>
                {run.error && (
                  <p className="w-full text-xs text-muted-foreground break-words">{run.error}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
