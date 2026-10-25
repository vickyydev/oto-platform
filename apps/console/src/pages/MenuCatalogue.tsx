import { createMenuApi } from '@oto/admin-screens/lifted/api/menu';
import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { AdminNotifications, adminToast } from '@oto/admin-screens';
import { MenuPanelWithPorts } from '@oto/admin-screens/lifted/admin/menu/MenuPanel';
import { CategoriesPanelWithPorts } from '@oto/admin-screens/lifted/admin/categories/CategoriesPanel';
import { ModifiersPanelWithPorts } from '@oto/admin-screens/lifted/admin/modifiers/ModifiersPanel';
import { MerchPanelWithPorts } from '@oto/admin-screens/lifted/admin/merch/MerchPanel';
import { createMenuHelpers } from '@oto/admin-screens/lifted/lib/menu';
import { formatWWPrice } from '@oto/admin-screens/lifted/lib/pricingMode';
import type { MappedMenu } from '@oto/admin-screens/lifted/api/menu';
import type { Discount, MerchItem } from '@oto/admin-screens/lifted/model/types';
import { createConsoleMenu, readMenuStock } from '@/api/menu';
import { organisationApi } from '@/api/organisation';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';

type Page = 'menu' | 'categories' | 'modifiers' | 'merch';
type Park = { id: string; code: string; name: string };
interface Snapshot extends MappedMenu {
  api: ReturnType<typeof createConsoleMenu>;
  discounts: Discount[];
  shownItems: MerchItem[];
  productBranches: Map<string, string | null>;
}

