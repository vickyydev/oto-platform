import { useEffect, useState, type ReactNode } from 'react';
import { Check, Download, RefreshCw, Ticket } from 'lucide-react';
import { formatTHB } from '@oto/shared';
import { useSession } from '@/auth/SessionContext';
import { directoryApi, type BranchRow } from '@/api/platform';
import { staffCandidates, type BranchStaffMember } from '@/api/fleet';
import {
  voucherLedgerApi,
  VOUCHER_LEDGER_STATUSES,
  type VoucherLedger,
  type VoucherLedgerFilters,
  type VoucherLedgerRow,
  type VoucherLedgerStatus,
} from '@/api/vouchers';
import {
  boothApi,
  type BoothListRow,
  type VoucherDefinitionRow,
} from '@/components/booth/boothApi';
import { CONTROL, Labelled, SelectFilter } from '@/components/Filters';
import { ErrorNote, Loading } from '@/components/Panel';
import type { Tone } from '@/components/Status';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { FilterChip, SelectChip, StatusChip, TitleChip } from '@/components/redesign/chips';
import {
  CardShell,
  Eyebrow,
  PageGrid,
  Rail,
  RailNote,
} from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { formatWhen } from '@/lib/time';
import { cn } from '@/lib/utils';

const statusWords: Record<VoucherLedgerStatus, string> = {
  issued: 'Issued, not printed',
  printed: 'Printed',
  held: 'On a till’s cart',
  redeemed: 'Redeemed',
  expired: 'Expired',
  void: 'Void',
};

/**
 * The ledger's state language (SCRUM-474, VoucherLedger.dc.html). The three
 * states somebody may still have to act on carry a status ink WITH its shape —
 * printed (in a family's hand, the dot), held on a till's cart right now (the
 * triangle), issued but never printed (the hollow ring). The three finished
 * ones carry no status ink at all: redeemed on the mint wash with a tick,
 * expired and void on the neutral one, void struck through.
 */
const STATE_TONE: Partial<Record<VoucherLedgerStatus, Tone>> = {
  issued: 'idle',
  printed: 'ok',
  held: 'warn',
};

function StateChip({ status }: { status: VoucherLedgerStatus }) {
  const tone = STATE_TONE[status];
  if (tone) return <StatusChip tone={tone}>{statusWords[status]}</StatusChip>;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-[11px] py-1 text-xs font-bold whitespace-nowrap',
        status === 'redeemed'
          ? 'bg-secondary text-secondary-foreground'
          : 'bg-muted text-muted-foreground',
        status === 'void' && 'line-through',
      )}
    >
      {status === 'redeemed' && <Check className="w-3 h-3" strokeWidth={3} aria-hidden="true" />}
      {statusWords[status]}
    </span>
  );
}

