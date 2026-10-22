import { describe, expect, it } from 'vitest';
import type { AdminApi } from '../src/api/admin-api';
import { createCatalogueAdminApi } from '../src/lifted/api/platform';
import { createMenuCatalogueApi } from '../src/lifted/api/menu';
import { createMoneyAdminApi } from '../src/lifted/api/money';

describe('money transport and hidden catalogue fields', () => {
  it('retries an uncertain tender create with the same identity, then gives a new snapshot a fresh operation', async () => {
    const keys: string[] = [], applied = new Set<string>();
    let uncertain = true;
    const transport: AdminApi & { href: (path: string) => string } = {
      get: async <T>() => ({}) as T, patch: async <T>() => ({}) as T,
      put: async <T>() => ({}) as T, delete: async <T>() => ({}) as T, href: path => path,
      post: async <T>(_path: string, _body?: unknown, options?: { idempotencyKey?: string }) => {
        if (!options?.idempotencyKey) throw new Error('A create needs retry identity');
        keys.push(options.idempotencyKey); applied.add(options.idempotencyKey);
        if (uncertain) { uncertain = false; throw new Error('Response lost after commit'); }
        return { id: 'zz_tender' } as T;
      },
    };
    const method = { id: 'zz_tender', label: 'ZZ TEST Tender', kind: 'other' as const, sortOrder: 0, enabled: true };
    const money = createMoneyAdminApi(transport);
    await expect(money.saveTender(method, false)).rejects.toThrow('Response lost');
    await money.saveTender({ ...method }, false);
    expect(keys[1]).toBe(keys[0]); expect(applied.size).toBe(1);
    await createMoneyAdminApi(transport).saveTender(method, false);
    expect(keys[2]).not.toBe(keys[1]); expect(applied.size).toBe(2);
  });

  it('keeps distinct changed campaign bodies apart while retaining the native retry key', async () => {
    const keys: Array<string | undefined> = [];
    const transport: AdminApi & { href: (path: string) => string } = {
      get: async <T>() => ({}) as T, patch: async <T>() => ({}) as T,
      put: async <T>() => ({}) as T, delete: async <T>() => ({}) as T, href: path => path,
      post: async <_T>(_path: string, _body?: unknown, options?: { idempotencyKey?: string }) => {
        keys.push(options?.idempotencyKey); throw new Error('Uncertain outcome');
      },
    };
    const money = createMoneyAdminApi(transport), body = { definitionId: 'type', branchId: 'park', name: 'ZZ TEST Batch', quantity: 2 };
    await expect(money.voucherPromotionsApi.mintCampaign(body, 'first-intent')).rejects.toThrow('Uncertain');
    await expect(money.voucherPromotionsApi.mintCampaign({ ...body }, 'another-default')).rejects.toThrow('Uncertain');
    await expect(money.voucherPromotionsApi.mintCampaign({ ...body, quantity: 3 }, 'changed-intent')).rejects.toThrow('Uncertain');
    expect(keys).toEqual(['first-intent', 'first-intent', 'changed-intent']);
  });
  it('keys tax, tender and discount edits and archives explicitly', async () => {
    const writes: Array<{ path: string; key?: string }> = [];
    const api: AdminApi = {
      get: async <T>() => ({}) as T, post: async <T>() => ({}) as T,
      put: async <T>(path: string, _body?: unknown, options?: {idempotencyKey?: string}) => { writes.push({path,key:options?.idempotencyKey});return {ok:true} as T; },
      patch: async <T>(path: string, _body?: unknown, options?: {idempotencyKey?: string}) => { writes.push({path,key:options?.idempotencyKey});return {ok:true} as T; },
      delete: async <T>(path: string, options?: {idempotencyKey?: string}) => { writes.push({path,key:options?.idempotencyKey});return {ok:true} as T; },
    };
    const catalogue=createCatalogueAdminApi(api),menu=createMenuCatalogueApi(api);
    await catalogue.putTaxConfig('park',{rates:[],categoryRules:[],discountPlacement:'before_tax'});
    await catalogue.updatePaymentMethod('zz_test_method',{label:'ZZ TEST Method'});
    await catalogue.deletePaymentMethod('zz_test_method');
    await menu.menuApi.updateDiscount('discount',{label:'ZZ TEST Discount'});
    await menu.menuApi.archiveDiscount('discount');
    expect(writes).toHaveLength(5);
    for(const write of writes)expect(write.key,write.path).toMatch(/^[a-f0-9-]{36}$/i);
  });

  it('retains the actual merch kind when an existing free-product discount is opened', () => {
    const api: AdminApi={get:async<T>()=>({}) as T,post:async<T>()=>({}) as T,put:async<T>()=>({}) as T,patch:async<T>()=>({}) as T,delete:async<T>()=>({}) as T};
    const menu=createMenuCatalogueApi(api);
    menu.mapMenu({categories:[],modifierGroups:[],products:[{id:'merch-product',kind:'merch',branchId:'park',code:null,categoryId:null,name:'ZZ TEST Merch',description:null,priceSatang:123,priceWeekendSatang:null,costSatang:null,prepStationOverride:null,taxCategoryOverride:null,translations:null,sku:null,stockItemId:null,sortOrder:0,active:true,archivedAt:null,linkedModifierGroupIds:[]}]});
    const [discount]=menu.mapDiscounts([{id:'discount',branchId:null,code:'ZZ_TEST_FREE',label:'ZZ TEST Free merch',kind:'free_item',valueBp:null,valueSatang:null,freeProductId:'merch-product',target:{kind:'everything'},validFrom:null,validUntil:null,usageLimit:null,perCustomerLimit:null,stackable:false,active:true,archivedAt:null}]);
    expect(discount?.freeItemId).toBe('merch-product');
    expect(discount?.freeItemKind).toBe('merch');
  });
});
