import { createContext, useContext, type ReactNode } from 'react';
import type { Permission } from '@oto/shared/permissions';
import type { LiftedAdminApi } from '../../api/lifted-api';
import type { Branch, Operator } from '../model/types';
import type { CatalogReaders, CatalogStoreValue, LegacyPorts } from '../model/ports';
import type { AdminDomain } from './domain';
import type { StockModuleHooks } from '../api/stock';
export { MOCK_MUTATOR_TICKETS, type MockMutatorName } from '../model/mock-mutators';

type PlatformAdminApis = ReturnType<typeof import('../api/platform').createPlatformAdminApi>;

export interface AdminScreenApis {
  platform: Omit<PlatformAdminApis, 'adminApi'> & {
    adminApi: Pick<PlatformAdminApis['adminApi'], 'operators' | 'createOperator' | 'archiveOperator' | 'assignOperatorAdmin'>;
  };
  // The original POS bridge exposes hydration writes; Console composes the
  // separate confirmed-write helper without adding a POS module export.
  menu: Omit<ReturnType<typeof import('../api/menu').createMenuApi>, 'saveMenuItem' | 'saveDiscount'>;
  catalogBridge: ReturnType<typeof import('../api/catalogBridge').createCatalogBridge>;
  analyticsReports: ReturnType<typeof import('../api/analyticsReports').createAnalyticsReportsApi>;
  benefits: ReturnType<typeof import('../api/benefits').createBenefitsAdminApi>;
  stock: ReturnType<typeof import('../api/stock').createStockAdminApi> & StockModuleHooks;
  checkin: ReturnType<typeof import('../api/checkin').createCheckinAdminApi>;
  events: ReturnType<typeof import('../api/events').createEventsAdminApi>;
  wallet: ReturnType<typeof import('../api/wallet').createWalletAdminApi>;
  voucherPromotions: ReturnType<typeof import('../api/voucherPromotions').createVoucherPromotionsApi>;
}

/** Host-owned sessions and snapshots. The package owns neither store nor app context. */
export interface AdminScreenRuntime {
  catalog: CatalogStoreValue;
  reads: CatalogReaders;
  session: { operator: Operator | null; can: (permission: Permission) => boolean };
  branch: { branch: Branch; branches: Branch[]; switching: boolean; setActiveBranchId: (id: string) => void };
  station: { station: { stationId: string } | null };
  transport: LiftedAdminApi;
  api: AdminScreenApis;
  domain: AdminDomain;
  legacy: LegacyPorts;
  language: { t: (key: PhoneTranslationKey) => string };
  toast: (input: Parameters<typeof import('../../hooks/use-toast').toast>[0]) => unknown;
  navigation: { search: string; navigate: (path: string, options?: { replace?: boolean; state?: unknown }) => void };
}

export type PhoneTranslationKey = 'phoneInput.searchCountry' | 'phoneInput.noResults' | 'phoneInput.selectCountry' | 'phoneInput.label' | 'phoneInput.nationalNumberPlaceholder' | 'phoneInput.storedAs';

const RuntimeContext = createContext<AdminScreenRuntime | null>(null);

export function AdminScreenProvider({ value, children }: { value: AdminScreenRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useAdminScreenRuntime(): AdminScreenRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('Admin screens must be used within an AdminScreenProvider');
  return runtime;
}

export const useCatalogStore = () => useAdminScreenRuntime().catalog;
export const useOperator = () => useAdminScreenRuntime().session;
export const useBranch = () => useAdminScreenRuntime().branch;
export const useStation = () => useAdminScreenRuntime().station;
export const useLanguage = () => useAdminScreenRuntime().language;
export const useSearch = () => useAdminScreenRuntime().navigation.search;
export const useLocation = () => {
  const { navigate } = useAdminScreenRuntime().navigation;
  return ['', navigate] as const;
};
