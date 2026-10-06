import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { isMissingRoute } from '@/api/client';
import {
  groupQuarantine,
  quarantineApi,
  type AnomalyRow,
  type QuarantineGroup,
  type QuarantineRow,
} from '@/api/sync';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/Drawer';
import { ErrorNote, Fact, Loading, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusMark, StatusPill } from '@/components/Status';
import { CodeTag, FilterChip, SelectChip, Tag, TONE_INK, TONE_TINT } from '@/components/redesign/chips';
import { CardShell } from '@/components/redesign/layout';
import { EmptyNote, UnreadNote } from '@/components/redesign/StatTile';
import { Field, TextInput } from '@/components/Form';
import {
  QUARANTINE_REASON_OPTIONS,
  anomalyFacts,
  anomalyWords,
  quarantineStatusWord,
  quarantineWords,
  toneForQuarantineStatus,
} from '@/lib/syncWords';
import { formatExact, formatWhen, timeAgo } from '@/lib/time';

const STATUSES = [
  { value: 'open', label: 'Waiting on a decision' },
  { value: 'replayed', label: 'Filed on a replay' },
  { value: 'discarded', label: 'Discarded' },
  { value: '', label: 'Everything' },
];

/**
 * The events the cloud refused to file, and what to do about each one.
 *
 * The grouping is the failure list's idea, for the same reason: one poison
 * shape from one box produces an event every time that till rings a sale, and
 * as forty rows it reads as forty problems. It is grouped in the browser here
 * rather than by the API — see groupQuarantine.
 *
 * What this page is careful about is the WORDS. Every row is something that
 * happened at the park: a person entered at reception, a sale rung up at a
 * till. The cloud refused it; the till's own copy is untouched. So the page
 * says what the event was, what refusing it means, and what each of the two
 * buttons will actually do — before either of them is anywhere near a press.
 */
