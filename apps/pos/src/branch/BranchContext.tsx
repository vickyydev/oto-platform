import {
  createContext,
  useContext,
  useState,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Branch } from '@/types';
import {
  getBranches,
  getActiveBranch,
  setActiveBranch as storeSetActiveBranch,
  subscribeCatalog,
} from '@/store/catalogStore';
import { authApi } from '@/api/platform';
import { loadCatalogFromApi } from '@/api/catalogBridge';

interface BranchContextValue {
  branch: Branch;
  branches: Branch[];
  setActiveBranchId: (id: string) => void;
}

const BranchContext = createContext<BranchContextValue | null>(null);

/**
 * Provides the active branch and switcher to the entire app.
 *
 * The active branch defaults to the first seed branch (HKT Central) on every
 * page load — no persistence by design (same rule as OperatorContext).
 *
 * BranchContext is the React layer; the module-level setActiveBranch in
 * catalogStore is the sync seam for non-React code that also needs to read the
 * active branch (getLiveOccupancy, deriveContacts).
 */
export function BranchProvider({ children }: { children: ReactNode }) {
  const [activeBranchId, setLocalId] = useState<string>(
    () => getActiveBranch().id,
  );

  // Track the store's branch list reactively — API hydration replaces it
  // after sign-in (Sprint 1 rebuild), and Admin edits update it.
  const allBranches = useSyncExternalStore(subscribeCatalog, getBranches);

  const setActiveBranchId = useCallback((id: string) => {
    storeSetActiveBranch(id);
    setLocalId(id);
    // Persist the choice on the server session and hydrate that branch's
    // wired catalog (packages / holidays / tax) from the API.
    const target = getBranches().find((b) => b.id === id);
    if (target?.apiId) {
      void authApi.switchBranch(target.apiId).catch(() => {});
      void loadCatalogFromApi(id).catch(() => {});
    }
  }, []);

  const branches = allBranches.filter((b) => b.active);
  const branch =
    branches.find((b) => b.id === activeBranchId) ?? branches[0];

  return (
    <BranchContext.Provider value={{ branch, branches, setActiveBranchId }}>
      {children}
    </BranchContext.Provider>
  );
}

export function useBranch(): BranchContextValue {
  const ctx = useContext(BranchContext);
  if (!ctx) {
    throw new Error('useBranch must be used within a BranchProvider');
  }
  return ctx;
}
