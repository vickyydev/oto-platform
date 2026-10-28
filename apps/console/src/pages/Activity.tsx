import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, EyeOff, Loader2, RefreshCw, SlidersHorizontal } from 'lucide-react';
import {
  activityApi,
  type ActivityExportFilters,
  type AuditEntry,
  type AuditFilters,
} from '@/api/observability';
import { directoryApi, type AccountRow, type BranchRow } from '@/api/platform';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/Drawer';
import { EmptyState, ErrorNote, Fact, Loading } from '@/components/Panel';
import { StatusMark, StatusPill, toneForOutcome } from '@/components/Status';
import { DateTimeFilter, SelectFilter, TextFilter } from '@/components/Filters';
import { RawRecord, RecordDiff, RecordFields, isMaskedValue } from '@/components/RecordView';
import { CommandBar, placeName } from '@/components/redesign/CommandBar';
import { CodeTag, FilterChip, SelectChip, Tag, TitleChip } from '@/components/redesign/chips';
import { CardShell, PageGrid, RailNote } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { useSession } from '@/auth/SessionContext';
import { formatExact, formatWhen } from '@/lib/time';
import { canExportActivity } from '@/lib/alertRouting';

const PAGE_SIZE = 50;

/**
 * The three ways people actually come to this log, as the ticket names them.
 * Each is a category filter rather than a separate query, so a category added
 * to the audit vocabulary later needs no change here.
 */
const PRESETS = [
  { id: '', label: 'Everything', category: '' },
  // SCRUM-644: answered on the server for every row — labelled, or classified
  // from the action name (the named refusals; the unmasked reads and exports).
  { id: 'data_access', label: 'Data access', category: 'data_access' },
  { id: 'denial', label: 'Denials', category: 'denial' },
  { id: 'admin', label: 'Admin log', category: 'admin' },
  { id: 'staff', label: 'Staff log', category: 'staff' },
  { id: 'auth', label: 'Sign-in log', category: 'auth' },
];

/** The presets the audit route filters on itself (SCRUM-644). */
const SERVER_CATEGORIES = ['data_access', 'denial'] as const;
type ServerCategory = (typeof SERVER_CATEGORIES)[number];
const serverCategory = (preset: string): ServerCategory | undefined =>
  (SERVER_CATEGORIES as readonly string[]).includes(preset) ? (preset as ServerCategory) : undefined;

/** The most one export holds; the route refuses more (SCRUM-644). */
const EXPORT_ROWS = 5000;

/** The two the route's schema accepts; a refusal is a failure by action name. */
const OUTCOMES = [
  { value: 'success', label: 'Succeeded' },
  { value: 'failure', label: 'Failed or refused' },
];

interface Filters {
  preset: string;
  action: string;
  actorAccountId: string;
  branchId: string;
  entityType: string;
  requestId: string;
  outcome: string;
  from: string;
  to: string;
  /** SCRUM-644: the producer's app label, and the app a Console action reached into. */
  app: string;
  targetApp: string;
}

const EMPTY: Filters = {
  preset: '',
  action: '',
  actorAccountId: '',
  branchId: '',
  entityType: '',
  requestId: '',
  outcome: '',
  from: '',
  to: '',
  app: '',
  targetApp: '',
};

/** The filters the server applies — what the list reads and what an export carries. */
function serverFilters(filters: Filters): ActivityExportFilters {
  return {
    category: serverCategory(filters.preset),
    action: filters.action.trim() || undefined,
    actorAccountId: filters.actorAccountId || undefined,
    branchId: filters.branchId || undefined,
    entityType: filters.entityType.trim() || undefined,
    outcome: (filters.outcome as AuditFilters['outcome']) || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    app: filters.app.trim() || undefined,
    targetApp: filters.targetApp.trim() || undefined,
  };
}

/**
 * The audit log, made readable.
 *
 * Two things shape this page. The first is that a reader almost always arrives
 * with one handle — a request id from a support message, a person's name, an
 * hour of the afternoon — so the filters are the page rather than an afterthought
 * above it. The second is masking: personal data arrives hidden unless the
 * caller holds `admin:audit:read_sensitive`, and the row SAYS it is hidden
 * rather than showing a gap, because a blank where a child's allergy note
 * belongs is indistinguishable from an empty field.
 */
