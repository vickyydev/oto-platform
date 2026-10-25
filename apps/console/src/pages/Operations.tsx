import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { AdminNotifications, adminToast } from '@oto/admin-screens';
import { InventoryPanelWithPorts } from '@oto/admin-screens/lifted/admin/inventory/InventoryPanel';
import { MembersPanelWithPorts } from '@oto/admin-screens/lifted/admin/members/MembersPanel';
import { TierVerificationsPanelWithPorts } from '@oto/admin-screens/lifted/admin/members/TierVerificationsPanel';
import { WalletLookupPanelWithPorts } from '@oto/admin-screens/lifted/admin/wallets/WalletLookupPanel';
import { inventoryItemToStockBody, stockErrorWords } from '@oto/admin-screens/lifted/api/stock';
import { levelsToInventory, stockLocationToView } from '@oto/admin-screens/lifted/lib/stockPresentation';
import { createMembershipHelpers } from '@oto/admin-screens/lifted/lib/membership';
import type { InventoryItem, StockLocation, TierDef } from '@oto/admin-screens/lifted/model/types';
import { createOperationsApi } from '@/api/operations';
import { organisationApi } from '@/api/organisation';
import type { EffectivePermission, MeResponse } from '@/api/platform';
import { useSession, displayName } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';

export type OperationsPage = 'inventory' | 'members' | 'tier-verifications' | 'wallets';
type Park = { id: string; name: string };
const pagePermission: Record<OperationsPage, Permission | null> = {
  inventory: null, members: 'pos:member:update', 'tier-verifications': 'pos:member:read', wallets: 'pos:wallet:read',
};
const message = (error: unknown) => error instanceof Error ? error.message : 'The platform could not be reached.';
const at = (permissions: EffectivePermission[], operatorId: string, permission: Permission, branchId?: string) =>
  permissions.some(grant => grant.permission === permission && (grant.scopeType === 'operator' &&
    (grant.scopeId === null || grant.scopeId === operatorId) || branchId !== undefined && grant.scopeType === 'branch' && grant.scopeId === branchId));

