import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventDropInPricing } from '@oto/shared';
import type { Permission } from '@oto/shared/permissions';
import { AdminNotifications, adminToast } from '@oto/admin-screens';
import { DiscountCodesSectionWithPorts } from '@oto/admin-screens/lifted/admin/discounts/DiscountCodesSection';
import { DiscountReasonsSectionWithPorts } from '@oto/admin-screens/lifted/admin/discounts/DiscountReasonsSection';
import { PaymentMethodsSectionWithPorts } from '@oto/admin-screens/lifted/admin/payments/PaymentMethodsSection';
import { TaxPanelWithPorts } from '@oto/admin-screens/lifted/admin/tax/TaxPanel';
import { EventsPanelWithPorts } from '@oto/admin-screens/lifted/admin/events/EventsPanel';
import { VoucherPromotionsPanelWithPorts } from '@oto/admin-screens/lifted/admin/vouchers/VoucherPromotionsPanel';
import { createDiscountTargetLabel } from '@oto/admin-screens/lifted/lib/discountTarget';
import { createPaymentsHelpers } from '@oto/admin-screens/lifted/lib/payments';
import { formatWWPrice } from '@oto/admin-screens/lifted/lib/pricingMode';
import { blankTaxConfig, toSatang, engineTaxConfig, breakdownToBaht } from '@oto/admin-screens/lifted/lib/taxPresentation';
import type { Discount, PaymentMethod, TaxConfig } from '@oto/admin-screens/lifted/model/types';
import type { DiscountTargetOptions, VoucherLinkOptions } from '@oto/admin-screens/lifted/money';
import type { VoucherCampaignRow, VoucherDefinitionRow } from '@oto/admin-screens/lifted/api/voucherPromotions';
import { createConsoleMoney } from '@/api/money';
import { organisationApi } from '@/api/organisation';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';

export type MoneyPage = 'discounts' | 'tenders' | 'tax' | 'voucher-campaigns' | 'event-pricing';
type Park = { id: string; name: string; code: string };
const readPermission: Record<MoneyPage, Permission> = {
  discounts: 'catalog:menu:read', tenders: 'catalog:menu:read', tax: 'catalog:tax:read',
  'voucher-campaigns': 'admin:booth:read', 'event-pricing': 'pos:event:read',
};
interface Snapshot {
  contextVersion: number;
  api: ReturnType<typeof createConsoleMoney>;
  discounts: Discount[];
  discountIds: Map<string, string>;
  methods: PaymentMethod[];
  attempts: Map<string, number>;
  targets: DiscountTargetOptions;
  merchItems: ReturnType<ReturnType<typeof createConsoleMoney>['menu']['mapMenu']>['merchItems'];
  taxConfig: TaxConfig | null;
  pricing: EventDropInPricing | null;
  definitions: VoucherDefinitionRow[];
  campaigns: VoucherCampaignRow[];
  links: VoucherLinkOptions;
  categories: { id: string; name: string }[];
  notice: string | null;
}
const taxEngine = { toSatang, engineTaxConfig, breakdownToBaht };
const messageOf = (failure: unknown) => failure instanceof Error ? failure.message : 'The money settings could not be read.';