export function Activity() {
  const { me, permissions } = useSession();
  const timezone = me?.branch?.timezone;
  const canExport = canExportActivity(permissions);

  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [branches, setBranches] = useState<BranchRow[] | null>(null);

  // Names for the ids in the log. An account holding `admin:audit:read` need
  // not hold `admin:account:read`, so both lookups are allowed to fail: the
  // filter becomes a free-text box and the rows fall back to the id.
  useEffect(() => {
    void directoryApi
      .accounts()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts(null));
    void directoryApi
      .branches()
      .then((r) => setBranches(r.branches))
      .catch(() => setBranches(null));
  }, []);

  const [masked, setMasked] = useState(true);
  /** Filters the API ignored: narrowed here, or not possible at all. */
  const [narrowedHere, setNarrowedHere] = useState<string[]>([]);
  const [unavailableFilters, setUnavailableFilters] = useState<string[]>([]);

  const query = useCallback(
    (extra: Partial<AuditFilters> = {}): AuditFilters => ({
      ...serverFilters(filters),
      requestId: filters.requestId.trim() || undefined,
      limit: PAGE_SIZE,
      ...extra,
    }),
    [filters],
  );

  const scope = useMemo(() => ({ active: false, request: 0 }), [query]);
  const load = useCallback(async () => {
    if (!scope.active) return;
    const request = ++scope.request;
    const current = () => scope.active && scope.request === request;
    setLoading(true);
    setLoadingMore(false);
    setCursor(null);
    setError(null);
    try {
      const page = await activityApi.list(query());
      if (!current()) return;
      const { rows, narrowed, unavailable } = applyUnsupportedFilters(page.entries, filters);
      setEntries(rows);
      setNarrowedHere(narrowed);
      setUnavailableFilters(unavailable);
      setMasked(page.masked !== false);
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      if (!current()) return;
      setError(err instanceof Error ? err.message : 'Could not read the activity log');
    } finally {
      if (current()) setLoading(false);
    }
  }, [query, filters, scope]);

  useEffect(() => {
    scope.active = true;
    void load();
    return () => { scope.active = false; scope.request++; };
  }, [load, scope]);

  const loadMore = async () => {
    if (!scope.active || !cursor || loading || loadingMore) return;
    const request = scope.request;
    const current = () => scope.active && scope.request === request;
    setLoadingMore(true);
    try {
      const page = await activityApi.list(query({ cursor }));
      if (!current()) return;
      const { rows } = applyUnsupportedFilters(page.entries, filters);
      setEntries((prev) => [...prev, ...rows]);
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      if (!current()) return;
      setError(err instanceof Error ? err.message : 'Could not read the next page');
    } finally {
      if (current()) setLoadingMore(false);
    }
  };

  const actorName = useCallback(
    (id: string | null): string => {
      if (!id) return 'The system';
      const found = accounts?.find((a) => a.id === id);
      return found?.employee?.name ?? found?.phone ?? shortId(id);
    },
    [accounts],
  );

  const branchName = useCallback(
    (id: string | null): string | null => {
      if (!id) return null;
      return branches?.find((b) => b.id === id)?.name ?? shortId(id);
    },
    [branches],
  );


  const anyFilter = Boolean(
    filters.action ||
      filters.actorAccountId ||
      filters.branchId ||
      filters.entityType ||
      filters.requestId ||
      filters.outcome ||
      filters.from ||
      filters.to ||
      filters.app ||
      filters.targetApp,
  );

  return (
    <>
      <CommandBar
        sectionId="activity"
        place={me?.branch?.name}
        badges={<TitleChip>every change, who and when</TitleChip>}
        actions={
          <>
            {PRESETS.map((p) => (
              <FilterChip
                key={p.id}
                active={filters.preset === p.category}
                onClick={() => setFilters((f) => ({ ...f, preset: p.category }))}
              >
                {p.label}
              </FilterChip>
            ))}
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
            {canExport && <ExportControl filters={serverFilters(filters)} />}
          </>
        }
      />

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <PageGrid>
        {/*
          The filter rail. A reader almost always arrives with one handle — a
          request id from a support message, a person, an hour of the afternoon
          — so every filter the log takes is here, stacked, rather than one.
        */}
        <CardShell
          span={3}
          icon={SlidersHorizontal}
          title="Filters"
          actions={
            anyFilter ? (
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...EMPTY, preset: f.preset }))}
                className="text-xs font-semibold text-primary-ink hover:underline underline-offset-4"
              >
                Clear filters
              </button>
            ) : undefined
          }
        >
          <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
            <TextFilter
              label="Action"
              value={filters.action}
              onChange={(v) => setFilters((f) => ({ ...f, action: v }))}
              placeholder="member.update"
            />
            {accounts ? (
              <SelectFilter
                label="Actor"
                value={filters.actorAccountId}
                onChange={(v) => setFilters((f) => ({ ...f, actorAccountId: v }))}
                options={accounts.map((a) => ({
                  value: a.id,
                  label: a.employee?.name ?? a.phone,
                }))}
                anyLabel="Anyone"
              />
            ) : (
              <TextFilter
                label="Actor account id"
                value={filters.actorAccountId}
                onChange={(v) => setFilters((f) => ({ ...f, actorAccountId: v }))}
                placeholder="account uuid"
              />
            )}
            {branches && branches.length > 1 && (
              <SelectFilter
                label="Branch"
                value={filters.branchId}
                onChange={(v) => setFilters((f) => ({ ...f, branchId: v }))}
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
                anyLabel="Every branch"
              />
            )}
            <SelectFilter
              label="Outcome"
              value={filters.outcome}
              onChange={(v) => setFilters((f) => ({ ...f, outcome: v }))}
              options={OUTCOMES}
            />
            <TextFilter
              label="Request id"
              value={filters.requestId}
              onChange={(v) => setFilters((f) => ({ ...f, requestId: v }))}
              placeholder="paste from the POS About panel"
            />
            <TextFilter
              label="Entity"
              value={filters.entityType}
              onChange={(v) => setFilters((f) => ({ ...f, entityType: v }))}
              placeholder="member"
            />
            <DateTimeFilter
              label="From"
              value={filters.from}
              onChange={(v) => setFilters((f) => ({ ...f, from: v }))}
            />
            <DateTimeFilter label="To" value={filters.to} onChange={(v) => setFilters((f) => ({ ...f, to: v }))} />
            <TextFilter
              label="App"
              value={filters.app}
              onChange={(v) => setFilters((f) => ({ ...f, app: v }))}
              placeholder="inbox"
            />
            <TextFilter
              label="Target app"
              value={filters.targetApp}
              onChange={(v) => setFilters((f) => ({ ...f, targetApp: v }))}
              placeholder="oto_app"
            />
          </div>

          {narrowedHere.length > 0 && (
            <RailNote>
              {narrowedHere.join(' and ')} {narrowedHere.length === 1 ? 'was' : 'were'} applied to this
              page in the browser — the audit route does not carry{' '}
              {narrowedHere.length === 1 ? 'that filter' : 'those filters'} yet, so paging past this page
              may miss matches.
            </RailNote>
          )}
          {unavailableFilters.length > 0 && (
            <RailNote>
              {unavailableFilters.join(' and ')} cannot be applied on this deployment yet: only Data
              access and Denials are filtered by the server. The list is unfiltered — narrow it by action
              or actor instead.
            </RailNote>
          )}
          <RailNote className="mt-auto">
            {masked
              ? 'Names, phones, allergies and medical notes are hidden in these rows. Seeing them needs admin:audit:read_sensitive.'
              : 'You hold admin:audit:read_sensitive, so these rows carry the personal data in full — and each read of them is recorded as audit.read_sensitive against your account.'}
          </RailNote>
        </CardShell>

        <CardShell
          span={9}
          title="The log"
          note="newest first"
          footer={
            <>
              <span>Open a row for the full before-and-after</span>
              {cursor && (
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
              )}
            </>
          }
        >
          {loading ? (
            <Loading what="activity" />
          ) : entries.length === 0 ? (
            <EmptyNote
              title="Nothing matches"
              detail="Widen the window, or clear a filter — the log keeps everything, so an empty result is a narrow question."
            />
          ) : (
            <ul className="flex min-w-0 flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  actor={actorName(entry.actorAccountId)}
                  branch={branchName(entry.branchId)}
                  timezone={timezone}
                  onOpen={() => setOpen(entry)}
                />
              ))}
            </ul>
          )}
        </CardShell>
      </PageGrid>

      {open && (
        <EntryDrawer
          entry={open}
          actor={actorName(open.actorAccountId)}
          branch={branchName(open.branchId)}
          timezone={timezone}
          masked={masked}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/**
 * One line of the log, as the artboard's feed draws it: when, the action as
 * the platform names it, what it was done to, who, and where. The whole row
 * opens the record.
 */
function EntryRow({
  entry,
  actor,
  branch,
  timezone,
  onOpen,
}: {
  entry: AuditEntry;
  actor: string;
  branch: string | null;
  timezone?: string | null;
  onOpen: () => void;
}) {
  const masked = entryIsMasked(entry);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-[12px] px-3 py-2.5 text-left text-[13px] hover-elevate @2xl:grid @2xl:grid-cols-[92px_minmax(0,200px)_minmax(0,1fr)_minmax(0,140px)_minmax(0,120px)]"
      >
        <span
          className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground/80 whitespace-nowrap"
          title={formatExact(entry.createdAt, timezone)}
        >
          {entry.outcome && <StatusMark tone={toneForOutcome(entry.outcome)} className="w-2.5 h-2.5" />}
          {formatWhen(entry.createdAt, timezone)}
        </span>
        <span className="min-w-0 justify-self-start">
          <CodeTag>{entry.action}</CodeTag>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {entry.entityType && <span className="truncate">{entry.entityType}</span>}
          {entry.app && <Tag>{entry.app}</Tag>}
          {entry.targetApp && <Tag>→ {entry.targetApp}</Tag>}
          {entry.origin && <span className="text-xs text-muted-foreground">{entry.origin}</span>}
          {masked && (
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title="Personal data in this row is hidden"
            >
              <EyeOff className="w-3 h-3" />
              hidden
            </span>
          )}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{actor}</span>
        <span className="min-w-0 justify-self-end" title={branch ?? undefined}>
          {branch ? <Tag className="max-w-full truncate">{placeName(branch)}</Tag> : null}
        </span>
      </button>
    </li>
  );
}

type Tab = 'changes' | 'raw' | 'related';

function EntryDrawer({
  entry,
  actor,
  branch,
  timezone,
  masked,
  onClose,
}: {
  entry: AuditEntry;
  actor: string;
  branch: string | null;
  timezone?: string | null;
  /** Whether the API masked this page's personal fields on the way out. */
  masked: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('changes');
  const [related, setRelated] = useState<AuditEntry[] | null>(null);
  const [relatedMore, setRelatedMore] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const [relatedTick, setRelatedTick] = useState(0);

  useEffect(() => {
    setTab('changes');
    setRelated(null);
    setRelatedMore(false);
    setRelatedError(null);
  }, [entry]);

  // Everything else that happened under the same request id: one action at the
  // till is usually several rows, and reading one of them alone is how a
  // half-explanation gets believed. The route cannot filter on a request id
  // yet, so the page is narrowed here — see applyUnsupportedFilters.
  useEffect(() => {
    if (tab !== 'related' || related !== null || !entry.requestId) return;
    let active = true;
    setRelatedError(null);
    void activityApi
      .list({ requestId: entry.requestId, limit: 200 })
      .then((page) => {
        if (!active) return;
        setRelatedMore(Boolean(page.nextCursor));
        setRelated(
          page.entries.filter((e) => e.id !== entry.id && e.requestId === entry.requestId),
        );
      })
      .catch((err: unknown) => {
        if (active) setRelatedError(err instanceof Error ? err.message : 'Could not read related rows');
      });
    return () => { active = false; };
  }, [tab, related, entry.requestId, entry.id, relatedTick]);

  const shown = entry;
  const thisRowIsMasked = masked && entryIsMasked(entry);

  return (
    <Drawer
      title={entry.action}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          {entry.outcome && <StatusPill tone={toneForOutcome(entry.outcome)}>{entry.outcome}</StatusPill>}
          <span>
            {actor} · {formatExact(entry.createdAt, timezone)}
          </span>
        </span>
      }
      onClose={onClose}
    >
      <dl className="grid gap-4 sm:grid-cols-2">
        <Fact label="Actor">{actor}</Fact>
        <Fact label="Branch">{branch ?? 'Not branch-scoped'}</Fact>
        <Fact label="Entity">
          {entry.entityType ?? '—'}
          {entry.entityId && (
            <span className="block font-mono text-xs text-muted-foreground break-all">{entry.entityId}</span>
          )}
        </Fact>
        <Fact label="When">{formatExact(entry.occurredAt ?? entry.createdAt, timezone)}</Fact>
        {entry.app && <Fact label="App">{entry.app}</Fact>}
        {entry.targetApp && <Fact label="Target app">{entry.targetApp}</Fact>}
        {entry.origin && <Fact label="Origin">{entry.origin}</Fact>}
        {entry.category && <Fact label="Category">{entry.category}</Fact>}
        {entry.requestId && (
          <Fact label="Request id">
            <span className="font-mono text-xs break-all">{entry.requestId}</span>
          </Fact>
        )}
        {entry.stationId && (
          <Fact label="Station">
            <span className="font-mono text-xs break-all">{entry.stationId}</span>
          </Fact>
        )}
        {entry.sessionId && (
          <Fact label="Session">
            <span className="font-mono text-xs break-all">{entry.sessionId}</span>
          </Fact>
        )}
      </dl>

      {thisRowIsMasked ? (
        <div className="rounded-xl border border-dashed px-3 py-2.5 flex flex-wrap items-center gap-3">
          <EyeOff className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm text-muted-foreground flex-1 min-w-0">
            The personal fields in this record are hidden — you can see which fields it holds, not what
            they say. Seeing them needs{' '}
            <code className="font-mono text-xs">admin:audit:read_sensitive</code>.
          </span>
        </div>
      ) : !masked ? (
        <div className="rounded-xl border border-dashed px-3 py-2.5 flex flex-wrap items-center gap-3">
          <Eye className="w-4 h-4 shrink-0" style={{ color: 'hsl(var(--status-warn))' }} />
          <span className="text-sm text-muted-foreground flex-1 min-w-0">
            You are reading these rows unmasked. That read is recorded as{' '}
            <code className="font-mono text-xs">audit.read_sensitive</code> against your account.
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-b pb-3">
        <TabButton active={tab === 'changes'} onClick={() => setTab('changes')}>
          Changes
        </TabButton>
        <TabButton active={tab === 'raw'} onClick={() => setTab('raw')}>
          Raw record
        </TabButton>
        <TabButton active={tab === 'related'} onClick={() => setTab('related')}>
          Related
        </TabButton>
      </div>

      {tab === 'changes' && <RecordDiff before={shown.before} after={shown.after} />}

      {tab === 'raw' && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-bold mb-2">The entity as it was left</h3>
            <RecordFields record={shown.after ?? shown.before} />
          </div>
          <div>
            <h3 className="text-sm font-bold mb-2">As stored</h3>
            <RawRecord record={{ before: shown.before, after: shown.after }} />
          </div>
        </div>
      )}

      {tab === 'related' &&
        (!entry.requestId ? (
          <EmptyState
            title="No request id on this row"
            detail="Rows written outside a request — a job, a sweep — have nothing to be grouped with."
          />
        ) : relatedError ? (
          <ErrorNote message={relatedError} onRetry={() => setRelatedTick((n) => n + 1)} />
        ) : related === null ? (
          <Loading what="related rows" />
        ) : related.length === 0 ? (
          <EmptyState title={relatedMore ? 'No related rows found on this page' : 'This was the only row for that request'}
            detail={relatedMore ? 'Only the latest 200 audit rows were checked. Older related rows may exist.' : undefined} />
        ) : (
          <>
          {relatedMore && <p className="text-sm text-muted-foreground">Only the latest 200 audit rows were checked. Older related rows may exist.</p>}
          <ul className="flex flex-col divide-y">
            {related.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
                {row.outcome && <StatusMark tone={toneForOutcome(row.outcome)} />}
                <span className="font-mono text-sm break-all min-w-0">{row.action}</span>
                <span className="text-sm text-muted-foreground ml-auto">
                  {formatWhen(row.createdAt, timezone)}
                </span>
              </li>
            ))}
          </ul>
          </>
        ))}
    </Drawer>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <FilterChip active={active} onClick={onClick}>
      {children}
    </FilterChip>
  );
}

