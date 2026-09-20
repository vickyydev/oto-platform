import { createContext, useContext, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Branch, Operator } from "@shared/schema";
import { useAuth } from "./use-auth";

const STORAGE_KEY = "oto_active_branch_id";
const ALL_BRANCHES_VALUE = "__ALL_BRANCHES__";
const OPERATOR_PREFIX = "__OPERATOR__:";

export interface BranchGroup {
  type: "all" | "operator" | "branch";
  id: string | null;
  name: string;
  branchIds: string[];
}

interface BranchContextValue {
  activeBranchId: string | null;
  activeBranchName: string | null;
  activeOperatorId: string | null;
  activeBranchIds: string[];
  setActiveBranchId: (id: string | null) => void;
  setActiveOperatorId: (operatorId: string) => void;
  activeBranch: Branch | null;
  branches: Branch[];
  operators: Operator[];
  branchGroups: BranchGroup[];
  isLoading: boolean;
  isAllBranches: boolean;
  hasSingleBranch: boolean;
  // Legacy aliases for compatibility
  selectedBranchId: string | null;
  setSelectedBranchId: (id: string | null) => void;
  selectedBranch: Branch | null;
}

const BranchContext = createContext<BranchContextValue | undefined>(undefined);

export function BranchProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [activeBranchId, setActiveBranchIdState] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === ALL_BRANCHES_VALUE || stored?.startsWith(OPERATOR_PREFIX)) {
        return null;
      }
      return stored;
    }
    return null;
  });
  
  const [activeOperatorId, setActiveOperatorIdState] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored?.startsWith(OPERATOR_PREFIX)) {
        return stored.replace(OPERATOR_PREFIX, "");
      }
    }
    return null;
  });
  
  const [hasExplicitSelection, setHasExplicitSelection] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) !== null;
    }
    return false;
  });

  const { data: branches = [], isLoading: branchesLoading } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
    enabled: !!user,
  });

  const isGlobalOrOperatorAdmin = user?.role === "global_admin" || user?.role === "admin" || user?.role === "operator_admin";
  
  const { data: operators = [], isLoading: operatorsLoading } = useQuery<Operator[]>({
    queryKey: ["/api/operators"],
    enabled: !!user && isGlobalOrOperatorAdmin,
  });

  const isLoading = branchesLoading || (isGlobalOrOperatorAdmin && operatorsLoading);

  const branchGroups: BranchGroup[] = (() => {
    const groups: BranchGroup[] = [];
    const canViewAllBranches = user?.role === "global_admin" || user?.role === "admin" || user?.hasAllBranchesAccess;
    
    if (canViewAllBranches) {
      groups.push({
        type: "all",
        id: null,
        name: "All Branches",
        branchIds: branches.map(b => b.id)
      });
    }
    
    if (user?.role === "global_admin" || user?.role === "admin") {
      operators
        .filter(op => op.status === "active")
        .forEach(op => {
          const opBranches = branches.filter(b => b.operatorId === op.id);
          if (opBranches.length > 0) {
            groups.push({
              type: "operator",
              id: op.id,
              name: op.name,
              branchIds: opBranches.map(b => b.id)
            });
          }
        });
    } else if (user?.role === "operator_admin" && user.operatorId) {
      const userOperator = operators.find(op => op.id === user.operatorId);
      if (userOperator) {
        const opBranches = branches.filter(b => b.operatorId === userOperator.id);
        if (opBranches.length > 1) {
          groups.push({
            type: "operator",
            id: userOperator.id,
            name: userOperator.name,
            branchIds: opBranches.map(b => b.id)
          });
        }
      }
    }
    
    branches.forEach(b => {
      groups.push({
        type: "branch",
        id: b.id,
        name: b.name,
        branchIds: [b.id]
      });
    });
    
    return groups;
  })();

  useEffect(() => {
    if (!isLoading && user && branches.length > 0) {
      // Check localStorage for current stored value
      const storedValue = localStorage.getItem(STORAGE_KEY);
      const hasStoredAllBranches = storedValue === ALL_BRANCHES_VALUE;
      const hasStoredOperator = storedValue?.startsWith(OPERATOR_PREFIX);
      
      // Auto-select logic:
      // 1. If user explicitly chose "All Branches" or an operator, respect it
      if (hasStoredAllBranches || hasStoredOperator) {
        return;
      }

      // 2. If only one branch available, auto-select it
      if (branches.length === 1) {
        if (activeBranchId !== branches[0].id) {
          setActiveBranchIdState(branches[0].id);
          localStorage.setItem(STORAGE_KEY, branches[0].id);
          setHasExplicitSelection(true);
        }
        return;
      }

      // 3. If user has made an explicit branch selection, validate and respect it
      if (hasExplicitSelection && activeBranchId) {
        const branchExists = branches.some((b) => b.id === activeBranchId);
        if (!branchExists) {
          // Selected branch no longer exists, reset to first
          setActiveBranchIdState(branches[0].id);
          localStorage.setItem(STORAGE_KEY, branches[0].id);
        }
        return;
      }

      // 4. If user has any explicit selection (even null), respect it
      if (hasExplicitSelection) {
        return;
      }

      // 5. If user doesn't have all_branches access, auto-select their first
      //    ALLOWED branch (not just branches[0] which may be a branch they
      //    can't access).
      if (!user.hasAllBranchesAccess && user.role !== "global_admin" && user.role !== "admin") {
        const firstAllowedBranch =
          branches.find((b) => user.allowedBranchIds?.includes(b.id)) ?? branches[0];
        setActiveBranchIdState(firstAllowedBranch.id);
        localStorage.setItem(STORAGE_KEY, firstAllowedBranch.id);
        setHasExplicitSelection(true);
        return;
      }

      // 6. For admins with no prior selection → default to All Branches so
      //    all tasks/data are visible by default on a fresh device, matching
      //    the experience of a laptop where the user chose "All Branches".
      if (!hasExplicitSelection) {
        setActiveBranchIdState(null);
        localStorage.setItem(STORAGE_KEY, ALL_BRANCHES_VALUE);
        setHasExplicitSelection(true);
      }
    }
  }, [branches, isLoading, activeBranchId, user, hasExplicitSelection]);

  const setActiveBranchId = (id: string | null) => {
    setActiveBranchIdState(id);
    setActiveOperatorIdState(null);
    setHasExplicitSelection(true);
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.setItem(STORAGE_KEY, ALL_BRANCHES_VALUE);
    }
  };

  const setActiveOperatorId = (operatorId: string) => {
    setActiveBranchIdState(null);
    setActiveOperatorIdState(operatorId);
    setHasExplicitSelection(true);
    localStorage.setItem(STORAGE_KEY, OPERATOR_PREFIX + operatorId);
  };

  const activeBranch = activeBranchId
    ? branches.find((b) => b.id === activeBranchId) || null
    : null;

  const activeOperator = activeOperatorId
    ? operators.find((o) => o.id === activeOperatorId)
    : null;

  const activeBranchIds: string[] = (() => {
    if (activeBranchId) {
      return [activeBranchId];
    }
    if (activeOperatorId) {
      return branches.filter(b => b.operatorId === activeOperatorId).map(b => b.id);
    }
    return branches.map(b => b.id);
  })();

  const activeBranchName = activeBranch?.name || (activeOperator?.name) || null;
  const isAllBranches = activeBranchId === null && activeOperatorId === null;
  const hasSingleBranch = branches.length === 1;

  return (
    <BranchContext.Provider
      value={{
        activeBranchId,
        activeBranchName,
        activeOperatorId,
        activeBranchIds,
        setActiveBranchId,
        setActiveOperatorId,
        activeBranch,
        branches,
        operators,
        branchGroups,
        isLoading,
        isAllBranches,
        hasSingleBranch,
        // Legacy aliases
        selectedBranchId: activeBranchId,
        setSelectedBranchId: setActiveBranchId,
        selectedBranch: activeBranch,
      }}
    >
      {children}
    </BranchContext.Provider>
  );
}

export function useBranchContext() {
  const context = useContext(BranchContext);
  if (!context) {
    throw new Error("useBranchContext must be used within a BranchProvider");
  }
  return context;
}
