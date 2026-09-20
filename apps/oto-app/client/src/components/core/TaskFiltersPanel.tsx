import { useState, useRef, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X, Search } from "lucide-react";

type TaskLevel = "staff" | "manager" | "admin" | "advisor";
type TaskScope = "all" | "my_tasks" | "my_department" | "assigned_by_me";

export interface TaskFilters {
  showStagnant: boolean;
  showEscalated: boolean;
  showArchived: boolean;
  hideRecurring: boolean;
  taskScope: TaskScope;
  taskLevels: TaskLevel[];
  branchId: string;
  departmentId: string;
  roleId: string;
  assigneeId: string;
  priority: "all" | "low" | "medium" | "high" | "urgent";
  searchQuery: string;
}

export const defaultTaskFilters: TaskFilters = {
  showStagnant: false,
  showEscalated: false,
  showArchived: false,
  hideRecurring: false,
  taskScope: "all",
  taskLevels: [],
  branchId: "all",
  departmentId: "all",
  roleId: "all",
  assigneeId: "all",
  priority: "all",
  searchQuery: "",
};

interface FilterOption {
  id: string;
  label: string;
  category: string;
  filterKey: keyof TaskFilters;
  filterValue: string;
}

interface TaskFiltersPanelProps {
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  branches?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
  roles?: { id: string; name: string }[];
  employees?: { id: string; fullName?: string; nickname?: string | null; displayName?: string }[];
  showBranchFilter?: boolean;
  showTaskLevelFilter?: boolean;
  showStagnantFilter?: boolean;
  showEscalatedFilter?: boolean;
  showArchivedFilter?: boolean;
}

