import { useCallback, useEffect, useState } from 'react';
import { Archive, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { isMissingRoute } from '@/api/client';
import { failuresApi, type FailureGroup, type OpsRun } from '@/api/observability';
import { groupQuarantine, quarantineApi, type QuarantineGroup } from '@/api/sync';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/Drawer';
import { Quarantine } from '@/components/failures/Quarantine';
import { EmptyState, ErrorNote, Fact, Loading, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusMark, StatusPill, toneForOutcome } from '@/components/Status';
import { CommandBar } from '@/components/redesign/CommandBar';
import {
  CodeTag,
  CountBadge,
  FilterChip,
  SelectChip,
  StatusChip,
  Tag,
} from '@/components/redesign/chips';
import { CardShell, Eyebrow, PageGrid, Rail, RailNote } from '@/components/redesign/layout';
import { EmptyNote, UnreadNote } from '@/components/redesign/StatTile';
import { useSession } from '@/auth/SessionContext';
import { readReach, reachLabel, type Reach } from '@/lib/reach';
import { quarantineWords } from '@/lib/syncWords';
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

/** How many of the waiting quarantine groups the rail names before "Review". */
const RAIL_GROUPS = 3;

/** The Problems count for the command bar; `more` makes it a floor. */
interface GroupCount {
  count: number;
  more: boolean;
}

/** "3 groups", or "50+ groups" while the route has another page. */
function groupCountWords({ count, more }: GroupCount): string {
  return more ? `${count}+ groups` : `${count} group${count === 1 ? '' : 's'}`;
}

/** The rail's read of the open refusals. */
type RailRead =
  | { state: 'reading' }
  | { state: 'read'; waiting: QuarantineGroup[] }
  | { state: 'missing' }
  | { state: 'failed'; message: string };

/**
 * Two lists, because they are two different questions — and a rail that keeps
 * the second one in view while the first is open (SCRUM-474).
 *
 * PROBLEMS is everything the platform tried to do and could not: a job, a
 * route, an adapter, a device. Somebody presses retry, or fixes the thing.
 *
 * QUARANTINE is the other direction — facts the tills sent UP that the cloud
 * refused to file. Nothing there is broken in the platform sense; each row is
 * something that happened at the park and is now waiting on a person to decide
 * what becomes of it. Mixing the two into one list would put "a printer was
 * unreachable for forty seconds" beside "a member created at reception has not
 * been filed", and the second is the one that matters — which is why the rail
 * names the waiting ones from either view, and "Review" opens the full list.
 */
export function Failures() {
  const { me, has } = useSession();
  const timezone = me?.branch?.timezone;
  const canManage = has('admin:ops:manage');

  const [tab, setTab] = useState<'problems' | 'quarantine'>('problems');
  const [quarantineOpen, setQuarantineOpen] = useState<number | null>(null);
  /**
   * Groups in the Problems window, for the heading's chip. Null until read,
   * and null again when a read fails. `more` is the route's own nextCursor:
   * the pages not yet loaded make the count a floor, written "50+" the way the
   * sidebar's badge writes the same reading.
   */
  const [problemCount, setProblemCount] = useState<GroupCount | null>(null);
  /**
   * SCRUM-299 — which parks this page is answering for.
   *
   * Above both lists rather than inside one, because it is true of both: the
   * failure groups and the refused events are narrowed by the same reach. It
   * is read from the failure list, which is what the page opens on, and held
   * here so that switching views does not lose it.
   */
  const [reach, setReach] = useState<Reach | null>(null);

  // The rail's reading: the open refusals, grouped the way the Quarantine list
  // groups them. Re-read whenever that list reads itself, so a replay or a
  // discard there is reflected here.
  //
  // Three outcomes, never two: a failed read is neither "nothing waiting" nor
  // an absence (the rule `Unreadable` in components/Panel.tsx states), so it
  // gets its own state rather than being folded into an empty list.
  const [railTick, setRailTick] = useState(0);
  const [rail, setRail] = useState<RailRead>({ state: 'reading' });
  useEffect(() => {
    let cancelled = false;
    void quarantineApi
      .list({ status: 'open', limit: 50 })
      .then((page) => {
        if (cancelled) return;
        setRail({ state: 'read', waiting: groupQuarantine(page.events).filter((g) => g.openCount > 0) });
        // The count across the WHOLE table, which the route carries: one page
        // of rows is not the number the badge promises.
        if (page.openCount !== null && page.openCount !== undefined) setQuarantineOpen(page.openCount);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A deployment without the sync routes shows the rail saying so rather
        // than an error: nothing about the park is known from an absence. Any
        // other refusal is a read that failed, and the rail says THAT.
        setRail(
          isMissingRoute(err)
            ? { state: 'missing' }
            : {
                state: 'failed',
                message: err instanceof Error ? err.message : 'Could not read the quarantine list',
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [railTick]);
  const waiting = rail.state === 'read' ? rail.waiting : null;

  const onQuarantineCount = useCallback((open: number) => {
    setQuarantineOpen(open);
    setRailTick((n) => n + 1);
  }, []);

  const reachLine = reachLabel(reach);

  return (
    <>
      <CommandBar
        sectionId="failures"
        place={me?.branch?.name}
        badges={
          tab === 'problems' && problemCount !== null && problemCount.count > 0 ? (
            <StatusChip tone="warn" className="px-3 py-[5px] text-[12.5px]">
              {groupCountWords(problemCount)}
            </StatusChip>
          ) : undefined
        }
        actions={
          <>
            <FilterChip active={tab === 'problems'} onClick={() => setTab('problems')}>
              Problems
            </FilterChip>
            <FilterChip active={tab === 'quarantine'} onClick={() => setTab('quarantine')}>
              Quarantine
              {quarantineOpen !== null && quarantineOpen > 0 && (
                <span className="tabular-nums">· {quarantineOpen}</span>
              )}
            </FilterChip>
          </>
        }
      />

      {/*
        The one line that makes an empty list mean something: without it a
        manager whose park had nothing wrong and a manager whose park was not
        being shown to her read the identical screen.
      */}
      {reachLine && <p className="text-sm text-muted-foreground">{reachLine}</p>}

      <PageGrid>
        <div className="min-w-0 flex flex-col gap-5 @2xl:col-span-6 @4xl:col-span-8">
          {tab === 'problems' ? (
            <Problems
              timezone={timezone}
              canManage={canManage}
              onReach={setReach}
              onCount={setProblemCount}
            />
          ) : (
            <Quarantine timezone={timezone} canManage={canManage} onOpenCount={onQuarantineCount} />
          )}
        </div>

        <Rail span={4}>
          <CardShell
            icon={Archive}
            title="Quarantine"
            badge={
              waiting && waiting.length > 0 ? (
                <CountBadge
                  tone="down"
                  count={waiting.length}
                  label={`${waiting.length} group${waiting.length === 1 ? '' : 's'} waiting on a decision`}
                />
              ) : undefined
            }
          >
            {rail.state === 'missing' ? (
              <RouteUnavailable what="The quarantine list" />
            ) : rail.state === 'failed' ? (
              <UnreadNote
                className="py-3"
                what="The quarantine list"
                message={rail.message}
                onRetry={() => setRailTick((n) => n + 1)}
              />
            ) : waiting === null ? (
              <Loading what="quarantined events" />
            ) : waiting.length === 0 ? (
              <EmptyNote
                good
                className="py-3"
                title="Nothing is waiting on a decision"
                detail="Every event the boxes have sent was filed — or was a duplicate, which is the ledger working as intended."
              />
            ) : (
              <ul className="flex flex-col gap-2.5" aria-label="Waiting on a decision">
                {waiting.slice(0, RAIL_GROUPS).map((group) => (
                  <li
                    key={group.key}
                    className="flex flex-col gap-2 rounded-[14px] border border-status-down/25 px-4 py-3.5"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <CodeTag>{group.reason}</CodeTag>
                      <span className="text-xs font-bold text-muted-foreground tabular-nums">
                        ×{group.openCount}
                      </span>
                    </span>
                    <p className="text-[13px] leading-normal">{quarantineWords(group.reason).label}</p>
                    <p className="text-xs text-muted-foreground">
                      {group.boxName ?? 'Unnamed box'} · {timeAgo(group.lastSeenAt)}
                    </p>
                  </li>
                ))}
                {waiting.length > RAIL_GROUPS && (
                  <li className="px-1 text-xs text-muted-foreground">
                    and {waiting.length - RAIL_GROUPS} more
                  </li>
                )}
              </ul>
            )}
            {waiting && waiting.length > 0 && tab !== 'quarantine' && (
              <Button
                variant="outline"
                size="sm"
                className="self-start rounded-full border-primary px-3.5 font-bold text-primary-ink"
                onClick={() => setTab('quarantine')}
              >
                Review
              </Button>
            )}
            <RailNote>
              A quarantined event changes nothing until someone decides. The till's own copy is
              untouched.
            </RailNote>
          </CardShell>

          <CardShell className="flex-1">
            <Eyebrow>Refused events · waiting</Eyebrow>
            <div className="flex flex-wrap items-baseline gap-2.5">
              {quarantineOpen === null ? (
                <span className="text-[30px] font-extrabold text-muted-foreground">—</span>
              ) : (
                <span
                  className={`inline-flex items-center gap-2 text-[30px] font-extrabold tabular-nums ${
                    quarantineOpen === 0 ? 'text-status-ok' : 'text-status-down'
                  }`}
                >
                  <StatusMark tone={quarantineOpen === 0 ? 'ok' : 'down'} className="w-3.5 h-3.5" />
                  {quarantineOpen}
                </span>
              )}
              <span className="text-[12.5px] text-muted-foreground">
                {quarantineOpen === null
                  ? rail.state === 'failed'
                    ? 'could not be read just now'
                    : rail.state === 'reading'
                      ? 'reading…'
                      : 'not known on this deployment'
                  : quarantineOpen === 0
                    ? 'nothing the boxes sent is held back'
                    : `event${quarantineOpen === 1 ? '' : 's'} the cloud would not file`}
              </span>
            </div>
            <RailNote className="mt-auto">
              Each one is something that happened at the park. Replaying or discarding it is a decision
              taken on the Quarantine list, with what it carried in front of you.
            </RailNote>
          </CardShell>
        </Rail>
      </PageGrid>
    </>
  );
}

/**
 * Everything that did not succeed, grouped by fingerprint.
 *
 * The grouping is the whole point. One printer that cannot be reached produces
 * a failure every thirty seconds; as sixty rows it reads as sixty problems and
 * buries the one other thing that broke this afternoon. As one card with a
 * count of sixty it reads as what it is — and the count is the useful number,
 * because it separates "happened once" from "happening continuously".
 */
function Problems({
  timezone,
  canManage,
  onReach,
  onCount,
}: {
  timezone?: string | null;
  canManage: boolean;
  /** SCRUM-299 — handed up so the line sits above both lists. */
  onReach: (reach: Reach | null) => void;
  /** The number of groups, for the command bar — null while it is not known. */
  onCount: (groups: GroupCount | null) => void;
}) {
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
      onReach(readReach(page));
      onCount({ count: page.groups.length, more: Boolean(page.nextCursor) });
      setMissing(false);
    } catch (err) {
      // Either way the chip has nothing true to say about THIS window.
      onCount(null);
      if (isMissingRoute(err)) {
        setMissing(true);
        setGroups([]);
        onReach(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not read the failure list');
      }
    } finally {
      setLoading(false);
    }
  }, [windowHours, kind, onReach, onCount]);

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
      // What is on screen now, and still a floor while another page remains.
      onCount({ count: groups.length + page.groups.length, more: Boolean(page.nextCursor) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the next page');
    } finally {
      setLoadingMore(false);
    }
  };

  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const windowWords = WINDOWS.find((w) => w.hours === windowHours)?.label.toLowerCase() ?? 'this window';

  return (
    <>
      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <CardShell
        className="flex-1"
        title={groups.length === 0 ? 'Failures' : `${groups.length} problem${groups.length === 1 ? '' : 's'}`}
        note={
          groups.length === 0
            ? 'the same fault repeating is one problem'
            : `${total} failed run${total === 1 ? '' : 's'} in this window, grouped by what went wrong`
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-2 rounded-full px-3.5"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {WINDOWS.map((w) => (
            <FilterChip key={w.hours} active={windowHours === w.hours} onClick={() => setWindowHours(w.hours)}>
              {w.label}
            </FilterChip>
          ))}
          <SelectChip
            label="Kind"
            value={kind}
            onChange={setKind}
            options={KINDS}
            anyLabel="All kinds"
            className="ml-auto"
          />
        </div>

        {missing ? (
          <RouteUnavailable
            what="The failure record"
            detail="Failed runs are recorded as soon as the operations API is deployed here; this page then fills itself in."
          />
        ) : loading && groups.length === 0 ? (
          <Loading what="failures" />
        ) : error && groups.length === 0 ? (
          // The error note above carries the reason and the Try again.
          <UnreadNote what="The failure list" />
        ) : groups.length === 0 ? (
          <EmptyNote
            good
            title={`Nothing failed in the ${windowWords}`}
            detail="Every run that finished, finished successfully. A wider window is one press above."
          />
        ) : (
          <ul className="flex flex-col gap-2.5" aria-label="Failure groups">
            {groups.map((group) => (
              <GroupCard
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
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full px-4"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Load more
            </Button>
          </div>
        )}
      </CardShell>

      {open && (
        <GroupDrawer
          group={open}
          timezone={timezone}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onRetried={() => void load()}
        />
      )}
    </>
  );
}

/** One problem: what failed, how often, since when, and what can be done. */
function GroupCard({
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
    <li className="flex flex-col gap-2.5 rounded-2xl border border-status-warn/25 bg-status-warn/5 px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusMark tone="warn" className="w-4 h-4" />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 text-left hover:underline underline-offset-4"
          title="See each run"
        >
          <CodeTag className="text-xs">{group.name}</CodeTag>
        </button>
        <Tag>{group.kind}</Tag>
        <span
          className="ml-auto text-[12.5px] font-bold text-status-warn tabular-nums"
          title={`${group.count} failed runs in this window`}
        >
          × {group.count}
        </span>
      </div>

      {group.lastError && (
        <p className="text-sm font-semibold line-clamp-2 break-words">{group.lastError}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-[12.5px] text-muted-foreground">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            first {formatWhen(group.firstSeenAt, timezone)} · last {timeAgo(group.lastSeenAt)}
          </span>
          {group.requestId && <span className="font-mono text-xs break-all">request {group.requestId}</span>}
          {group.actionId && <span className="font-mono text-xs break-all">action {group.actionId}</span>}
        </span>
        <span className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="rounded-full bg-card px-3" onClick={onOpen}>
            Details
          </Button>
          <RetryButton group={group} canManage={canManage} onRetried={onRetried} />
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
      className="rounded-full border border-primary bg-card px-3 py-1.5 text-xs font-bold text-primary-ink disabled:opacity-50"
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
