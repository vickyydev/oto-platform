import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { TicketsPanelWithPorts } from '@oto/admin-screens/lifted/admin/tickets/TicketsPanel';
import { MarketsTiersSectionWithPorts } from '@oto/admin-screens/lifted/admin/markets-tiers/MarketsTiersSection';
import { AddOnsPanelWithPorts } from '@oto/admin-screens/lifted/admin/addons/AddOnsPanel';
import { createTicketPricingHelpers } from '@oto/admin-screens/lifted/admin-helpers/tickets/ticketPricing';
import { createMembershipHelpers } from '@oto/admin-screens/lifted/lib/membership';
import { formatWWPrice } from '@oto/admin-screens/lifted/lib/pricingMode';
import { isTierPriced } from '@oto/admin-screens/lifted/lib/pricing';
import { apiPackageToTicketType, ticketTypeToApiBody } from '@oto/admin-screens/lifted/api/mappers';
import type { AddOn, TicketType, TierDef } from '@oto/admin-screens/lifted/model/types';
import { catalogueApi, createCatalogueMenu } from '@/api/catalogue';
import { organisationApi } from '@/api/organisation';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';

type Page = 'tickets' | 'tiers' | 'add-ons';
type Park = { id: string; code: string; name: string };
type Menu = ReturnType<typeof createCatalogueMenu>;
interface Snapshot {
  tiers: TierDef[];
  tickets: TicketType[];
  addOns: AddOn[];
  menu: Menu;
  productBranches: Map<string, string | null>;
}