export default function TaskFiltersPanel({
  filters,
  onFiltersChange,
  branches = [],
  departments = [],
  roles = [],
  employees = [],
  showBranchFilter = true,
  showTaskLevelFilter = true,
}: TaskFiltersPanelProps) {
  const [query, setQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const allOptions: FilterOption[] = [];

  const scopeOptions: { value: TaskScope; label: string }[] = [
    { value: "my_tasks", label: "My Tasks" },
    { value: "my_department", label: "My Department" },
    { value: "assigned_by_me", label: "Assigned by Me" },
  ];
  for (const s of scopeOptions) {
    allOptions.push({ id: `scope-${s.value}`, label: s.label, category: "Scope", filterKey: "taskScope", filterValue: s.value });
  }

  if (showTaskLevelFilter) {
    const levels: { value: TaskLevel; label: string }[] = [
      { value: "staff", label: "Staff" },
      { value: "manager", label: "Manager" },
      { value: "admin", label: "Admin" },
      { value: "advisor", label: "Advisor" },
    ];
    for (const l of levels) {
      allOptions.push({ id: `level-${l.value}`, label: l.label, category: "Level", filterKey: "taskLevels", filterValue: l.value });
    }
  }

  if (showBranchFilter) {
    for (const b of branches) {
      allOptions.push({ id: `branch-${b.id}`, label: b.name, category: "Branch", filterKey: "branchId", filterValue: b.id });
    }
  }

  for (const d of departments) {
    allOptions.push({ id: `dept-${d.id}`, label: d.name, category: "Department", filterKey: "departmentId", filterValue: d.id });
  }

  for (const r of roles) {
    allOptions.push({ id: `role-${r.id}`, label: r.name, category: "Role", filterKey: "roleId", filterValue: r.id });
  }

  for (const e of employees) {
    const name = e.displayName || e.nickname || e.fullName || "Unknown";
    allOptions.push({ id: `assignee-${e.id}`, label: name, category: "Assignee", filterKey: "assigneeId", filterValue: e.id });
  }

  const isOptionActive = (opt: FilterOption): boolean => {
    if (opt.filterKey === "taskLevels") {
      return filters.taskLevels.includes(opt.filterValue as TaskLevel);
    }
    if (opt.filterKey === "taskScope") {
      return filters.taskScope === opt.filterValue;
    }
    return filters[opt.filterKey] === opt.filterValue;
  };

  const activeChips = allOptions.filter(isOptionActive);

  const filteredSuggestions = query.trim()
    ? allOptions.filter(opt =>
        !isOptionActive(opt) &&
        (opt.label.toLowerCase().includes(query.toLowerCase()) ||
         opt.category.toLowerCase().includes(query.toLowerCase()))
      )
    : allOptions.filter(opt => !isOptionActive(opt));

  const groupedSuggestions: { category: string; items: FilterOption[] }[] = [];
  for (const opt of filteredSuggestions) {
    let group = groupedSuggestions.find(g => g.category === opt.category);
    if (!group) {
      group = { category: opt.category, items: [] };
      groupedSuggestions.push(group);
    }
    group.items.push(opt);
  }

  const flatSuggestions = groupedSuggestions.flatMap(g => g.items);

  const applyFilter = useCallback((opt: FilterOption) => {
    const updated = { ...filters, searchQuery: "" };
    if (opt.filterKey === "taskLevels") {
      const level = opt.filterValue as TaskLevel;
      if (!updated.taskLevels.includes(level)) {
        updated.taskLevels = [...updated.taskLevels, level];
      }
    } else if (opt.filterKey === "taskScope") {
      updated.taskScope = opt.filterValue as TaskScope;
    } else if (opt.filterKey === "branchId") {
      updated.branchId = opt.filterValue;
    } else if (opt.filterKey === "departmentId") {
      updated.departmentId = opt.filterValue;
    } else if (opt.filterKey === "roleId") {
      updated.roleId = opt.filterValue;
    } else if (opt.filterKey === "assigneeId") {
      updated.assigneeId = opt.filterValue;
    }
    onFiltersChange(updated);
    setQuery("");
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  }, [filters, onFiltersChange]);

  const removeFilter = useCallback((opt: FilterOption) => {
    const updated = { ...filters, searchQuery: "" };
    if (opt.filterKey === "taskLevels") {
      updated.taskLevels = updated.taskLevels.filter(l => l !== opt.filterValue);
    } else if (opt.filterKey === "taskScope") {
      updated.taskScope = "all";
    } else if (opt.filterKey === "branchId") {
      updated.branchId = "all";
    } else if (opt.filterKey === "departmentId") {
      updated.departmentId = "all";
    } else if (opt.filterKey === "roleId") {
      updated.roleId = "all";
    } else if (opt.filterKey === "assigneeId") {
      updated.assigneeId = "all";
    }
    setQuery("");
    onFiltersChange(updated);
  }, [filters, onFiltersChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex(prev => Math.min(prev + 1, flatSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === "Enter" && highlightedIndex >= 0 && flatSuggestions[highlightedIndex]) {
      e.preventDefault();
      applyFilter(flatSuggestions[highlightedIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    } else if (e.key === "Backspace" && !query && activeChips.length > 0) {
      removeFilter(activeChips[activeChips.length - 1]);
    }
  };

  const handleSearchChange = (value: string) => {
    setQuery(value);
    onFiltersChange({ ...filters, searchQuery: value });
    setHighlightedIndex(-1);
    if (!showSuggestions) setShowSuggestions(true);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
        setHighlightedIndex(-1);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "Scope": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
      case "Level": return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400";
      case "Priority": return "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400";
      case "Branch": return "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400";
      case "Department": return "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400";
      case "Role": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
      case "Assignee": return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
      default: return "bg-secondary text-secondary-foreground";
    }
  };

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0" data-testid="smart-search-filters">
      <div className="flex items-center gap-1.5 flex-wrap border rounded-md px-2 py-1 bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {activeChips.map((chip) => (
          <Badge
            key={chip.id}
            className={`shrink-0 gap-1 cursor-pointer text-xs py-0 ${getCategoryColor(chip.category)}`}
            onClick={() => removeFilter(chip)}
            data-testid={`chip-filter-${chip.id}`}
          >
            <span className="opacity-60 text-[10px]">{chip.category}:</span>
            {chip.label}
            <X className="h-3 w-3" />
          </Badge>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={activeChips.length > 0 ? "Add filter..." : "Search or filter..."}
          className="flex-1 min-w-[100px] bg-transparent border-0 outline-none text-sm py-1 placeholder:text-muted-foreground"
          data-testid="input-smart-search"
        />
        {(activeChips.length > 0 || query) && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              onFiltersChange({ ...defaultTaskFilters });
              inputRef.current?.focus();
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            data-testid="button-clear-all-filters"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 border rounded-md bg-popover shadow-md max-h-64 overflow-y-auto" data-testid="suggestions-dropdown">
          {groupedSuggestions.map((group) => (
            <div key={group.category}>
              <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/50 sticky top-0">
                {group.category}
              </div>
              {group.items.map((opt) => {
                const flatIndex = flatSuggestions.indexOf(opt);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => applyFilter(opt)}
                    className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                      flatIndex === highlightedIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted"
                    }`}
                    data-testid={`suggestion-${opt.id}`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${getCategoryColor(opt.category).split(" ")[0]}`} />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