/** The native catalogue controls receive only this account's current park snapshot. */
export function MenuCatalogue({ page }: { page: Page }) {
  const working = useWorkingAuthority();
  const { me, permissions, has } = useSession();
  const allowed = has('catalog:menu:read');
  const [parks, setParks] = useState<Park[] | null>(null);
  const [parkId, setParkId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parksError, setParksError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0), mounted = useRef(false);
  const owner = me?.account.id, operatorId = me?.operatorContext.effectiveOperatorId;
  const authority = permissions.map(grant => [grant.permission, grant.scopeType, grant.scopeId].join(':')).sort().join('|');
  const active = useRef({ parkId, page, owner, authority });
  active.current = { parkId, page, owner, authority };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; };
  }, []);
  const can = useCallback((permission: Permission, branchId?: string) => permissions.some(grant =>
    grant.permission === permission && (
      (grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === operatorId)) ||
      (branchId !== undefined && grant.scopeType === 'branch' && grant.scopeId === branchId)
    )), [permissions, operatorId]);
  useEffect(() => {
    if (!working.isCurrent() || !allowed) return;
    let current = true;
    setParksError(null);
    const own = me?.branch;
    const read = has('admin:branch:read')
      ? working.run(() => organisationApi.branchesApi.list()).then(answer => answer.branches.filter(row => !row.archived))
      : Promise.resolve(own ? [own] : []);
    void read.then(rows => {
      if (!working.isCurrent() || !current) return;
      const reachable = rows.filter(row => can('catalog:menu:read', row.id));
      setParks(reachable);
      setParkId(previous => reachable.some(row => row.id === previous) ? previous
        : (reachable.find(row => row.id === own?.id)?.id ?? reachable[0]?.id ?? ''));
    }).catch((failure: unknown) => {
      if (working.isCurrent() && current) setParksError(failure instanceof Error ? failure.message : 'The parks could not be read.');
    });
    return () => { current = false; };
  }, [allowed, owner, me?.branch, has, can, refresh, working.isCurrent, working.run]);
  const reload = useCallback(async (saved = false) => {
    if (!working.isCurrent() || !allowed || !parkId) return;
    const request = ++epoch.current;
    const current = () => working.isCurrent() && mounted.current && request === epoch.current && active.current.parkId === parkId &&
      active.current.page === page && active.current.owner === owner && active.current.authority === authority;
    setError(null);
    try {
      const menu = createMenuApi(working.api);
      const [answer, discountAnswer, stock] = await Promise.all([
        menu.menuApi.load(parkId),
        page === 'categories' ? menu.menuApi.discounts() : Promise.resolve(null),
        page === 'merch' && can('pos:stock:read', parkId) ? working.run(() => readMenuStock(parkId)) : Promise.resolve(null),
      ]);
      const mapped = menu.mapMenu(answer);
      const stocks = new Map(stock?.products.map(row => [row.productId, row]) ?? []);
      const shownItems = mapped.merchItems.map(item => {
        const product = item.inventoryItemId ? stocks.get(item.inventoryItemId) : undefined;
        if (!product) return item;
        const next = { ...item, stock: product.sizes.reduce((sum, size) => sum + size.available, 0) };
        delete next.lowStockThreshold;
        const one = product.sizes.length === 1 ? product.sizes[0] : undefined;
        if (one?.lowStockThreshold != null) next.lowStockThreshold = one.lowStockThreshold;
        return next;
      });
      if (current()) setSnapshot({ ...mapped, api: menu, shownItems,
        discounts: discountAnswer ? menu.mapDiscounts(discountAnswer.discounts) : [],
        productBranches: new Map(answer.products.map(row => [row.id, row.branchId])),
      });
    } catch (failure) {
      if (current()) {
        setSnapshot(null);
        const message = failure instanceof Error ? failure.message : 'The catalogue could not be read.';
        setError(saved ? 'Saved, but the catalogue could not be refreshed. ' + message : message);
      }
      throw failure;
    }
  }, [allowed, parkId, page, owner, authority, can, working.isCurrent, working.api, working.run]);
  useEffect(() => {
    setSnapshot(null);
    void reload().catch(() => {});
    return () => { epoch.current++; };
  }, [reload]);
  const menuHelpers = useMemo(() => createMenuHelpers({ catalog: {
    getMenuCategories: () => snapshot?.categories ?? [], getModifierGroups: () => snapshot?.modifierGroups ?? [],
  } }), [snapshot]);
  const current = () => working.isCurrent() && mounted.current && active.current.parkId === parkId && active.current.page === page && active.current.owner === owner && active.current.authority === authority;
  const afterWrite = async (write: () => Promise<unknown>) => {
    if (!current()) throw new Error('The catalogue changed. Open the editor again.');
    await write();
    // A completed mutation stays completed when its subsequent read fails.
    if (current()) await reload(true).catch(() => {});
  };
  const canManage = can('catalog:menu:manage', parkId), canManageShared = can('catalog:menu:manage');
  const canManageItem = (item: { id: string }) => canManage && (snapshot?.productBranches.get(item.id) === parkId ||
    (snapshot?.productBranches.get(item.id) === null && canManageShared));
  const selected = parks?.find(park => park.id === parkId);
  if (!allowed) return <PermissionRequired permission="catalog:menu:read" />;
  return <>
    <CommandBar sectionId={page} actions={parks?.length ? <SelectChip label="Park" value={parkId}
      onChange={id => { if (id !== parkId) { epoch.current++; setSnapshot(null); setParkId(id); } }}
      options={parks.map(park => ({ value: park.id, label: park.name }))} /> : undefined} />
    {parksError && <ErrorNote message={parksError} onRetry={() => setRefresh(value => value + 1)} />}
    {error && <ErrorNote message={error} onRetry={() => void reload().catch(() => {})} />}
    {!parks && !parksError ? <Loading what="parks" /> : parks?.length === 0 ?
      <EmptyNote title="No parks here" detail="There is no reachable park to show a catalogue for." /> :
      snapshot && selected ? <div key={`${owner}:${parkId}:${page}:${authority}`}>
        {page === 'menu' && <MenuPanelWithPorts ports={{
          menuItems: snapshot.menuItems, menuCategories: snapshot.categories, modifierGroups: snapshot.modifierGroups, menuHelpers,
          branch: selected, apiBranchId: parkId, fileApi: snapshot.api.menuApi, formatWWPrice, toast: (...args) => { if (working.isCurrent()) adminToast(...args); },
          canCreate: canManage, canManageItem, canImport: can('catalog:menu:import', parkId), canExport: canManage,
          canManageInlineGroups: canManageShared,
          onImported: async () => { if (current()) await reload(true).catch(() => {}); },
          upsertMenuItem: item => afterWrite(() => snapshot.api.saveMenuItem(parkId, item, snapshot.menuItems.some(row => row.id === item.id), current)),
          deleteMenuItem: id => afterWrite(() => snapshot.api.menuApi.archiveProduct(parkId, id)),
          upsertInventoryItem: () => {}, deleteInventoryItem: () => {},
        }} />}
        {page === 'categories' && <CategoriesPanelWithPorts ports={{
          menuCategories: snapshot.categories, menuItems: snapshot.menuItems, discounts: snapshot.discounts, menuHelpers,
          canManage: canManageShared, authorityMessage: canManageShared ? undefined : 'Categories are shared by every park. Operator-wide access is needed to change them.',
          upsertMenuCategory: category => afterWrite(() => snapshot.categories.some(row => row.id === category.id)
            ? snapshot.api.menuApi.updateCategory(category.id, snapshot.api.categoryToApiBody(category))
            : snapshot.api.menuApi.createCategory(snapshot.api.categoryToApiBody(category))),
          deleteMenuCategory: id => afterWrite(() => snapshot.api.menuApi.archiveCategory(id)),
          upsertMenuItem: item => afterWrite(() => snapshot.api.saveMenuItem(parkId, item, true, current)),
        }} />}
        {page === 'modifiers' && <ModifiersPanelWithPorts ports={{
          modifierGroups: snapshot.modifierGroups, menuItems: snapshot.menuItems, canManage: canManageShared,
          authorityMessage: canManageShared ? undefined : 'Modifier groups are shared by every park. Operator-wide access is needed to change them.',
          upsertModifierGroup: group => afterWrite(() => snapshot.modifierGroups.some(row => row.id === group.id)
            ? snapshot.api.menuApi.updateModifierGroup(group.id, snapshot.api.modifierGroupToApiBody(group))
            : snapshot.api.menuApi.createModifierGroup(snapshot.api.modifierGroupToApiBody(group))),
          deleteModifierGroup: id => afterWrite(() => snapshot.api.menuApi.archiveModifierGroup(id)),
        }} />}
        {page === 'merch' && <MerchPanelWithPorts ports={{
          merchItems: snapshot.merchItems, shownItems: snapshot.shownItems, formatWWPrice, canCreate: canManage, canManageItem,
          upsertMerchItem: item => afterWrite(() => snapshot.merchItems.some(row => row.id === item.id)
            ? snapshot.api.menuApi.updateProduct(parkId, item.id, snapshot.api.merchItemToApiBody(item))
            : snapshot.api.menuApi.createProduct(parkId, snapshot.api.merchItemToApiBody(item))),
          deleteMerchItem: id => afterWrite(() => snapshot.api.menuApi.archiveProduct(parkId, id)),
          upsertInventoryItem: () => {}, deleteInventoryItem: () => {},
        }} />}
      </div> : !error && !parksError && parkId ? <Loading what="catalogue" /> : null}
    <AdminNotifications />
  </>;
}
