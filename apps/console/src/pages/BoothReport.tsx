import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, FerrisWheel, RefreshCw } from 'lucide-react';
import {
  addDaysToIsoDate,
  businessDate,
  parseDayStart,
  type BoothFunnel,
  type BoothReport as BoothReportAnswer,
} from '@oto/shared';
import { useSession } from '@/auth/SessionContext';
import { directoryApi, type BranchRow } from '@/api/platform';
import { boothReportApi } from '@/api/analytics';
import { CONTROL, Labelled } from '@/components/Filters';
import { ErrorNote, Loading } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip, TitleChip } from '@/components/redesign/chips';
import { CardShell, PageGrid, RailNote } from '@/components/redesign/layout';
import { EmptyNote, StatTile } from '@/components/redesign/StatTile';
import {
  boothReportTotals,
  prizeCostWords,
  redemptionLagWords,
  redemptionRateWords,
} from '@/lib/boothReportWords';
import { formatWhen, timeAgo } from '@/lib/time';

/**
 * Console > Booths > Report (S2-15b round 5; no prototype screen — the plan
 * defines it, §5 and question 14): what each booth's Lucky Wheel did over a
 * range of trading days, read from `analytics.fact_booth_daily` — spins,
 * prizes won, vouchers issued and redeemed, the redemption rate and lag, and
 * what the prizes cost where a cost is set. By booth, by prize and by the
 * names on the slip — today's roster, read from the spins (SCRUM-694; an older
 * box's signed-in account where there is one); the CSV carries every day,
 * booth, Staff row and prize. The `#debug` distribution run is never in it.
 */