/** The host owns only the canonical records these three panels actually read. */
export function Catalogue({ page }: { page: Page }) {
  const { me, permissions, has } = useSession();
  const readPermission: Permission = page === 'add-ons' ? 'catalog:menu:read' : 'catalog:package:read';
  const allowed = has(readPermission);
  const [parks, setParks] = useState<Park[] | null>(null);
  const [parkId, setParkId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parksError, setParksError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const active = useRef({ parkId, page, accountId: me?.account.id });
  active.current = { parkId, page, accountId: me?.account.id };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; };
  }, []);
  const operatorId = me?.account.operatorId;
  const can = useCallback((permission: Permission, branchId?: string) => permissions.some((grant) =>
    grant.permission === permission && (
      (grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === operatorId)) ||
      (branchId !== undefined && grant.scopeType === 'branch' && grant.scopeId === branchId)
    )), [permissions, operatorId]);

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    setParksError(null);
    const own = me?.branch;
    const read = has('admin:branch:read')
      ? organisationApi.branchesApi.list().then(({ branches }) => branches.filter((row) => !row.archived))
      : Promise.resolve(own ? [own] : []);
    void read.then((rows) => {
      if (!current) return;
      const reachable = rows.filter((row) => can(readPermission, row.id));
      setParks(reachable);
      setParkId((previous) => reachable.some((row) => row.id === previous) ? previous
        : (reachable.find((row) => row.id === own?.id)?.id ?? reachable[0]?.id ?? ''));
    }).catch((failure: unknown) => {
      if (current) setParksError(failure instanceof Error ? failure.message : 'The parks could not be read.');
    });
    return () => { current = false; };
  }, [allowed, me?.account.id, me?.branch, has, can, readPermission, refresh]);

  const reload = useCallback(async (saved = false) => {
    if (!allowed || !parkId) return;
    const request = ++epoch.current;
    const owner = me?.account.id;
    setError(null);
    try {
      // A separate cache per read prevents an old park's completion replacing
      // the hidden fields used by a newer park's product editor.
      const menu = createCatalogueMenu();
      const [tierAnswer, ticketAnswer, menuAnswer] = await Promise.all([
        page === 'add-ons' ? Promise.resolve(null) : catalogueApi.tiers(),
        page === 'add-ons' ? Promise.resolve(null) : catalogueApi.packages(parkId),
        page === 'tiers' || !can('catalog:menu:read', parkId) ? Promise.resolve(null) : menu.menuApi.load(parkId),
      ]);
      const mapped = menuAnswer ? menu.mapMenu(menuAnswer) : null;
      if (mounted.current && request === epoch.current && active.current.parkId === parkId &&
        active.current.page === page && active.current.accountId === owner) {
        setSnapshot({ tiers: tierAnswer?.tiers ?? [], tickets: ticketAnswer?.packages.map(apiPackageToTicketType) ?? [],
          addOns: mapped?.addOns ?? [], menu,
          productBranches: new Map(menuAnswer?.products.map((row) => [row.id, row.branchId]) ?? []),
        });
      }
    } catch (failure) {
      if (mounted.current && request === epoch.current && active.current.parkId === parkId &&
        active.current.page === page && active.current.accountId === owner) {
        setSnapshot(null);
        const message = failure instanceof Error ? failure.message : 'The catalogue could not be read.';
        setError(saved ? 'Saved, but the catalogue could not be refreshed. ' + message : message);
      }
      throw failure;
    }
  }, [allowed, parkId, page, me?.account.id, can]);

  useEffect(() => {
    setSnapshot(null);
    void reload().catch(() => {});
    return () => { epoch.current++; };
  }, [reload]);

  const membership = useMemo(() => createMembershipHelpers({ catalog: {
    getTier: (id) => snapshot?.tiers.find((row) => row.id === id),
    getDefaultTier: () => snapshot?.tiers.find((row) => row.isDefault),
  } }), [snapshot?.tiers]);
  const ticketPricing = useMemo(() => createTicketPricingHelpers({
    catalog: { getTiers: () => snapshot?.tiers ?? [] }, membership,
    pricingMode: { formatWWPrice },
  }), [snapshot?.tiers, membership]);
  const owner = me?.account.id;
  const afterWrite = async (write: () => Promise<unknown>) => {
    if (!mounted.current || active.current.parkId !== parkId || active.current.page !== page || active.current.accountId !== owner) {
      throw new Error('The catalogue changed. Open the editor again.');
    }
    await write();
    if (mounted.current && active.current.parkId === parkId && active.current.page === page && active.current.accountId === owner) {
      // The committed mutation is complete. Only this read's own epoch may
      // show its refresh failure; retrying the page must never repeat the write.
      await reload(true).catch(() => {});
    }
  };

  if (!allowed) return <PermissionRequired permission={readPermission} />;
  return <>
    <CommandBar sectionId={page} actions={parks && parks.length > 0 ? <SelectChip label="Park" value={parkId}
      onChange={(id) => { if (id !== parkId) { epoch.current++; setSnapshot(null); setParkId(id); } }}
      options={parks.map((park) => ({ value: park.id, label: park.name }))} /> : undefined} />
    {parksError && <ErrorNote message={parksError} onRetry={() => setRefresh((value) => value + 1)} />}
    {error && <ErrorNote message={error} onRetry={() => void reload().catch(() => {})} />}
    {!parks && !parksError ? <Loading what="parks" /> : parks?.length === 0 ?
      <EmptyNote title="No parks here" detail="There is no reachable park to show a catalogue for." /> :
      snapshot ? <div key={`${owner}:${parkId}:${page}`}>
        {page === 'tickets' ? snapshot.tiers.some((row) => row.isDefault) ? <TicketsPanelWithPorts ports={{
          ticketTypes: snapshot.tickets, addOns: snapshot.addOns, tiers: snapshot.tiers,
          defaultTier: snapshot.tiers.find((row) => row.isDefault), ticketPricing, formatWWPrice,
          isDefaultTier: membership.isDefaultTier, tierLabel: membership.tierLabel,
          canCreate: can('catalog:package:create', parkId), canUpdate: can('catalog:package:update', parkId),
          upsertTicketType: (ticket) => afterWrite(() => snapshot.tickets.some((row) => row.id === ticket.id)
            ? catalogueApi.updatePackage(parkId, ticket.id, ticketTypeToApiBody(ticket))
            : catalogueApi.createPackage(parkId, ticketTypeToApiBody(ticket))),
          deleteTicketType: (id) => afterWrite(() => catalogueApi.archivePackage(parkId, id)),
        }} /> : <EmptyNote title="No default tier" detail="A default customer tier must be configured before editing ticket prices." /> : null}
        {page === 'tiers' ? <MarketsTiersSectionWithPorts ports={{
          tiers: snapshot.tiers, ticketTypes: snapshot.tickets, isTierPriced,
          countTierUsage: (id) => snapshot.tickets.filter((ticket) => ticket.prices[id] !== undefined).length,
          canCreate: can('catalog:package:create'), canUpdate: can('catalog:package:update'),
          upsertTier: (tier) => afterWrite(() => snapshot.tiers.some((row) => row.id === tier.id)
            ? catalogueApi.updateTier(tier.id, tier)
            : catalogueApi.createTier({ ...tier, code: tier.id })),
          deleteTier: (id) => afterWrite(() => catalogueApi.deleteTier(id)),
        }} /> : null}
        {page === 'add-ons' ? <AddOnsPanelWithPorts ports={{
          addOns: snapshot.addOns, formatWWPrice, canManage: can('catalog:menu:manage', parkId),
          canManageAddOn: (addOn) => snapshot.productBranches.get(addOn.id) === parkId ||
            (snapshot.productBranches.get(addOn.id) === null && can('catalog:menu:manage')),
          upsertAddOn: (addOn) => afterWrite(() => snapshot.addOns.some((row) => row.id === addOn.id)
            ? snapshot.menu.menuApi.updateProduct(parkId, addOn.id, snapshot.menu.addOnToApiBody(addOn))
            : snapshot.menu.menuApi.createProduct(parkId, snapshot.menu.addOnToApiBody(addOn))),
          deleteAddOn: (id) => afterWrite(() => snapshot.menu.menuApi.archiveProduct(parkId, id)),
          // The inherited Track stock-on placeholder has no platform stock link.
          // Stock links are still removed by the original mapper on stock-off.
          upsertInventoryItem: () => {}, deleteInventoryItem: () => {},
        }} /> : null}
      </div> : !error && !parksError && parkId ? <Loading what="catalogue" /> : null}
  </>;
}
