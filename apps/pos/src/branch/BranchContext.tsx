import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
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
import { toast } from '@/hooks/use-toast';

interface BranchContextValue {
  branch: Branch;
  branches: Branch[];
  switching: boolean;
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
  const [switching, setSwitching] = useState(false);
  const switchTail = useRef(Promise.resolve());
  const switchVersion = useRef(0);

  const setActiveBranchId = useCallback((id: string) => {
    const target = getBranches().find((b) => b.id === id);
    if (!target?.active) return;
    const version = ++switchVersion.current;
    setSwitching(true);
    // Session-scoped reads must follow the confirmed choice. Serialising also
    // keeps rapid selections and their catalogue loads in the same order.
    switchTail.current = switchTail.current.then(async () => {
      if (version !== switchVersion.current) return;
      if (target.apiId) await authApi.switchBranch(target.apiId);
      storeSetActiveBranch(id);
      setLocalId(id);
      if (target.apiId) {
        await loadCatalogFromApi(id).catch(() => {
          toast({ title: 'Park selected', description: 'The catalogue could not be refreshed. Try selecting the park again.', variant: 'destructive' });
        });
      }
    }).catch((err: unknown) => {
      toast({ title: 'Park could not be changed', description: err instanceof Error ? err.message : 'Could not reach the platform. Try again.', variant: 'destructive' });
    }).finally(() => {
      if (version === switchVersion.current) setSwitching(false);
    });
  }, []);

  const branches = allBranches.filter((b) => b.active);
  const branch =
    branches.find((b) => b.id === activeBranchId) ?? branches[0];

  return (
    <BranchContext.Provider value={{ branch, branches, switching, setActiveBranchId }}>
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