export function BoothReport() {
  const working = useWorkingAuthority();
  const { me, permissions } = useSession();
  const authorityKey = JSON.stringify([working.epoch, me?.operatorContext, me?.account.id, me?.operatorContext.effectiveOperatorId, me?.branch?.id, me?.sessionLocked, permissions]);
  const authority = useRef({ key: authorityKey, epoch: 0 });
  if (authority.current.key !== authorityKey) authority.current = { key: authorityKey, epoch: authority.current.epoch + 1 };
  const authorityEpoch = authority.current.epoch;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [directory, setDirectory] = useState<{ epoch: number; branches: BranchRow[] } | null>(null);
  const branches = directory?.epoch === authorityEpoch ? directory.branches : [];
  /** '' is every branch this account reads analytics at. */
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');
  const picked = branches.find((b) => b.id === branchId);
  const timezone = picked?.timezone ?? me?.branch?.timezone ?? 'Asia/Bangkok';
  const dayStart = picked?.businessDayStart;
  // The trading day in progress, so the default range ends today at the park.
  const today = useMemo(
    () => businessDate(new Date(), timezone, dayStart ? parseDayStart(dayStart) : undefined),
    [timezone, dayStart],
  );
  const [from, setFrom] = useState(() => addDaysToIsoDate(today, -6));
  const [to, setTo] = useState(today);
  const [refresh, setRefresh] = useState(0);
  const queryKey = JSON.stringify([authorityEpoch, branchId, from, to, refresh]);
  const owner = useRef({ key: queryKey, epoch: 0 });
  if (owner.current.key !== queryKey) owner.current = { key: queryKey, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch;
  const [report, setReport] = useState<{ epoch: number; data: BoothReportAnswer | null; error: string | null } | null>(null);
  const data = report?.epoch === epoch ? report.data : null;
  const error = report?.epoch === epoch ? report.error : null;
  const [exporting, setExporting] = useState<{ epoch: number; pending: boolean } | null>(null);
  const downloading = exporting?.epoch === epoch && exporting.pending;
  const exportInFlight = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const current = () => active && working.isCurrent() && mounted.current && authority.current.epoch === authorityEpoch;
    void working.run(() => directoryApi
      .branches())
      .then((r) => { if (current()) setDirectory({ epoch: authorityEpoch, branches: r.branches.filter((b) => !b.archived) }); })
      .catch(() => { if (current()) setDirectory({ epoch: authorityEpoch, branches: [] }); });
    return () => { active = false; };
  }, [authorityEpoch, working.isCurrent, working.run]);

  useEffect(() => {
    if (!from || !to) return;
    let active = true;
    const current = () => active && working.isCurrent() && mounted.current && owner.current.epoch === epoch;
    setReport({ epoch, data: null, error: null });
    void working.run(() => boothReportApi
      .read({ branchId, from, to }))
      .then((answer) => {
        if (current()) setReport({ epoch, data: answer, error: null });
      })
      .catch((e: unknown) => {
        if (current()) setReport({ epoch, data: null, error: e instanceof Error ? e.message : 'Could not read the booth report.' });
      });
    return () => {
      active = false;
    };
  }, [epoch, branchId, from, to, working.isCurrent, working.run]);

  const download = async () => {
    if (!working.isCurrent() || exportInFlight.current === epoch) return;
    exportInFlight.current = epoch;
    setExporting({ epoch, pending: true });
    const current = () => working.isCurrent() && mounted.current && owner.current.epoch === epoch;
    try {
      const file = await working.run(() => boothReportApi.exportFile({ branchId, from, to }));
      if (!current()) return;
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename ?? 'booth-report.csv';
      try { link.click(); } finally { URL.revokeObjectURL(url); }
    } catch (e) {
      if (current()) setReport(held => ({ epoch, data: held?.epoch === epoch ? held.data : null, error: e instanceof Error ? e.message : 'The download failed.' }));
    } finally {
      if (exportInFlight.current === epoch) exportInFlight.current = null;
      if (current()) setExporting({ epoch, pending: false });
    }
  };

  const place = branchId ? branches.find((b) => b.id === branchId)?.name : 'All branches';
  const boothName = (id: string) => data?.booths.find((b) => b.boothId === id)?.name ?? 'Booth';

  return (
    <>
      <CommandBar
        sectionId="booth-report"
        place={place}
        badges={<TitleChip>the wheel’s funnel, by trading day</TitleChip>}
        actions={
          <>
            {branches.length > 1 && (
              <SelectChip
                label="Branch"
                showLabel
                value={branchId}
                anyLabel="All branches"
                onChange={setBranchId}
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
              />
            )}
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

      <CardShell>
        <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
          <Labelled label="From day">
            <input className={CONTROL} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Labelled>
          <Labelled label="To day">
            <input className={CONTROL} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Labelled>
        </div>
        <RailNote>
          By the park’s trading day. A voucher redeemed later counts on the day it was spun, so a recent day’s
          redemptions still grow. Test spins from the booth’s distribution check are never counted.
          {data && (
            <>
              {' '}
              {data.lastRolledUpAt
                ? `Figures brought up to date ${timeAgo(data.lastRolledUpAt)} (${formatWhen(data.lastRolledUpAt, timezone)}).`
                : 'The booth figures have not been rolled up yet.'}
            </>
          )}
        </RailNote>
      </CardShell>

      {error && <ErrorNote message={error} onRetry={() => setRefresh((n) => n + 1)} />}
      {!data && !error && <Loading what="the booth report" />}
      {data && (
        <PageGrid>
          <Totals funnel={boothReportTotals(data)} />
          {data.booths.length === 0 ? (
            <CardShell span={12}>
              <EmptyNote
                icon={FerrisWheel}
                title="No spins in these days"
                detail="No booth was spun at these branches between the two days. Widen the days, or choose another branch."
              />
            </CardShell>
          ) : (
            <>
              <CardShell span={12} title="By booth" note="the range added up">
                <FunnelTable
                  label="Booths"
                  first="Booth"
                  rows={data.booths.map((b) => ({ key: b.boothId, name: b.name, sub: b.branchName, funnel: b }))}
                />
              </CardShell>
              <CardShell span={12} title="By prize" note="what the wheel gave away, and what it cost">
                <FunnelTable
                  label="Prizes"
                  first="Prize"
                  rows={data.prizes.map((p) => ({
                    key: `${p.boothId}|${p.prizeId}`,
                    name: p.name,
                    sub: boothName(p.boothId),
                    funnel: p,
                  }))}
                />
              </CardShell>
              <CardShell span={12} title="By staff" note="the names on the slip (today’s roster)">
                <FunnelTable
                  label="Staff"
                  first="Staff"
                  rows={data.staff.map((s) => ({
                    key: `${s.boothId}|${s.accountId ?? ''}|${s.label ?? ''}`,
                    name: s.name,
                    sub: boothName(s.boothId),
                    funnel: s,
                  }))}
                />
              </CardShell>
            </>
          )}
        </PageGrid>
      )}
    </>
  );
}