/** The inherited Inventory offer has no additional business grant. Routes remain authority. */
export function Operations({ page }: { page: OperationsPage }) {
  const working = useWorkingAuthority();
  const { me, permissions, has, locked } = useSession();
  const key = JSON.stringify([working.epoch, me?.operatorContext, me?.account.id, me?.operatorContext.effectiveOperatorId, me?.branch?.id, locked, page,
    permissions.map(grant => [grant.permission, grant.scopeType, grant.scopeId]).sort()]);
  const owner = useRef({ key, epoch: 0 });
  if (owner.current.key !== key) owner.current = { key, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch;
  const isCurrent = useCallback(() => working.isCurrent() && owner.current.epoch === epoch, [epoch, working.isCurrent]);
  const permission = pagePermission[page];
  if (!me || locked || permission && !has(permission)) return <PermissionRequired permission={permission ?? 'app:console:access'} />;
  return <OperationsHost key={key} page={page} me={me} permissions={permissions} isCurrent={isCurrent} />;
}

function OperationsHost({ page, me, permissions, isCurrent }: {
  page: OperationsPage; me: MeResponse; permissions: EffectivePermission[]; isCurrent: () => boolean;
}) {
  const working = useWorkingAuthority();
  const fallback = useMemo(() => {
    const rows: Park[] = me.branch ? [{ id: me.branch.id, name: me.branch.name }] : [];
    for (const grant of permissions) if (grant.permission === 'pos:stock:read' && grant.scopeType === 'branch' && grant.scopeId && !rows.some(row => row.id === grant.scopeId)) {
      rows.push({ id: grant.scopeId, name: `Park ${grant.scopeId.slice(0, 8)}` });
    }
    return rows;
  }, [me.branch, permissions]);
  const [parks, setParks] = useState<Park[]>(fallback);
  const [parkId, setParkId] = useState(fallback[0]?.id ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([working.epoch, parkId, refresh]);
  const owner = useRef({ key, epoch: 0 });
  if (owner.current.key !== key) owner.current = { key, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch;
  const current = useCallback(() => working.isCurrent() && isCurrent() && owner.current.epoch === epoch, [isCurrent, epoch, working.isCurrent]);
  useEffect(() => {
    if (page !== 'inventory' || !permissions.some(grant => grant.permission === 'admin:branch:read')) return;
    let live = true;
    void working.run(() => organisationApi.branchesApi.list()).then(answer => {
      if (!working.isCurrent() || !live || !isCurrent()) return;
      const readable = answer.branches.filter(branch => !branch.archived && at(permissions, me.operatorContext.effectiveOperatorId, 'pos:stock:read', branch.id));
      const rows = fallback.map(park => ({ ...park }));
      for (const branch of readable) {
        const existing = rows.find(row => row.id === branch.id);
        if (existing) existing.name = branch.name; else rows.push({ id: branch.id, name: branch.name });
      }
      setParks(rows);
      setParkId(held => rows.some(row => row.id === held) ? held : rows[0]?.id ?? '');
    }).catch(() => { if (live && isCurrent()) setNotice('Park names could not be refreshed. The current park and your explicit park grants remain available.'); });
    return () => { live = false; };
  }, [page, permissions, me.operatorContext.effectiveOperatorId, isCurrent, fallback, working.run, working.isCurrent]);
  return <>
    <CommandBar sectionId={page} actions={<>
      {page === 'inventory' && parks.length > 0 && <SelectChip label="Park" value={parkId} onChange={setParkId}
        options={parks.map(park => ({ value: park.id, label: park.name }))} />}
      <Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Refresh</Button>
    </>} />
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {page === 'inventory' && !parkId ? <EmptyNote title="No park is available" detail="Select a park in your session or ask an administrator for the existing stock access." /> :
      <OperationsContent key={`${page}:${key}`} page={page} me={me} permissions={permissions} parkId={parkId} isCurrent={current} />}
    <AdminNotifications />
  </>;
}

type InventorySnapshot = { inventory: InventoryItem[]; locations: StockLocation[];
  menu: ReturnType<ReturnType<typeof createOperationsApi>['menu']['mapMenu']> | null };
function OperationsContent({ page, me, permissions, parkId, isCurrent }: {
  page: OperationsPage; me: MeResponse; permissions: EffectivePermission[]; parkId: string; isCurrent: () => boolean;
}) {
  const working = useWorkingAuthority();
  const mounted = useRef(false), reads = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  const current = useCallback(() => working.isCurrent() && mounted.current && isCurrent(), [isCurrent, working.isCurrent]);
  const reread = useRef<(branch: string) => Promise<void>>(async () => {});
  const api = useMemo(() => createOperationsApi(current, branch => reread.current(branch)), [current]);
  const [inventory, setInventory] = useState<InventorySnapshot | null>(null);
  const [tiers, setTiers] = useState<TierDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const can = useCallback((permission: Permission) => permissions.some(grant => grant.permission === permission), [permissions]);
  const canReadMenu = at(permissions, me.operatorContext.effectiveOperatorId, 'catalog:menu:read', parkId);
  const loadMenu = useCallback(async () => {
    if (!canReadMenu) {
      if (current()) setMetadataError('Catalogue choices need the existing menu-read access at this park. Item forms are unavailable; stock and locations still use their own server permissions.');
      return null;
    }
    try {
      const answer = await api.menu.menuApi.load(parkId);
      if (!current()) return null;
      setMetadataError(null); return api.menu.mapMenu(answer);
    } catch (failure) {
      if (current()) setMetadataError('Catalogue choices could not be read. Item forms are unavailable. ' + message(failure));
      return null;
    }
  }, [api, parkId, canReadMenu, current]);
  const loadStock = useCallback(async (includeMenu: boolean) => {
    const request = ++reads.current;
    const [levels, places, sellable, menu] = await Promise.all([
      api.stockLevels(parkId), api.stockLocations(parkId), api.sellableStock(parkId),
      includeMenu ? loadMenu() : Promise.resolve(null),
    ]);
    if (!current() || request !== reads.current) return;
    const items = levelsToInventory(levels, new Map(sellable.products.map(product => [product.productId, product])));
    setInventory(previous => ({ inventory: items, locations: places.locations.map(stockLocationToView), menu: includeMenu ? menu : previous?.menu ?? null }));
    setError(null);
  }, [api, parkId, current, loadMenu]);
  reread.current = async branch => {
    if (!current() || branch !== parkId) throw new Error('The selected park changed. Reopen Inventory.');
    try { await loadStock(false); } catch (failure) {
      if (current()) { setInventory(null); setError('Saved, but stock could not be read back. ' + message(failure)); }
    }
  };
  useEffect(() => {
    if (page === 'wallets') return;
    if (page === 'inventory') {
      void loadStock(true).catch(failure => { if (current()) setError(message(failure)); });
      return;
    }
    void api.tiers().then(answer => {
      if (!current()) return;
      if (page === 'members' && answer.tiers.length === 0) throw new Error('The tier configuration is empty. Members cannot be edited until the existing tier configuration is available.');
      setTiers([...answer.tiers].sort((a, b) => a.sortOrder - b.sortOrder));
    }).catch(failure => {
      if (!current()) return;
      if (page === 'tier-verifications') { setTiers([]); setMetadataError('Tier names could not be read. Recorded tier IDs remain visible. ' + message(failure)); }
      else setError('Member tier configuration could not be read. ' + message(failure));
    });
  }, [page, api, current, loadStock]);
  const membership = useMemo(() => createMembershipHelpers({ catalog: {
    getTier: id => tiers?.find(tier => tier.id === id), getDefaultTier: () => tiers?.find(tier => tier.isDefault) ?? tiers?.[0],
  } }), [tiers]);
  if (error) return <div role="alert"><ErrorNote message={error} /></div>;
  if (page === 'wallets') return <WalletLookupPanelWithPorts ports={{ ...api.walletApi, can, toast: (...args) => { if (working.isCurrent()) adminToast(...args); }, isCurrent: current }} />;
  if (page === 'inventory') return inventory ? <>
    {metadataError && <p role="status" className="text-sm text-muted-foreground">{metadataError}</p>}
    <InventoryPanelWithPorts ports={{ branch: { id: parkId, apiId: parkId }, stock: { ...inventory, error: null },
      merchItems: inventory.menu?.merchItems ?? [], addOns: inventory.menu?.addOns ?? [], menuItems: inventory.menu?.menuItems ?? [],
      catalogueReady: inventory.menu !== null, stockApi: api.stockApi, stockErrorWords, inventoryItemToStockBody,
      catalogueSizesOf: api.menu.catalogueSizesOf, isCurrent: current,
      reloadMenuInto: async () => { const menu = await loadMenu(); if (current()) setInventory(held => held ? { ...held, menu } : null); },
    }} />
  </> : <Loading what="inventory" />;
  if (tiers === null) return <Loading what="member tier configuration" />;
  return <>
    {metadataError && <p role="status" className="text-sm text-muted-foreground">{metadataError}</p>}
    {page === 'members' ? <MembersPanelWithPorts ports={{ membersApi: api.membersApi, toast: (...args) => { if (working.isCurrent()) adminToast(...args); },
      ...membership, getDefaultTier: () => tiers.find(tier => tier.isDefault) ?? tiers[0], verifiedTiers: () => tiers.filter(tier => tier.requiresVerification).map(tier => tier.id),
      operator: { id: me.account.id, name: displayName(me) }, can, isCurrent: current,
    }} /> : <TierVerificationsPanelWithPorts ports={{ membersApi: api.membersApi, toast: (...args) => { if (working.isCurrent()) adminToast(...args); }, tierLabel: membership.tierLabel, isCurrent: current }} />}
  </>;
}
