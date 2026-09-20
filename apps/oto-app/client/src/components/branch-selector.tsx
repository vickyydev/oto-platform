import { useState } from "react";
import { useBranchContext, BranchGroup } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Building2, Check, ChevronDown, Network } from "lucide-react";
import { cn } from "@/lib/utils";

interface BranchSelectorProps {
  compact?: boolean;
}

export function BranchSelector({ compact = false }: BranchSelectorProps) {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const {
    activeBranchId,
    activeOperatorId,
    activeBranchName,
    setActiveBranchId,
    setActiveOperatorId,
    branches,
    branchGroups,
    isLoading,
    hasSingleBranch,
    isAllBranches,
  } = useBranchContext();

  const canViewAllBranches = user?.role === "global_admin" || user?.role === "admin" || user?.hasAllBranchesAccess;

  if (isLoading) {
    return (
      <Button variant="ghost" size="icon" className="h-8 w-8" disabled>
        <Building2 className="h-4 w-4 animate-pulse" />
      </Button>
    );
  }

  if (branches.length === 0) {
    return null;
  }

  const getDisplayName = () => {
    if (activeBranchId) return activeBranchName;
    if (activeOperatorId) {
      const group = branchGroups.find(g => g.type === "operator" && g.id === activeOperatorId);
      return group?.name || "Operator";
    }
    return "All Branches";
  };

  const displayName = getDisplayName();

  const handleGroupSelect = (group: BranchGroup) => {
    if (group.type === "all") {
      setActiveBranchId(null);
    } else if (group.type === "operator" && group.id) {
      setActiveOperatorId(group.id);
    } else if (group.type === "branch" && group.id) {
      setActiveBranchId(group.id);
    }
    setMobileOpen(false);
    setDesktopOpen(false);
  };

  const isGroupSelected = (group: BranchGroup) => {
    if (group.type === "all") return isAllBranches;
    if (group.type === "operator") return activeOperatorId === group.id;
    if (group.type === "branch") return activeBranchId === group.id;
    return false;
  };

  const allGroup = branchGroups.find(g => g.type === "all");
  const operatorGroups = branchGroups.filter(g => g.type === "operator");
  const branchItems = branchGroups.filter(g => g.type === "branch");

  const renderGroupItem = (group: BranchGroup, indent = false) => {
    const isSelected = isGroupSelected(group);
    const Icon = group.type === "operator" ? Network : Building2;
    
    return (
      <button
        key={`${group.type}-${group.id}`}
        onClick={() => handleGroupSelect(group)}
        className={cn(
          "w-full flex items-center justify-between px-2 py-1.5 text-sm rounded-md hover-elevate",
          isSelected && "bg-accent",
          indent && "pl-6"
        )}
        data-testid={`branch-option-${group.type}-${group.id || 'all'}`}
      >
        <span className="flex items-center gap-2">
          {group.type !== "branch" && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
          {group.name}
          {group.type === "operator" && (
            <span className="text-xs text-muted-foreground">
              ({group.branchIds.length})
            </span>
          )}
        </span>
        {isSelected && <Check className="h-4 w-4" />}
      </button>
    );
  };

  // For single branch users without all-branches access, just show the branch name (no dropdown)
  const showStaticBranchName = hasSingleBranch && !canViewAllBranches;

  // Only show "All Branches" option if user has permission
  const showAllBranchesOption = canViewAllBranches && allGroup;

  return (
    <>
      {/* Mobile: show icon button only if user has multiple options */}
      {!showStaticBranchName && (
        <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
          <PopoverTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-8 w-8 md:hidden"
              data-testid="branch-selector-mobile"
            >
              <Building2 className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2 z-[100] max-h-[70vh] overflow-y-auto" align="start">
            {showAllBranchesOption && renderGroupItem(allGroup)}
            {operatorGroups.length > 0 && operatorGroups.map(op => (
              <div key={`operator-${op.id}`}>
                {renderGroupItem(op)}
                {op.branchIds.map(bId => {
                  const branch = branchItems.find(b => b.id === bId);
                  return branch ? renderGroupItem(branch, true) : null;
                })}
              </div>
            ))}
            {operatorGroups.length === 0 && branchItems.map(g => renderGroupItem(g))}
          </PopoverContent>
        </Popover>
      )}

      {/* Mobile: static name for single branch users */}
      {showStaticBranchName && (
        <div className="flex items-center gap-2 md:hidden" data-testid="branch-selector-mobile-static">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{activeBranchName}</span>
        </div>
      )}

      <div className="hidden md:flex items-center gap-2" data-testid="branch-selector-desktop">
        <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        {showStaticBranchName ? (
          <span className="text-sm font-medium">{activeBranchName}</span>
        ) : (
          <Popover open={desktopOpen} onOpenChange={setDesktopOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className="h-8 px-2 gap-1 text-sm font-normal"
                data-testid="branch-selector-trigger"
              >
                {displayName}
                <ChevronDown className="h-3 w-3 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2 max-h-[70vh] overflow-y-auto" align="start">
              {showAllBranchesOption && renderGroupItem(allGroup)}
              {operatorGroups.length > 0 && operatorGroups.map(op => (
                <div key={`operator-${op.id}`}>
                  {renderGroupItem(op)}
                  {op.branchIds.map(bId => {
                    const branch = branchItems.find(b => b.id === bId);
                    return branch ? renderGroupItem(branch, true) : null;
                  })}
                </div>
              ))}
              {operatorGroups.length === 0 && branchItems.map(g => renderGroupItem(g))}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </>
  );
}

export function BranchBadge() {
  const { activeBranchName, isLoading } = useBranchContext();

  if (isLoading || !activeBranchName) {
    return null;
  }

  return (
    <div 
      className="flex items-center gap-1.5 px-2.5 py-1 bg-muted rounded-md text-sm"
      data-testid="branch-badge"
    >
      <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium">{activeBranchName}</span>
    </div>
  );
}