function Totals({ funnel }: { funnel: BoothFunnel }) {
  return (
    <>
      <StatTile span={3} label="Spins" value={funnel.spins} detail={`${funnel.prizesWon} prizes won`} />
      <StatTile span={3} label="Vouchers issued" value={funnel.vouchersIssued} detail="slips that reached the platform" />
      <StatTile
        span={3}
        label="Redeemed"
        value={funnel.vouchersRedeemed}
        detail={`${redemptionRateWords(funnel.redemptionRate)} · typically ${redemptionLagWords(funnel.meanRedemptionLagS)} after the spin`}
      />
      <StatTile span={3} label="Prize cost" value={prizeCostWords(funnel)} detail="as costed when each prize was won" />
    </>
  );
}


function FunnelTable({
  label,
  first,
  rows,
}: {
  label: string;
  first: string;
  rows: Array<{ key: string; name: string; sub: string; funnel: BoothFunnel }>;
}) {
  return (
    <div role="table" aria-label={label} className="flex min-w-0 flex-col gap-1">
      <div
        role="row"
        className="hidden gap-3 px-3 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80 @2xl:grid @2xl:grid-cols-[minmax(0,1.6fr)_repeat(6,minmax(0,1fr))]"
      >
        <span role="columnheader">{first}</span>
        <span role="columnheader" className="text-right">Spins</span>
        <span role="columnheader" className="text-right">Prizes won</span>
        <span role="columnheader" className="text-right">Issued</span>
        <span role="columnheader" className="text-right">Redeemed</span>
        <span role="columnheader" className="text-right">Rate · lag</span>
        <span role="columnheader" className="text-right">Prize cost</span>
      </div>
      <div role="rowgroup" className="flex flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]">
        {rows.map((r) => (
          <div
            key={r.key}
            role="row"
            className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-[11px] text-[13.5px] @2xl:grid @2xl:grid-cols-[minmax(0,1.6fr)_repeat(6,minmax(0,1fr))] @2xl:items-start"
          >
            <span role="cell" className="min-w-0 basis-full break-words @2xl:basis-auto">
              <span className="font-semibold">{r.name}</span>
              <span className="block text-xs text-muted-foreground">{r.sub}</span>
            </span>
            <Num title="Spins">{r.funnel.spins}</Num>
            <Num title="Prizes won">{r.funnel.prizesWon}</Num>
            <Num title="Vouchers issued">{r.funnel.vouchersIssued}</Num>
            <Num title="Vouchers redeemed">{r.funnel.vouchersRedeemed}</Num>
            <Num title="Redemption rate and mean lag">
              {redemptionRateWords(r.funnel.redemptionRate)}
              <span className="block text-xs text-muted-foreground">{redemptionLagWords(r.funnel.meanRedemptionLagS)}</span>
            </Num>
            <Num title="Prize cost">{prizeCostWords(r.funnel)}</Num>
          </div>
        ))}
      </div>
    </div>
  );
}

function Num({ title, children }: { title: string; children: ReactNode }) {
  return (
    <span role="cell" title={title} className="min-w-[4.5rem] tabular-nums @2xl:text-right">
      {children}
    </span>
  );
}
