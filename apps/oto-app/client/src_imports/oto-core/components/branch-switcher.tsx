import { useAuth } from "@/lib/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Branch } from "@shared/schema";
import { useState, useEffect, createContext, useContext } from "react";

const SELECTED_BRANCH_KEY = "oto-selected-branch-id";

export function getSelectedBranchId(): string | null {
  return localStorage.getItem(SELECTED_BRANCH_KEY);
}

export function setSelectedBranchId(branchId: string | null): void {
  if (branchId) {
    localStorage.setItem(SELECTED_BRANCH_KEY, branchId);
  } else {
    localStorage.removeItem(SELECTED_BRANCH_KEY);
  }
}

interface BranchContextType {
  activeBranchId: string | null;
  activeBranchName: string | null;
  setActiveBranch: (branchId: string) => void;
  isUsingOverride: boolean;
}

const BranchContext = createContext<BranchContextType | null>(null);

export function BranchProvider({ children }: { children: React.ReactNode }) {
  const { user, effectiveBranchId, effectiveBranchName, accessLevel, isLoading } = useAuth();
  const [overrideBranchId, setOverrideBranchId] = useState<string | null>(getSelectedBranchId());
  const queryClient = useQueryClient();

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
    enabled: !!user,
  });

  const canSwitchBranches = accessLevel === "MANAGER" || accessLevel === "ADMIN";
  
  const activeBranchId = canSwitchBranches && overrideBranchId 
    ? overrideBranchId 
    : effectiveBranchId || user?.branchId || null;

  const activeBranch = branches.find(b => b.id === activeBranchId);
  const activeBranchName = activeBranch?.name || effectiveBranchName || null;

  const setActiveBranch = (branchId: string) => {
    setOverrideBranchId(branchId);
    setSelectedBranchId(branchId);
    queryClient.invalidateQueries();
  };

  const isUsingOverride = !!overrideBranchId && overrideBranchId !== effectiveBranchId;

  return (
    <BranchContext.Provider value={{
      activeBranchId,
      activeBranchName,
      setActiveBranch,
      isUsingOverride,
    }}>
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

interface BranchSwitcherProps {
  className?: string;
}

export function BranchSwitcher({ className }: BranchSwitcherProps) {
  const { user, accessLevel } = useAuth();
  const { activeBranchId, setActiveBranch } = useBranchContext();

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
    enabled: !!user,
  });

  const canSwitchBranches = accessLevel === "MANAGER" || accessLevel === "ADMIN";
  
  const branchScope = user?.branchScope || "ALL";
  const userBranchIds = (user?.branchIds as string[]) || [];

  const accessibleBranches = branches.filter((branch) => {
    if (branchScope === "ALL") return true;
    if (branchScope === "SELECTED") return userBranchIds.includes(branch.id);
    return branch.id === user?.branchId;
  });

  const selectedBranch = accessibleBranches.find(b => b.id === activeBranchId) || 
                          accessibleBranches.find(b => b.id === user?.branchId) ||
                          accessibleBranches[0];

  if (!canSwitchBranches || accessibleBranches.length <= 1) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="ghost" 
          size="sm" 
          className={className}
          data-testid="button-branch-switcher"
        >
          <Building className="h-4 w-4 mr-1" />
          {selectedBranch?.name || "Select Branch"}
          <ChevronDown className="h-3 w-3 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Switch Branch</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accessibleBranches.map((branch) => (
          <DropdownMenuItem
            key={branch.id}
            onClick={() => setActiveBranch(branch.id)}
            className="flex items-center justify-between"
            data-testid={`menu-item-branch-${branch.slug || branch.id}`}
          >
            <span>{branch.name}</span>
            {branch.id === selectedBranch?.id && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
