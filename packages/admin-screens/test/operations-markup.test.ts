import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LiftedAdminApi } from '../src/api/lifted-api';
import { createPlatformAdminApi } from '../src/lifted/api/platform';
import { createStockAdminApi, inventoryItemToStockBody, stockErrorWords } from '../src/lifted/api/stock';
import { createWalletAdminApi } from '../src/lifted/api/wallet';
import { InventoryPanelWithPorts } from '../src/lifted/components/admin/inventory/InventoryPanel';
import { MembersPanelWithPorts } from '../src/lifted/components/admin/members/MembersPanel';
import { TierVerificationsPanelWithPorts } from '../src/lifted/components/admin/members/TierVerificationsPanel';
import { WalletLookupPanelWithPorts } from '../src/lifted/components/admin/wallets/WalletLookupPanel';
import type { InventoryPanelPorts } from '../src/lifted/runtime/operations';

const unexpected = vi.fn(async () => { throw new Error('Rendering cannot make a platform request.'); });
const transport: LiftedAdminApi = { href: path => path, get: unexpected, post: unexpected, put: unexpected,
  patch: unexpected, delete: unexpected, deleteWithBody: unexpected, getBlob: unexpected, postBlob: unexpected, getFile: unexpected };
const { membersApi } = createPlatformAdminApi(transport);
const wallet = createWalletAdminApi(transport);
const { stockApi } = createStockAdminApi(transport, { writeThenRead: async (_branch, write) => write() });
const inventory: InventoryPanelPorts = { branch: { id: 'zz-park', apiId: 'zz-park' },
  stock: { inventory: [{ id: 'zz-item', name: 'ZZ TEST Native inventory', linkedKind: 'merch', linkedId: 'zz-product',
    variants: [{ id: 'zz-size', label: 'Default', stock: 7 }] }], locations: [], error: null },
  merchItems: [], addOns: [], menuItems: [], stockApi, inventoryItemToStockBody, stockErrorWords,
  catalogueSizesOf: () => [], reloadMenuInto: async () => {}, catalogueReady: true };

describe('native operations render with their narrow host capabilities', () => {
  it('renders the inherited item counts and actions without a full runtime or platform read', () => {
    const html = renderToStaticMarkup(createElement(InventoryPanelWithPorts, { ports: inventory }));
    expect(html).toContain('ZZ TEST Native inventory'); expect(html).toContain('New item'); expect(html).toContain('Adjust');
    expect(html).toContain('Locations'); expect(html).toContain('7'); expect(unexpected).not.toHaveBeenCalled();
  });
  it('keeps real stock visible while disabling item editors when catalogue choices are unavailable', () => {
    const html = renderToStaticMarkup(createElement(InventoryPanelWithPorts, { ports: { ...inventory, catalogueReady: false } }));
    expect(html).toContain('ZZ TEST Native inventory');
    expect(html).toMatch(/<button\b[^>]*disabled=""[^>]*>[\s\S]*?New item<\/button>/);
    expect(html).toMatch(/<button\b[^>]*aria-label="Edit ZZ TEST Native inventory"[^>]*disabled=""/);
    expect(unexpected).not.toHaveBeenCalled();
  });
  it('renders member, verification and wallet entry states without acquiring unrelated runtime data', () => {
    const toast = vi.fn(), tier = { id: 'regular', name: 'ZZ TEST Regular', isDefault: true, requiresVerification: false, sortOrder: 0 };
    const members = renderToStaticMarkup(createElement(MembersPanelWithPorts, { ports: { membersApi, toast,
      getDefaultTier: () => tier, tierLabel: id => id, isDefaultTier: id => id === tier.id, verifiedTiers: () => [], operator: null, can: () => false } }));
    const records = renderToStaticMarkup(createElement(TierVerificationsPanelWithPorts, { ports: { membersApi, toast, tierLabel: id => id } }));
    const lookup = renderToStaticMarkup(createElement(WalletLookupPanelWithPorts, { ports: { ...wallet, toast, can: () => false } }));
    expect(members).toContain('Loading members'); expect(records).toContain('Loading records');
    expect(lookup).toContain('aria-label="Wallet key"'); expect(lookup).toContain('Look up');
    expect(lookup).toContain('Scan a guest&#x27;s band'); expect(unexpected).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled();
  });
});