/** Native money controls bound to one authenticated snapshot and its canonical reads. */
export function Money({ page }: { page: MoneyPage }) {
  const { me, permissions, has } = useSession();
  const permission = readPermission[page], allowed = has(permission), parkRequired = page === 'tax' || page === 'event-pricing';
  const owner = me?.account.id, operatorId = me?.account.operatorId;
  const authority = permissions.map(grant => [grant.permission, grant.scopeType, grant.scopeId].join(':')).sort().join('|');
  const [parks, setParks] = useState<Park[] | null>(null), [parkId, setParkId] = useState('');
  const [storedSnapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState<string | null>(null);
  const [parksError, setParksError] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const mounted = useRef(false), requests = useRef(0);
  const contextKey = [owner, operatorId, authority, page, parkId].join('|');
  const active = useRef({ key: contextKey, version: 0 });
  if (active.current.key !== contextKey) active.current = { key: contextKey, version: active.current.version + 1 };
  const version = active.current.version;
  const snapshot = storedSnapshot?.contextVersion === version ? storedSnapshot : null;
  const current = useCallback(() => mounted.current && active.current.version === version, [version]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requests.current++; }; }, []);
  useEffect(() => { setReasons([]); }, [owner]);
  const can = useCallback((held: Permission, branchId?: string) => permissions.some(grant => grant.permission === held && (
    grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === operatorId) ||
    branchId !== undefined && grant.scopeType === 'branch' && grant.scopeId === branchId
  )), [permissions, operatorId]);

  useEffect(() => {
    if (!allowed) return;
    if (page === 'tenders') { setParks([]); setParksError(null); return; }
    let live = true;
    setParks(null); setParksError(null);
    const own = me?.branch;
    const read = has('admin:branch:read') ? organisationApi.branchesApi.list().then(answer => answer.branches.filter(row => !row.archived)) : Promise.resolve(own ? [own] : []);
    void read.then(rows => {
      if (!live) return;
      const reachable = rows.filter(row => can(permission, row.id));
      setParks(reachable);
      setParkId(previous => reachable.some(row => row.id === previous) ? previous : reachable.find(row => row.id === own?.id)?.id ?? reachable[0]?.id ?? '');
    }).catch(failure => { if (live) setParksError(messageOf(failure)); });
    return () => { live = false; };
  }, [allowed, page, permission, owner, me?.branch, has, can, refresh]);

  const reload = useCallback(async (saved = false) => {
    if (!allowed || parkRequired && !parkId) return;
    const request = ++requests.current, live = () => current() && request === requests.current;
    setError(null);
    const api = createConsoleMoney();
    const next: Snapshot = { contextVersion: version, api, discounts: [], discountIds: new Map(), methods: [], attempts: new Map(),
      targets: { ticketTypes: [], addOns: [], menuItems: [], menuCategories: [] }, merchItems: [], taxConfig: null,
      pricing: null, definitions: [], campaigns: [], links: { products: [], packages: [] }, categories: [], notice: null };
    let discountRows: Parameters<typeof api.menu.mapDiscounts>[0] = [];
    try {
      if (page === 'discounts') {
        const answer = await api.menu.menuApi.discounts();
        discountRows = answer.discounts;
        next.discounts = api.menu.mapDiscounts(answer.discounts);
        next.discountIds = new Map(answer.discounts.map(row => [row.code, row.id]));
      } else if (page === 'tenders') {
        const answer = await api.catalogApi.paymentMethods();
        next.methods = api.mapPaymentMethods(answer.methods);
        next.attempts = new Map(answer.methods.map(row => [row.id, row.attempts]));
      } else if (page === 'tax') next.taxConfig = (await api.catalogApi.taxConfig(parkId)).config;
      else if (page === 'event-pricing') next.pricing = (await api.eventsApi.dropInPricing(parkId)).pricing;
      else {
        const [definitions, campaigns] = await Promise.all([api.voucherPromotionsApi.definitions(), api.voucherPromotionsApi.campaigns()]);
        next.definitions = definitions.definitions; next.campaigns = campaigns.campaigns;
      }
      if (!live()) return;
      setSnapshot(next);
      // Picker failures must not erase valid money records. Each read owns this request epoch.
      if (page === 'discounts' || page === 'voucher-campaigns') void (async () => {
        const notices: string[] = [];
        const choices = await Promise.allSettled([
          parkId && can('catalog:menu:read', parkId) ? api.menu.menuApi.load(parkId) : Promise.resolve(null),
          page === 'discounts' && parkId && can('catalog:package:read', parkId) ? api.catalogApi.packages(parkId) : Promise.resolve(null),
          page === 'voucher-campaigns' ? api.voucherLinkOptions() : Promise.resolve(null),
        ]);
        if (!live()) return;
        const enriched = { ...next, targets: { ...next.targets } };
        const [menu, packages, links] = choices;
        if (menu.status === 'fulfilled' && menu.value) {
          const mapped = api.menu.mapMenu(menu.value);
          enriched.targets = { ...enriched.targets, addOns: mapped.addOns, menuItems: mapped.menuItems, menuCategories: mapped.categories };
          enriched.merchItems = mapped.merchItems; enriched.categories = mapped.categories;
          if (page === 'discounts') {
            enriched.discounts = api.menu.mapDiscounts(discountRows);
            if (discountRows.some(row => row.kind === 'free_item' && row.freeProductId && !api.menu.serverFieldsFor(row.freeProductId)?.kind)) notices.push('Some free-item product details are not available in this park. Those discounts cannot be edited until their product details can be read.');
          }
        } else if (menu.status === 'rejected') notices.push('Menu choices could not be read. ' + messageOf(menu.reason));
        if (packages.status === 'fulfilled' && packages.value) enriched.targets.ticketTypes = packages.value.packages.map(api.apiPackageToTicketType);
        else if (packages.status === 'rejected') notices.push('Ticket choices could not be read. ' + messageOf(packages.reason));
        if (links.status === 'fulfilled' && links.value) enriched.links = links.value;
        else if (links.status === 'rejected') notices.push('Voucher target choices could not be read. ' + messageOf(links.reason));
        enriched.notice = notices.length ? notices.join(' ') : null;
        if (live()) setSnapshot(enriched);
      })();
    } catch (failure) {
      if (live()) { setSnapshot(null); setError((saved ? 'Saved, but the money settings could not be refreshed. ' : '') + messageOf(failure)); }
      throw failure;
    }
  }, [allowed, parkRequired, parkId, page, current, can, version]);
  useEffect(() => { setSnapshot(null); void reload().catch(() => {}); return () => { requests.current++; }; }, [reload]);

  const afterWrite = async <T,>(write: () => Promise<T>): Promise<T> => {
    if (!current()) throw new Error('The money settings changed. Open the editor again.');
    const answer = await write();
    if (current()) await reload(true).catch(() => {});
    return answer;
  };
  const mutate = async (write: () => Promise<unknown>) => { await afterWrite(write); };
  const unsavedTaxConfig = useMemo(blankTaxConfig, []);
  const payments = useMemo(() => createPaymentsHelpers({ catalog: { getPaymentMethods: () => snapshot?.methods ?? [] } }), [snapshot?.methods]);
  const formatDiscountTargetLabel = useMemo(() => createDiscountTargetLabel({
    getTicketTypes: () => snapshot?.targets.ticketTypes ?? [], getAddOns: () => snapshot?.targets.addOns ?? [],
    getMenuItems: () => snapshot?.targets.menuItems ?? [], getMenuCategories: () => snapshot?.targets.menuCategories ?? [],
  }), [snapshot?.targets]);
  const canManageGlobal = can('catalog:menu:manage'), canManageRules = can('admin:booth:manage');
  const canEditDiscount = (discount: Discount) => discount.type !== 'free_item' || !discount.freeItemId || Boolean(snapshot?.api.menu.serverFieldsFor(discount.freeItemId)?.kind);
  const sharedMessage = 'These settings are shared by every park. Operator-wide access is needed to change them.';
  if (!allowed) return <PermissionRequired permission={permission} />;
  return <>
    <CommandBar sectionId={page} actions={page !== 'tenders' && page !== 'voucher-campaigns' && parks?.length ? <SelectChip label="Park" value={parkId}
      onChange={id => { if (id !== parkId) { requests.current++; setSnapshot(null); setParkId(id); } }}
      options={parks.map(park => ({ value: park.id, label: park.name }))} /> : undefined} />
    {parksError && <ErrorNote message={parksError} onRetry={() => setRefresh(value => value + 1)} />}
    {error && <ErrorNote message={error} onRetry={() => void reload().catch(() => {})} />}
    {snapshot?.notice && <ErrorNote message={snapshot.notice} onRetry={() => void reload().catch(() => {})} />}
    {parkRequired && parks?.length === 0 ? <EmptyNote title="No parks here" detail="There is no reachable park to show these settings for." /> :
      snapshot ? <div key={contextKey} className="flex flex-col gap-6">
        {page === 'discounts' && <>
          <DiscountCodesSectionWithPorts ports={{ discounts: snapshot.discounts, menuItems: snapshot.targets.menuItems, merchItems: snapshot.merchItems,
            targetOptions: snapshot.targets, formatWWPrice, formatDiscountTargetLabel, canManage: canManageGlobal, canEditDiscount,
            authorityMessage: canManageGlobal ? undefined : sharedMessage,
            upsertDiscount: (discount, originalCode) => mutate(() => snapshot.api.saveDiscount(discount, originalCode)),
            deleteDiscount: code => mutate(() => { const id = snapshot.discountIds.get(code); if (!id) throw new Error('The discount code is no longer in this snapshot. Refresh the page.'); return snapshot.api.menu.menuApi.archiveDiscount(id); }),
          }} />
          <p className="text-sm text-muted-foreground">Manual-discount reasons below stay in this tab only.</p>
          <DiscountReasonsSectionWithPorts ports={{ discountReasons: reasons, setDiscountReasons: setReasons }} />
        </>}
        {page === 'tenders' && <PaymentMethodsSectionWithPorts ports={{ paymentMethods: snapshot.methods,
          normalizePaymentMethod: payments.normalizePaymentMethod, paymentMethodIcon: payments.paymentMethodIcon,
          paymentMethodUsage: id => snapshot.attempts.get(payments.normalizePaymentMethod(id)) ?? 0,
          canManage: canManageGlobal, authorityMessage: canManageGlobal ? undefined : sharedMessage,
          upsertPaymentMethod: method => mutate(() => snapshot.api.saveTender(method, snapshot.methods.some(row => row.id === method.id))),
          deletePaymentMethod: id => mutate(() => snapshot.api.catalogApi.deletePaymentMethod(id)),
          movePaymentMethod: (id, direction) => mutate(() => snapshot.api.catalogApi.movePaymentMethod(id, direction)),
        }} />}
        {page === 'tax' && <>
          {snapshot.taxConfig === null && <p className="text-sm text-muted-foreground">No tax configuration is stored for this park. This is the original unsaved template; Save changes records it.</p>}
          <TaxPanelWithPorts ports={{ taxConfig: snapshot.taxConfig ?? unsavedTaxConfig, taxEngine,
            canManage: can('catalog:tax:manage', parkId), updateTaxConfig: config => mutate(() => snapshot.api.catalogApi.putTaxConfig(parkId, config)),
          }} />
        </>}
        {page === 'event-pricing' && <EventsPanelWithPorts ports={{ pricing: snapshot.pricing,
          canManage: can('admin:event_pricing:manage', parkId), savePricing: async pricing => (await afterWrite(() => snapshot.api.eventsApi.saveDropInPricing(parkId, pricing))).pricing,
        }} />}
        {page === 'voucher-campaigns' && <VoucherPromotionsPanelWithPorts ports={{
          definitions: snapshot.definitions, campaigns: snapshot.campaigns, links: snapshot.links, categories: snapshot.categories,
          branches: (parks ?? []).map(park => ({ ...park, apiId: park.id })), toast: adminToast,
          canManageRules, canMintCampaign: id => can('admin:booth:manage', id), canDownloadCodes: campaign => can('admin:booth:manage', campaign.branchId),
          authorityMessage: canManageRules ? undefined : 'Operator-wide access is needed to change voucher rules. Campaign actions use their own park access.',
          saveRules: (id, patch) => mutate(() => snapshot.api.voucherPromotionsApi.saveRules(id, patch)),
          mintCampaign: (input, idempotencyKey) => mutate(() => snapshot.api.voucherPromotionsApi.mintCampaign(input, idempotencyKey)),
          codesHref: snapshot.api.voucherPromotionsApi.codesHref,
        }} />}
      </div> : !error && (!parkRequired || parks?.length !== 0) ? <Loading what="money settings" /> : null}
    <AdminNotifications />
  </>;
}