/**
 * Two of the filters this page offers are in the ticket but not yet in
 * `GET /audit`: the request id and the category the three presets stand on. An
 * unknown query key is stripped by the route's schema, so the answer comes back
 * unfiltered — and an unfiltered list under a filter's name is the one outcome
 * worth going out of the way to avoid.
 *
 * So the answer is checked. A request id can be applied here, over the page in
 * hand, and the page says it was narrowed in the browser. A category cannot be
 * applied at all, because the rows do not carry one: narrowing on it would
 * empty the list and claim there was nothing to see. That one is named as
 * unavailable and the list is left alone.
 *
 * Both checks disappear on their own the day the route grows the columns.
 */
function applyUnsupportedFilters(
  entries: AuditEntry[],
  filters: Filters,
): { rows: AuditEntry[]; narrowed: string[]; unavailable: string[] } {
  const narrowed: string[] = [];
  const unavailable: string[] = [];
  let rows = entries;

  const requestId = filters.requestId.trim();
  if (requestId && rows.some((e) => e.requestId !== requestId)) {
    rows = rows.filter((e) => e.requestId === requestId);
    narrowed.push('The request id');
  }

  // Data access and Denials are the server's (SCRUM-644). The other presets
  // are not yet a server filter at all, so the list under them is unfiltered.
  if (filters.preset && !serverCategory(filters.preset)) {
    unavailable.push('The log presets');
  }

  return { rows, narrowed, unavailable };
}

