import { createAnalyticsReportsApi } from '@oto/admin-screens/lifted/api/analyticsReports';
import { createWalletAdminApi } from '@oto/admin-screens/lifted/api/wallet';
import { createVoucherPromotionsApi } from '@oto/admin-screens/lifted/api/voucherPromotions';
import { createWalletReportReader } from '@oto/admin-screens/lifted/lib/reporting';
import { apiUrl } from '@/api/client';
import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { SalesReportPanelWithPorts } from '@oto/admin-screens/lifted/admin/reports/SalesReportPanel';
import { ProfitabilityReportPanelWithPorts } from '@oto/admin-screens/lifted/admin/reports/ProfitabilityReportPanel';
import { DiscountCompReportPanelWithPorts } from '@oto/admin-screens/lifted/admin/reports/DiscountCompReportPanel';
import { TaxVatReportPanelWithPorts } from '@oto/admin-screens/lifted/admin/reports/TaxVatReportPanel';
import { WalletPromoReportPanelWithPorts } from '@oto/admin-screens/lifted/admin/reports/WalletPromoReportPanel';
import type { ReportFilters } from '@oto/admin-screens/lifted/lib/reporting';
import type { Discount } from '@oto/admin-screens/lifted/model/types';
import { reportsApi } from '@/api/reports';
import { useSession } from '@/auth/SessionContext';
import type { EffectivePermission, MeResponse } from '@/api/platform';
import { EmptyState, ErrorNote, Loading, Panel, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { AreaLanding } from '@/pages/AreaLanding';

type Page = 'sales' | 'profitability' | 'discounts' | 'tax-vat' | 'wallet-promo';
type Park = Awaited<ReturnType<typeof reportsApi.parks>>[number];

/** Every actor/authority lifetime owns a fresh host and its pending reports. */
export function Reports({ page }: { page: Page }) {
  const working = useWorkingAuthority();
  const { me, permissions, has } = useSession();
  if (!me || !has('analytics:read')) return <PermissionRequired permission="analytics:read" />;
  const contextKey = JSON.stringify([working.epoch, me?.operatorContext, me.account.id, me.operatorContext.effectiveOperatorId, me.branch?.id,
    permissions.map(row => [row.permission, row.scopeType, row.scopeId]).sort()]);
  return <ReportHost key={`${contextKey}:${page}`} me={me} permissions={permissions} page={page} contextKey={contextKey} />;
}

function ReportHost({ me, permissions, page, contextKey }: {
  me: MeResponse; permissions: EffectivePermission[]; page: Page; contextKey: string;
}) {
  const working = useWorkingAuthority();
  const transport = useMemo(() => ({ ...working.api, href: apiUrl }), [working.api]);
  const analytics = useMemo(() => createAnalyticsReportsApi(transport), [transport]);
  const wallet = useMemo(() => createWalletAdminApi(transport), [transport]);
  const vouchers = useMemo(() => createVoucherPromotionsApi(transport), [transport]);
  const [parks, setParks] = useState<Park[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [metadata, setMetadata] = useState<Discount[] | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const can = useCallback((permission: Permission, branchId?: string) => permissions.some(grant => grant.permission === permission && (
    grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === me.operatorContext.effectiveOperatorId) ||
    branchId !== undefined && grant.scopeType === 'branch' && grant.scopeId === branchId
  )), [permissions, me.operatorContext.effectiveOperatorId]);
  const canReadMetadata = can('catalog:menu:read', me.branch?.id);
  useEffect(() => {
    let live = true;
    setError(null);
    void working.run(() => reportsApi.parks()).then(rows => {
      if (working.isCurrent() && live) setParks(rows.filter(park => can('analytics:read', park.id)));
    }).catch((failure: unknown) => {
      if (working.isCurrent() && live) setError(failure instanceof Error ? failure.message : 'The report parks could not be read.');
    });
    return () => { live = false; };
  }, [refresh, can, working.run, working.isCurrent]);
  useEffect(() => {
    if (page !== 'wallet-promo' || !canReadMetadata) return;
    let live = true;
    setMetadata(null); setMetadataError(null);
    void working.run(() => reportsApi.discounts()).then(rows => { if (working.isCurrent() && live) setMetadata(rows); }).catch((failure: unknown) => {
      if (working.isCurrent() && live) setMetadataError(failure instanceof Error ? failure.message : 'Promo-code metadata could not be read.');
    });
    return () => { live = false; };
  }, [page, canReadMetadata, refresh, working.run, working.isCurrent]);
  const ports = useMemo(() => {
    const branches = parks ?? [];
    const clock = branches.find(park => park.id === me.branch?.id) ?? branches[0];
    if (!clock) return null;
    const today = clock.today;
    return {
      contextKey: `${contextKey}:${refresh}`,
      defaultFilters: (): ReportFilters => ({ startDate: `${today.slice(0, 8)}01`, endDate: today, branchId: 'all' }),
      branchOptions: branches.map(park => ({ id: park.id, name: park.name })),
      queryForFilters: (filters: ReportFilters) => filters.branchId === 'all'
        ? { from: filters.startDate, to: filters.endDate }
        : branches.some(park => park.id === filters.branchId)
          ? { branches: [filters.branchId], from: filters.startDate, to: filters.endDate } : null,
      api: analytics,
      walletReport: createWalletReportReader({ getBranches: () => branches.map(branch => ({ id: branch.id, apiId: branch.id })), getWalletReport: wallet.getWalletReport }),
      discountTransactions: analytics.discountTransactions,
      voucherReport: (query: Parameters<typeof reportsApi.voucherReport>[0]) => vouchers.report({ branchApiId: query.branches?.[0] ?? null, from: query.from, to: query.to }),
    };
  }, [parks, me.branch, contextKey, refresh, analytics, wallet, vouchers]);
  const metadataUnavailable = !canReadMetadata ? 'Promo-code metadata needs catalogue read access at the seated park.'
    : metadataError ? 'Promo-code metadata could not be loaded. ' + metadataError
      : metadata === null ? 'Loading promo-code metadata…' : undefined;
  return <>
    <CommandBar sectionId={`reports-${page}`} actions={<Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Refresh</Button>} />
    {error && <ErrorNote message={error} onRetry={() => setRefresh(value => value + 1)} />}
    {metadataError && <ErrorNote message={metadataError} onRetry={() => setRefresh(value => value + 1)} />}
    {parks === null ? !error && <Loading what="report parks" /> : !ports ?
      <EmptyState title="No readable report parks" detail="There is no active park on your analytics access." /> : <>
      {page === 'sales' && <SalesReportPanelWithPorts ports={ports} />}
      {page === 'profitability' && <ProfitabilityReportPanelWithPorts ports={ports} />}
      {page === 'discounts' && <DiscountCompReportPanelWithPorts ports={ports} />}
      {page === 'tax-vat' && <TaxVatReportPanelWithPorts ports={ports} />}
      {page === 'wallet-promo' && <WalletPromoReportPanelWithPorts ports={{ ...ports, discounts: metadata ?? [], metadataUnavailable }} />}
    </>}
  </>;
}

export function ReportsLanding() {
  const working = useWorkingAuthority();
  const { has, me, permissions } = useSession();
  const owner = JSON.stringify([working.epoch, me?.operatorContext, me?.account.id, me?.operatorContext.effectiveOperatorId, me?.branch?.id, permissions]);
  return <><AreaLanding id="reports" />{has('analytics:read') && has('app:radar:access') && <RadarTile key={owner} />}</>;
}

export function RadarTile() {
  const working = useWorkingAuthority();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <Panel title="Radar" description="Deep analysis, revenue planning and trends.">
    <Button disabled={pending} onClick={() => {
      if (!working.isCurrent() || pending) return;
      setPending(true); setError(null);
      void working.run(() => reportsApi.openRadar(() => working.isCurrent() && mounted.current)).catch((failure: unknown) => {
        if (!working.isCurrent() || !mounted.current) return;
        setError(failure instanceof Error ? failure.message : 'Radar could not be opened.');
        setPending(false);
      });
    }}>{pending ? 'Opening Radar…' : 'Open Radar'}</Button>
    {error && <div className="mt-3"><ErrorNote message={error} /></div>}
  </Panel>;
}