export function Vouchers() {
  const { me } = useSession();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');
  const [types, setTypes] = useState<VoucherDefinitionRow[]>([]);
  const [booths, setBooths] = useState<BoothListRow[]>([]);
  const [staff, setStaff] = useState<BranchStaffMember[]>([]);
  const [filters, setFilters] = useState<VoucherLedgerFilters>({});
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<VoucherLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const timezone = branches.find((b) => b.id === branchId)?.timezone ?? me?.branch?.timezone;
  const branchName = branches.find((b) => b.id === branchId)?.name ?? me?.branch?.name;

  useEffect(() => {
    void Promise.all([directoryApi.branches(), boothApi.voucherDefinitions(true)])
      .then(([b, t]) => {
        const live = b.branches.filter((row) => !row.archived);
        setBranches(live);
        setBranchId((id) => id || live[0]?.id || '');
        setTypes(t.definitions);
      })
      .catch((e: unknown) =>
        setLookupError(e instanceof Error ? e.message : 'Could not load filters.'),
      );
  }, []);

  useEffect(() => {
    if (!branchId) return;
    let active = true;
    setBooths([]);
    setStaff([]);
    void Promise.allSettled([boothApi.list(branchId), staffCandidates(branchId)]).then(([b, s]) => {
      if (!active) return;
      if (b.status === 'fulfilled') setBooths(b.value.booths);
      if (s.status === 'fulfilled') setStaff(s.value.staff);
      setLookupError(
        b.status === 'rejected' || s.status === 'rejected'
          ? 'Some filter names could not be loaded. The voucher list is still available.'
          : null,
      );
    });
    return () => {
      active = false;
    };
  }, [branchId]);

  useEffect(() => {
    if (!branchId) return;
    let active = true;
    setData(null);
    setError(null);
    void voucherLedgerApi
      .list(branchId, filters, offset)
      .then((answer) => {
        if (active) setData(answer);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not read vouchers.');
      });
    return () => {
      active = false;
    };
  }, [branchId, filters, offset, refresh]);

  const change = (next: Partial<VoucherLedgerFilters>) => {
    setOffset(0);
    setFilters((held) => ({ ...held, ...next }));
  };
  const download = async () => {
    setDownloading(true);
    try {
      const response = await fetch(voucherLedgerApi.exportUrl(branchId, filters), {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? 'The download failed.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download =
        response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        'vouchers.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The download failed.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <CommandBar
        sectionId="vouchers"
        place={branchName}
        badges={<TitleChip>every code, from issue to redemption</TitleChip>}
        actions={
          <>
            <SelectChip
              label="Branch"
              showLabel
              value={branchId}
              onChange={(value) => {
                setBranchId(value);
                setFilters({});
                setOffset(0);
              }}
              options={branches.map((b) => ({ value: b.id, label: b.name }))}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-2 rounded-full px-3.5"
              onClick={() => setRefresh((n) => n + 1)}
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
            <Button
              size="sm"
              className="h-9 gap-2 rounded-full px-4 font-bold"
              disabled={!data || downloading}
              onClick={() => void download()}
            >
              <Download className="w-4 h-4" />
              Download CSV
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Status">
        <FilterChip active={!filters.status} onClick={() => change({ status: undefined })}>
          All
        </FilterChip>
        {VOUCHER_LEDGER_STATUSES.map((value) => (
          <FilterChip key={value} active={filters.status === value} onClick={() => change({ status: value })}>
            {statusWords[value]}
          </FilterChip>
        ))}
      </div>

      <CardShell>
        <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-5">
          <Labelled label="From day">
            <input
              className={CONTROL}
              type="date"
              value={filters.from ?? data?.range.from ?? ''}
              onChange={(e) => change({ from: e.target.value || undefined })}
            />
          </Labelled>
          <Labelled label="To day">
            <input
              className={CONTROL}
              type="date"
              value={filters.to ?? data?.range.to ?? ''}
              onChange={(e) => change({ to: e.target.value || undefined })}
            />
          </Labelled>
          <SelectFilter
            label="Voucher type"
            value={filters.definitionId ?? ''}
            onChange={(value) => change({ definitionId: value || undefined })}
            options={types.map((t) => ({ value: t.id, label: t.nameEn }))}
          />
          <SelectFilter
            label="Booth / counter"
            value={filters.stationId ?? ''}
            onChange={(value) => change({ stationId: value || undefined })}
            options={[
              ...booths.map((b) => ({ value: b.id, label: b.name })),
              { value: 'counter', label: 'Counter issues' },
            ]}
          />
          <SelectFilter
            label="Issued by"
            value={filters.issuedBy ?? ''}
            onChange={(value) => change({ issuedBy: value || undefined })}
            options={[
              { value: 'unattributed', label: 'Unattributed' },
              ...staff.map((s) => ({ value: s.accountId, label: s.name ?? s.accountId })),
            ]}
          />
        </div>
        <RailNote>
          Booth and counter vouchers, by the park’s trading day. Dates and times use{' '}
          {timezone ?? 'the branch timezone'}. Offline booth activity appears after the box syncs.
        </RailNote>
        {lookupError && <p className="text-sm text-muted-foreground">{lookupError}</p>}
      </CardShell>

      {error && <ErrorNote message={error} onRetry={() => setRefresh((n) => n + 1)} />}
      {!data && !error && <Loading what="vouchers" />}
      {data && (
        <PageGrid>
          <CardShell
            span={9}
            title={`${data.total} voucher${data.total === 1 ? '' : 's'}`}
            note="newest first"
            footer={
              <>
                <span>Only the last four characters of each code are shown; the till proves the paper.</span>
                <span className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full px-3.5"
                    disabled={offset === 0}
                    onClick={() => setOffset((n) => Math.max(0, n - 50))}
                  >
                    Previous
                  </Button>
                  <span className="text-sm tabular-nums">
                    {data.total ? offset + 1 : 0}–{offset + data.rows.length} of {data.total}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full px-3.5"
                    disabled={offset + data.rows.length >= data.total}
                    onClick={() => setOffset((n) => n + 50)}
                  >
                    Next
                  </Button>
                </span>
              </>
            }
          >
            {data.rows.length === 0 ? (
              <EmptyNote
                icon={Ticket}
                title="No matching vouchers"
                detail="Nothing was issued under these filters. Widen the days, or choose All above."
              />
            ) : (
              <div role="table" aria-label="Vouchers" className="flex min-w-0 flex-col gap-1">
                <div
                  role="row"
                  className="hidden gap-3.5 px-3 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80 @2xl:grid @2xl:grid-cols-[92px_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_76px_minmax(0,1.3fr)]"
                >
                  <span role="columnheader">Code</span>
                  <span role="columnheader">Voucher</span>
                  <span role="columnheader">Worth</span>
                  <span role="columnheader">Issued</span>
                  <span role="columnheader">Expires</span>
                  <span role="columnheader" className="text-right">
                    State
                  </span>
                </div>
                <div role="rowgroup" className="flex flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]">
                  {data.rows.map((r) => (
                    <LedgerRow key={r.id} row={r} timezone={timezone} />
                  ))}
                </div>
              </div>
            )}
          </CardShell>

          <Rail span={3}>
            <TotalsRail ledger={data} />
          </Rail>
        </PageGrid>
      )}
    </>
  );
}

/** One voucher: every fact the ledger holds about it, in the artboard's six columns. */
function LedgerRow({ row: r, timezone }: { row: VoucherLedgerRow; timezone?: string | null }) {
  const finished = r.status === 'expired' || r.status === 'void';
  return (
    <div
      role="row"
      className={cn(
        'flex flex-wrap gap-x-3.5 gap-y-1.5 px-3 py-[11px] text-[13.5px] @2xl:grid @2xl:grid-cols-[92px_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_76px_minmax(0,1.3fr)] @2xl:items-start',
        finished && 'opacity-60',
      )}
    >
      <Cell className="font-mono text-xs pt-0.5" label="Code · last 4">
        ····&nbsp;{r.codeLast4}
      </Cell>
      <Cell label="Type / prize">
        <span className="font-semibold">{r.type.nameEn}</span>
        {r.prize && r.prize.nameEn !== r.type.nameEn && (
          <span className="block text-xs text-muted-foreground">{r.prize.nameEn}</span>
        )}
      </Cell>
      <Cell label="Value handed over">
        <span className="font-semibold">{r.value.text}</span>
        <span className="block text-xs text-muted-foreground">
          {r.value.redeemedSatang !== null
            ? `${formatTHB(r.value.redeemedSatang)} handed over`
            : r.redeemed
              ? r.value.kind === 'gift'
                ? 'Gift handed over'
                : 'Value not recorded'
              : 'Not redeemed'}
        </span>
      </Cell>
      <Cell label="Issued">
        <span className="text-muted-foreground">
          {formatWhen(r.issuedAt, timezone)} · {r.place.name}
        </span>
        <span className="block text-xs text-muted-foreground">
          {r.issuedBy ? `${r.issuedBy.name ?? 'Staff'} (${r.issuedBy.code})` : 'Unattributed'}
        </span>
      </Cell>
      <Cell label="Expires" className="text-muted-foreground">
        {r.expiresAt ? formatWhen(r.expiresAt, timezone) : '—'}
      </Cell>
      <Cell label="Status" className="@2xl:flex @2xl:flex-col @2xl:items-end @2xl:text-right">
        <StateChip status={r.status} />
        {r.redeemed && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {formatWhen(r.redeemed.at, timezone)}
            <span className="block">
              {r.redeemed.branchName} · {r.redeemed.stationName}
            </span>
            <span className="block">
              {r.redeemed.by?.name ?? r.redeemed.by?.code ?? 'Unattributed'}
            </span>
            <span className="block break-all">
              Sale: {r.redeemed.receiptNumber ?? r.redeemed.saleId ?? 'Not recorded'}
            </span>
          </span>
        )}
      </Cell>
    </div>
  );
}

/**
 * A ledger cell. `label` is the column it sits under, carried as a title so the
 * stacked phone layout — which has no header row — still says what a figure is.
 */
function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="cell" title={label} className={cn('min-w-0 break-words', className)}>
      {children}
    </div>
  );
}

/**
 * The totals, all computed from what the ledger answered for these filters —
 * across every page, as the route counts them — and nothing else: no week,
 * no trend, only the range above.
 */
function TotalsRail({ ledger }: { ledger: VoucherLedger }) {
  const totals = ledger.totals;
  const issued = totals.reduce((sum, t) => sum + t.issued, 0);
  const redeemed = totals.reduce((sum, t) => sum + t.redeemed, 0);
  const handedOver = totals
    .filter((t) => t.valueKind !== 'gift')
    .reduce((sum, t) => sum + t.handedOverSatang, 0);
  const gifts = totals.filter((t) => t.valueKind === 'gift').reduce((sum, t) => sum + t.redeemed, 0);

  if (totals.length === 0) {
    return (
      <CardShell>
        <Eyebrow>Totals by voucher type</Eyebrow>
        <EmptyNote className="py-2" title="No vouchers match these filters" />
      </CardShell>
    );
  }

  return (
    <>
      <CardShell>
        <Eyebrow>Issued · matching the filters</Eyebrow>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[30px] font-extrabold tabular-nums">{issued}</span>
          <span className="text-[12.5px] text-muted-foreground">
            across {totals.length} type{totals.length === 1 ? '' : 's'}
          </span>
        </div>
        <ul className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
          {totals.map((t) => (
            <li key={t.type.id} className="flex justify-between gap-3">
              <span className="min-w-0 break-words">{t.type.nameEn}</span>
              <span className="font-semibold text-foreground tabular-nums">{t.issued}</span>
            </li>
          ))}
        </ul>
      </CardShell>

      <CardShell className="flex-1">
        <Eyebrow>Redeemed · matching the filters</Eyebrow>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[30px] font-extrabold tabular-nums">{redeemed}</span>
          <span className="text-[12.5px] text-muted-foreground">
            {formatTHB(handedOver)} handed over{gifts > 0 ? ` · ${gifts} gift${gifts === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <ul className="flex flex-col gap-2.5 text-[12.5px]">
          {totals.map((t) => (
            <li key={t.type.id} className="flex flex-col">
              <span className="font-semibold break-words">{t.type.nameEn}</span>
              <span className="text-muted-foreground">
                {t.issued} issued · {t.redeemed} redeemed · {t.expired} expired
              </span>
              <span className="text-muted-foreground">
                {((t.redemptionRate ?? 0) * 100).toFixed(1)}% redeemed ·{' '}
                {t.valueKind === 'gift'
                  ? `${t.redeemed} gifts handed over`
                  : `${formatTHB(t.handedOverSatang)} handed over`}
              </span>
            </li>
          ))}
        </ul>
        <RailNote className="mt-auto">
          All rows matching the filters, across every page — a status filter narrows these too. Value
          handed over is what the redeeming sale took off; gifts without a sale price are counted
          separately.
        </RailNote>
      </CardShell>
    </>
  );
}