/**
 * SCRUM-644 — the audited export of what the filters select.
 *
 * One bounded page (the newest 5000 rows), masked exactly as the list is,
 * and recorded against the person pressing it. When the trail holds more, the
 * note says so and offers the next page as a second export rather than ever
 * fetching the whole log at once.
 */
export function ExportControl({ filters }: { filters: ActivityExportFilters }) {
  const [format, setFormat] = useState<'csv' | 'ndjson'>('csv');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [next, setNext] = useState<{ cursor: string; key: string } | null>(null);
  const key = JSON.stringify(filters);
  const active = useMemo(() => ({ key }), [key]);
  const latest = useRef(active);
  latest.current = active;
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setNote(null);
    setNext(null);
  }, [key]);

  const run = async (cursor?: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNote(null);
    const asked = active;
    const current = () => mounted.current && latest.current === asked;
    try {
      const file = await activityApi.exportFile(filters, format, { limit: EXPORT_ROWS, cursor });
      if (!current()) return;
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename ?? `activity.${format}`;
      try { link.click(); } finally { URL.revokeObjectURL(url); }
      const rows = file.rows ?? 0;
      setNext(file.nextCursor ? { cursor: file.nextCursor, key } : null);
      setNote(
        `Exported ${rows} row${rows === 1 ? '' : 's'}${file.masked ? ', personal fields hidden' : ''}. ` +
          (file.nextCursor
            ? 'More rows match: narrow the filters, or export the next page.'
            : 'That is everything these filters match.'),
      );
    } catch (err) {
      if (current()) setNote(err instanceof Error ? err.message : 'The export failed');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-2" aria-label="Export">
      <SelectChip
        label="Export format"
        value={format}
        onChange={(v) => setFormat(v === 'ndjson' ? 'ndjson' : 'csv')}
        options={[
          { value: 'csv', label: 'CSV' },
          { value: 'ndjson', label: 'NDJSON' },
        ]}
      />
      <Button
        variant="outline"
        size="sm"
        className="h-9 gap-2 rounded-full px-3.5"
        onClick={() => void run()}
        disabled={busy}
        title="The newest 5000 rows these filters select, masked as shown here. Each export is recorded against your account."
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        Export
      </Button>
      {next && next.key === key && (
        <Button variant="outline" size="sm" className="h-9 rounded-full px-3.5" onClick={() => void run(next.cursor)} disabled={busy}>
          Export the next page
        </Button>
      )}
      {note && (
        <span role="status" className="text-xs text-muted-foreground">
          {note}
        </span>
      )}
    </span>
  );
}

/** Whether anything in this row's payloads came back masked. */
function entryIsMasked(entry: AuditEntry): boolean {
  if (entry.masked) return true;
  return [entry.before, entry.after].some(
    (record) => record !== null && typeof record === 'object' && Object.values(record).some(isMaskedValue),
  );
}

/** Enough of a uuid to tell two apart, where there is no name for it. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