export function Quarantine({
  timezone,
  canManage,
  onOpenCount,
}: {
  timezone?: string | null;
  /** `admin:ops:manage` — the same permission a failed run's retry takes. */
  canManage: boolean;
  /** Lifted to the tab strip, so the badge counts what this list actually holds. */
  onOpenCount: (open: number) => void;
}) {
  const [status, setStatus] = useState('open');
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState<QuarantineRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await quarantineApi.list({
        status: status || undefined,
        reason: reason || undefined,
        limit: 100,
      });
      setRows(page.events);
      setCursor(page.nextCursor ?? null);
      setMissing(false);
      onOpenCount(page.openCount ?? page.events.filter((e) => e.status === 'open').length);
    } catch (err) {
      if (isMissingRoute(err)) {
        setMissing(true);
        setRows([]);
      } else {
        setError(err instanceof Error ? err.message : 'Could not read the quarantine list');
      }
    } finally {
      setLoading(false);
    }
  }, [status, reason, onOpenCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await quarantineApi.list({
        status: status || undefined,
        reason: reason || undefined,
        cursor,
        limit: 100,
      });
      setRows((prev) => [...prev, ...page.events]);
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the next page');
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = groupQuarantine(rows);
  const open = openKey ? (groups.find((g) => g.key === openKey) ?? null) : null;
  const openTotal = rows.filter((r) => r.status === 'open').length;

  return (
    <>
      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <CardShell
        title={groups.length === 0 ? 'Quarantine' : `${groups.length} problem${groups.length === 1 ? '' : 's'}`}
        note={
          groups.length === 0
            ? 'events the cloud refused to file'
            : `${rows.length} event${rows.length === 1 ? '' : 's'} the cloud would not file${
                openTotal > 0 ? `, ${openTotal} still waiting on a decision` : ''
              }. Each one is something that happened at the park; the till's own copy is untouched.`
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
          {STATUSES.map((s) => (
            <FilterChip key={s.value} active={status === s.value} onClick={() => setStatus(s.value)}>
              {s.label}
            </FilterChip>
          ))}
          <SelectChip
            label="Why it was refused"
            value={reason}
            onChange={setReason}
            options={QUARANTINE_REASON_OPTIONS}
            anyLabel="Every reason"
            className="ml-auto"
          />
        </div>

        {missing ? (
          <RouteUnavailable
            what="The quarantine list"
            detail="Events the cloud refuses are recorded as soon as the sync API is deployed here; this tab then fills itself in."
          />
        ) : loading && rows.length === 0 ? (
          <Loading what="quarantined events" />
        ) : error && groups.length === 0 ? (
          // Never the all-clear below: this list was not read. The error note
          // above carries the reason and the Try again.
          <UnreadNote what="The quarantine list" />
        ) : groups.length === 0 ? (
          <EmptyNote
            good={status === 'open'}
            title={status === 'open' ? 'Nothing is waiting on a decision' : 'Nothing here'}
            detail={
              status === 'open'
                ? 'Every event the boxes have sent was filed — or was a duplicate, which is the ledger working as intended.'
                : 'No event has been dealt with under this filter. “Waiting on a decision” is one press above.'
            }
          />
        ) : (
          <ul className="flex flex-col gap-2.5" aria-label="Quarantined events">
            {groups.map((group) => (
              <GroupRow
                key={group.key}
                group={group}
                timezone={timezone}
                onOpen={() => setOpenKey(group.key)}
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

      <Anomalies timezone={timezone} />

      {open && (
        <GroupDrawer
          group={open}
          timezone={timezone}
          canManage={canManage}
          onClose={() => setOpenKey(null)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}

function GroupRow({
  group,
  timezone,
  onOpen,
}: {
  group: QuarantineGroup;
  timezone?: string | null;
  onOpen: () => void;
}) {
  const words = quarantineWords(group.reason);
  const tone = group.openCount > 0 ? 'down' : 'idle';
  return (
    <li
      className={
        group.openCount > 0
          ? 'flex flex-col gap-2 rounded-2xl border border-status-down/25 bg-status-down/5 px-[18px] py-4'
          : 'flex flex-col gap-2 rounded-2xl bg-foreground/[0.025] px-[18px] py-4'
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusMark tone={tone} className="w-4 h-4" />
        <CodeTag className="text-xs">{group.reason}</CodeTag>
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 text-left text-sm font-semibold break-words hover:underline underline-offset-4"
        >
          {words.label}
        </button>
        {group.type && <Tag>{group.type}</Tag>}
        <span
          className={`ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${TONE_INK[tone]} ${TONE_TINT[tone]}`}
          title={`${group.count} event${group.count === 1 ? '' : 's'} in this group`}
        >
          ×{group.count}
        </span>
      </div>

      <p className="text-[13px] leading-normal text-muted-foreground break-words">{words.what}</p>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-[12.5px] text-muted-foreground">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span>{group.boxName ?? 'Unnamed box'}</span>
          <span>first seen {formatWhen(group.firstSeenAt, timezone)}</span>
          <span>last {timeAgo(group.lastSeenAt)}</span>
          {group.openCount > 0 && group.openCount < group.count && (
            <span>
              {group.openCount} of {group.count} still open
            </span>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full border-primary bg-card px-3.5 font-bold text-primary-ink"
          onClick={onOpen}
        >
          Details
        </Button>
      </div>
    </li>
  );
}

/**
 * The whole of one problem: what it is, what each button does, and every event
 * in it.
 *
 * The two actions live HERE and not on the list row, unlike a failed run's
 * retry. Re-running a failed job is a decision about the platform; replaying or
 * discarding one of these is a decision about a fact from the park, and it
 * should not be possible to take it from a list without having read what the
 * event was.
 */
function GroupDrawer({
  group,
  timezone,
  canManage,
  onClose,
  onChanged,
}: {
  group: QuarantineGroup;
  timezone?: string | null;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const words = quarantineWords(group.reason);
  const openEvents = group.events.filter((e) => e.status === 'open');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [discardNote, setDiscardNote] = useState('');
  const [discarding, setDiscarding] = useState(false);

  const replayOne = async (row: QuarantineRow) => {
    setBusy(row.id);
    setNote(null);
    setFailed(null);
    try {
      const result = await quarantineApi.replay(row.id);
      setNote(
        result.status === 'replayed'
          ? `Filed. It is now event ${result.eventId ?? row.eventId}.`
          : `Refused again${result.errorMessage ? `: ${result.errorMessage}` : ''}. It is still in quarantine.`,
      );
      onChanged();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The replay could not be sent');
    } finally {
      setBusy(null);
    }
  };

  const discardOne = async (row: QuarantineRow, why: string) => {
    setBusy(row.id);
    setNote(null);
    setFailed(null);
    try {
      await quarantineApi.discard(row.id, why);
      setNote('Discarded. The row stays, with who discarded it and why.');
      onChanged();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The discard could not be sent');
    } finally {
      setBusy(null);
    }
  };

  /**
   * One at a time, stopping at the first refusal rather than pressing on.
   *
   * A group is usually one fault repeated, so the first answer is the answer
   * for all of them — and carrying on after a refusal would bury it under
   * thirty more of the same.
   */
  const replayAll = async () => {
    setBusy('all');
    setNote(null);
    setFailed(null);
    let filed = 0;
    try {
      for (const row of openEvents) {
        const result = await quarantineApi.replay(row.id);
        if (result.status !== 'replayed') {
          setNote(
            `${filed} filed, then ${row.eventId.slice(0, 8)} was refused again${
              result.errorMessage ? `: ${result.errorMessage}` : ''
            }. The rest were left alone.`,
          );
          return;
        }
        filed += 1;
      }
      setNote(`${filed} event${filed === 1 ? '' : 's'} filed.`);
    } catch (err) {
      setFailed(
        `${filed} filed, then it stopped: ${err instanceof Error ? err.message : 'the replay could not be sent'}`,
      );
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const discardAll = async (why: string) => {
    setBusy('all');
    setNote(null);
    setFailed(null);
    let done = 0;
    try {
      for (const row of openEvents) {
        await quarantineApi.discard(row.id, why);
        done += 1;
      }
      setNote(`${done} event${done === 1 ? '' : 's'} discarded.`);
    } catch (err) {
      setFailed(
        `${done} discarded, then it stopped: ${err instanceof Error ? err.message : 'the discard could not be sent'}`,
      );
    } finally {
      setBusy(null);
      setDiscarding(false);
      setDiscardNote('');
      onChanged();
    }
  };

  const newest = group.events[0];

  return (
    <Drawer
      title={words.label}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          {group.type && <Chip>{group.type}</Chip>}
          <span>
            {group.count} event{group.count === 1 ? '' : 's'} from {group.boxName ?? 'this box'}, most
            recent {timeAgo(group.lastSeenAt)}
          </span>
        </span>
      }
      onClose={onClose}
      footer={
        canManage && openEvents.length > 0 ? (
          <div className="flex flex-col gap-2">
            {discarding ? (
              <div className="flex flex-col gap-2">
                <Field
                  label={`Why ${openEvents.length === 1 ? 'this is' : `these ${openEvents.length} are`} being discarded`}
                  hint="Kept on the row. Somebody may have to explain later why the park let this go."
                >
                  <TextInput
                    value={discardNote}
                    onChange={setDiscardNote}
                    placeholder="Duplicate of the sale re-keyed at the till"
                    maxLength={200}
                  />
                </Field>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      setDiscarding(false);
                      setDiscardNote('');
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="gap-2"
                    disabled={busy !== null || discardNote.trim().length < 3}
                    onClick={() => void discardAll(discardNote.trim())}
                  >
                    {busy === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Discard {openEvents.length}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={busy !== null}
                  onClick={() => void replayAll()}
                >
                  {busy === 'all' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3.5 h-3.5" />
                  )}
                  Replay {openEvents.length === 1 ? 'it' : `all ${openEvents.length}`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-destructive"
                  disabled={busy !== null}
                  onClick={() => setDiscarding(true)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Discard {openEvents.length === 1 ? 'it' : `all ${openEvents.length}`}…
                </Button>
              </div>
            )}
            {note && <p className="text-xs text-muted-foreground break-words">{note}</p>}
            {failed && <p className="text-xs text-destructive break-words">{failed}</p>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {openEvents.length === 0
              ? 'Every event in this group has been dealt with.'
              : 'Replaying and discarding take admin:ops:manage.'}
          </p>
        )
      }
    >
      <div>
        <h3 className="text-sm font-bold mb-2">What happened</h3>
        <p className="text-sm text-muted-foreground break-words">{words.what}</p>
        {newest?.errorMessage && (
          <pre className="mt-2 rounded-xl border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {newest.errorCode ? `${newest.errorCode}: ` : ''}
            {newest.errorMessage}
          </pre>
        )}
      </div>

      <div>
        <h3 className="text-sm font-bold mb-2">What each choice does</h3>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border p-3">
            <p className="text-sm font-semibold">Replay</p>
            <p className="mt-0.5 text-sm text-muted-foreground break-words">{words.replay}</p>
            {!words.replayCanWork && (
              <p className="mt-1.5 text-xs font-semibold" style={{ color: 'hsl(var(--status-warn))' }}>
                As things stand this will be refused again. Something has to change first.
              </p>
            )}
          </div>
          <div className="rounded-xl border p-3">
            <p className="text-sm font-semibold">Discard</p>
            <p className="mt-0.5 text-sm text-muted-foreground break-words">{words.discard}</p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold mb-2">Where it came from</h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="Box">{group.boxName ?? group.boxId}</Fact>
          <Fact label="Journal epoch">
            <span className="tabular-nums">{newest?.journalEpoch ?? '—'}</span>
          </Fact>
          <Fact label="Kind of event">{group.type ?? 'Could not be read'}</Fact>
          <Fact label="First seen">{formatExact(group.firstSeenAt, timezone)}</Fact>
          <Fact label="Last seen">{formatExact(group.lastSeenAt, timezone)}</Fact>
          {newest?.actionId && (
            <Fact label="Action id">
              <span className="font-mono text-xs break-all">{newest.actionId}</span>
            </Fact>
          )}
          {newest?.batchId && (
            <Fact label="Arrived in batch">
              <span className="font-mono text-xs break-all">{newest.batchId}</span>
            </Fact>
          )}
          {newest?.existingPayloadHash && (
            <Fact label="Hash already stored">
              <span className="font-mono text-xs break-all">{newest.existingPayloadHash}</span>
            </Fact>
          )}
        </dl>
      </div>

      <div>
        <h3 className="text-sm font-bold mb-2">
          The event{group.count === 1 ? '' : `s (${group.count})`}
        </h3>
        <ul className="flex flex-col divide-y">
          {group.events.map((row) => (
            <EventRow
              key={row.id}
              row={row}
              timezone={timezone}
              canManage={canManage}
              busy={busy === row.id}
              disabled={busy !== null}
              onReplay={() => void replayOne(row)}
              onDiscard={(why) => void discardOne(row, why)}
            />
          ))}
        </ul>
      </div>
    </Drawer>
  );
}

function EventRow({
  row,
  timezone,
  canManage,
  busy,
  disabled,
  onReplay,
  onDiscard,
}: {
  row: QuarantineRow;
  timezone?: string | null;
  canManage: boolean;
  busy: boolean;
  disabled: boolean;
  onReplay: () => void;
  onDiscard: (why: string) => void;
}) {
  const [showPayload, setShowPayload] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [why, setWhy] = useState('');

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusPill tone={toneForQuarantineStatus(row.status)}>
          {quarantineStatusWord(row.status)}
        </StatusPill>
        <span className="text-xs text-muted-foreground tabular-nums">
          epoch {row.journalEpoch} · no. {row.boxSeq}
        </span>
        <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
          {formatWhen(row.receivedAt, timezone)}
        </span>
      </div>

      {row.resolutionNote && (
        <p className="mt-1 text-xs text-muted-foreground break-words">
          “{row.resolutionNote}”{row.resolvedByName ? ` — ${row.resolvedByName}` : ''}
        </p>
      )}

      <button
        type="button"
        onClick={() => setShowPayload((v) => !v)}
        className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        {showPayload ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {showPayload ? 'Hide what it carried' : 'What it carried'}
      </button>

      {showPayload && (
        <pre className="mt-1.5 rounded-xl border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {row.payload ? JSON.stringify(row.payload, null, 2) : 'The ledger kept no payload for this one.'}
        </pre>
      )}

      {canManage && row.status === 'open' && (
        <div className="mt-2">
          {discarding ? (
            <div className="flex flex-col gap-2">
              <Field label="Why it is being discarded">
                <TextInput value={why} onChange={setWhy} maxLength={200} />
              </Field>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    setDiscarding(false);
                    setWhy('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={disabled || why.trim().length < 3}
                  onClick={() => onDiscard(why.trim())}
                >
                  Discard it
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="gap-2" disabled={disabled} onClick={onReplay}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                Replay
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={disabled}
                onClick={() => setDiscarding(true)}
              >
                Discard…
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Filed, with a caveat.
 *
 * On the same tab as the refusals because the two answer one question in
 * sequence, and in a panel of their own because an anomaly is not work: it is
 * the cloud saying "I had to make a judgement here, and this is what it was".
 * The same-person-at-two-tills merge is the one the park will actually read.
 */
function Anomalies({ timezone }: { timezone?: string | null }) {
  const [rows, setRows] = useState<AnomalyRow[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void quarantineApi
      .anomalies({ limit: 20 })
      .then((page) => {
        if (cancelled) return;
        setRows(page.anomalies);
        setCursor(page.nextCursor ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setMissing(isMissingRoute(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await quarantineApi.anomalies({ cursor, limit: 20 });
      setRows((prev) => [...(prev ?? []), ...page.anomalies]);
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the next page');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <CardShell
      title="Filed, with a caveat"
      note="Events that DID go in, where the cloud had to make a judgement on the way — a clock it could not trust, a batch that arrived twice, the same person entered at two tills. Nothing here is waiting on you."
    >
      {missing ? (
        <RouteUnavailable what="The anomaly record" />
      ) : rows === null ? (
        <Loading what="anomalies" />
      ) : rows.length === 0 ? (
        <EmptyNote
          good
          className="py-3"
          title="No caveats recorded"
          detail="Every event the boxes sent was filed exactly as it arrived."
        />
      ) : (
        <>
          <ul className="flex flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]">
            {rows.map((row) => {
              const words = anomalyWords(row.kind);
              const facts = anomalyFacts(row.detail);
              return (
                <li key={row.id} className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusMark tone="idle" />
                    <span className="text-sm font-semibold break-words">{words.label}</span>
                    {row.boxName && <Tag>{row.boxName}</Tag>}
                    <span className="text-sm text-muted-foreground ml-auto whitespace-nowrap">
                      {timeAgo(row.detectedAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground break-words">{words.what}</p>
                  {/*
                    What the cloud actually recorded about this one — the two
                    candidate trading days, the positions that went missing, the
                    two member ids behind a merge. Without it the sentence above
                    describes a category and the row evidences nothing.
                  */}
                  {facts.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {facts.map((fact) => (
                        <span key={fact.label} className="break-all">
                          {fact.label}{' '}
                          <span className="font-semibold text-foreground tabular-nums">
                            {fact.value}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatWhen(row.detectedAt, timezone)}</span>
                    {row.eventId && <span className="font-mono break-all">event {row.eventId}</span>}
                    {row.relatedEventId && (
                      <span className="font-mono break-all">and {row.relatedEventId}</span>
                    )}
                    {row.actionId && <span className="font-mono break-all">action {row.actionId}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          {error && <p className="text-sm text-destructive break-words">{error}</p>}
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
        </>
      )}
    </CardShell>
  );
}
