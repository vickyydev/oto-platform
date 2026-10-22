import {createMenuApi} from '@oto/admin-screens/lifted/api/menu';
import {hydrateFromApi} from '@/store/catalogStore';
import {adminScreenApi} from './admin-screen-api';
export type * from '@oto/admin-screens/lifted/api/menu';

/** One POS menu mapping/cache/write queue, shared by every compatibility caller. */
const bound = createMenuApi(adminScreenApi,{hydrateFromApi});
export const {menuApi,fetchMenuWorkbook,catalogueSizesOf,isSocksAddOnId,serverFieldsFor,menuIsServerBacked,apiCategoryToDef,apiGroupToGroup,apiProductToMenuItem,menuItemToApiBody,categoryToApiBody,apiProductToMerchItem,merchItemToApiBody,apiProductToAddOn,addOnToApiBody,modifierGroupToApiBody,apiDiscountToDiscount,discountToApiBody,mapDiscounts,mapMenu,reloadMenuInto,saveMerchItemToApi,archiveMerchItemInApi,saveAddOnToApi,archiveAddOnInApi,saveModifierGroupToApi,archiveModifierGroupInApi,saveDiscountToApi,archiveDiscountInApi,saveMenuItemToApi,archiveMenuItemInApi,saveMenuCategoryToApi,archiveMenuCategoryInApi} = bound;
