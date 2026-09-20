import { useState, useRef, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Search, X, User, Briefcase, Building2, Users, MapPin } from "lucide-react";

export type AssignmentType = "everyone" | "employee" | "advisor" | "role" | "department" | "branch";

export interface AssignmentValue {
  type: AssignmentType;
  id: string;
  label: string;
}

export function getAssignmentSummary(assignments: AssignmentValue[]): string {
  if (assignments.length === 0) return "Visible to everyone at the selected branch";

  const people = assignments.filter(a => a.type === "employee" || a.type === "advisor");
  const depts = assignments.filter(a => a.type === "department");
  const roles = assignments.filter(a => a.type === "role");
  const branchFilters = assignments.filter(a => a.type === "branch");

  const parts: string[] = [];

  if (people.length > 0) {
    const names = people.map(p => p.label).join(", ");
    parts.push(names);
  }

  if (depts.length > 0) {
    const deptNames = depts.map(d => d.label).join(", ");
    if (branchFilters.length > 0) {
      const brNames = branchFilters.map(b => b.label).join(", ");
      parts.push(`${deptNames} dept at ${brNames}`);
    } else {
      parts.push(`All ${deptNames} staff`);
    }
  }

  if (roles.length > 0) {
    const roleNames = roles.map(r => r.label).join(", ");
    if (branchFilters.length > 0 && depts.length === 0) {
      const brNames = branchFilters.map(b => b.label).join(", ");
      parts.push(`${roleNames} role at ${brNames}`);
    } else if (branchFilters.length === 0) {
      parts.push(`All with ${roleNames} role`);
    } else {
      parts.push(`${roleNames} role`);
    }
  }

  if (branchFilters.length > 0 && depts.length === 0 && roles.length === 0 && people.length === 0) {
    const brNames = branchFilters.map(b => b.label).join(", ");
    parts.push(`Everyone at ${brNames}`);
  }

  return parts.join(" + ");
}

interface AssignmentOption {
  id: string;
  label: string;
  category: string;
  type: AssignmentType;
  value: string;
}

interface AssignmentSearchBarProps {
  value: AssignmentValue[];
  onChange: (value: AssignmentValue[]) => void;
  employees?: { id: string; fullName: string; nickname?: string | null; branchId?: string | null }[];
  advisors?: { id: string; fullName: string; preferredName?: string | null }[];
  roles?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
  branches?: { id: string; name: string }[];
  placeholder?: string;
  showEveryone?: boolean;
}

export default function AssignmentSearchBar({
  value,
  onChange,
  employees = [],
  advisors = [],
  roles = [],
  departments = [],
  branches = [],
  placeholder = "Search to assign...",
  showEveryone = true,
}: AssignmentSearchBarProps) {
  const [query, setQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedKeys = new Set(value.map(v => `${v.type}:${v.id}`));

  const allOptions: AssignmentOption[] = [];

  if (showEveryone && value.length === 0) {
    allOptions.push({
      id: "everyone",
      label: "Everyone (Unassigned)",
      category: "General",
      type: "everyone",
      value: "",
    });
  }

  for (const emp of employees) {
    if (!selectedKeys.has(`employee:${emp.id}`)) {
      allOptions.push({
        id: `emp-${emp.id}`,
        label: emp.nickname || emp.fullName,
        category: "Employee",
        type: "employee",
        value: emp.id,
      });
    }
  }

  for (const adv of advisors) {
    if (!selectedKeys.has(`advisor:${adv.id}`)) {
      allOptions.push({
        id: `adv-${adv.id}`,
        label: adv.preferredName || adv.fullName,
        category: "Advisor",
        type: "advisor",
        value: adv.id,
      });
    }
  }

  for (const role of roles) {
    if (!selectedKeys.has(`role:${role.id}`)) {
      allOptions.push({
        id: `role-${role.id}`,
        label: role.name,
        category: "Role",
        type: "role",
        value: role.id,
      });
    }
  }

  for (const dept of departments) {
    if (!selectedKeys.has(`department:${dept.id}`)) {
      allOptions.push({
        id: `dept-${dept.id}`,
        label: dept.name,
        category: "Department",
        type: "department",
        value: dept.id,
      });
    }
  }

  for (const branch of branches) {
    if (!selectedKeys.has(`branch:${branch.id}`)) {
      allOptions.push({
        id: `branch-${branch.id}`,
        label: branch.name,
        category: "Branch",
        type: "branch",
        value: branch.id,
      });
    }
  }

  const filteredSuggestions = query.trim()
    ? allOptions.filter(opt =>
        opt.label.toLowerCase().includes(query.toLowerCase()) ||
        opt.category.toLowerCase().includes(query.toLowerCase())
      )
    : allOptions;

  const groupedSuggestions: { category: string; items: AssignmentOption[] }[] = [];
  for (const opt of filteredSuggestions) {
    let group = groupedSuggestions.find(g => g.category === opt.category);
    if (!group) {
      group = { category: opt.category, items: [] };
      groupedSuggestions.push(group);
    }
    group.items.push(opt);
  }

  const flatSuggestions = groupedSuggestions.flatMap(g => g.items);

  const selectOption = useCallback((opt: AssignmentOption) => {
    if (opt.type === "everyone") {
      onChange([]);
    } else {
      const key = `${opt.type}:${opt.value}`;
      if (value.some(v => `${v.type}:${v.id}` === key)) return;
      onChange([...value, { type: opt.type, id: opt.value, label: opt.label }]);
    }
    setQuery("");
    setHighlightedIndex(-1);
  }, [onChange, value]);

  const removeChip = useCallback((index: number) => {
    const next = value.filter((_, i) => i !== index);
    onChange(next);
    inputRef.current?.focus();
  }, [onChange, value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex(prev => Math.min(prev + 1, flatSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === "Enter" && highlightedIndex >= 0 && flatSuggestions[highlightedIndex]) {
      e.preventDefault();
      selectOption(flatSuggestions[highlightedIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    } else if (e.key === "Backspace" && !query && value.length > 0) {
      removeChip(value.length - 1);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
        setHighlightedIndex(-1);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, []);

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "General": return <Users className="h-3.5 w-3.5" />;
      case "Employee": return <User className="h-3.5 w-3.5" />;
      case "Advisor": return <User className="h-3.5 w-3.5" />;
      case "Role": return <Briefcase className="h-3.5 w-3.5" />;
      case "Department": return <Building2 className="h-3.5 w-3.5" />;
      case "Branch": return <MapPin className="h-3.5 w-3.5" />;
      default: return null;
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "General": return "bg-secondary text-secondary-foreground";
      case "Employee": return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
      case "Advisor": return "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400";
      case "Role": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
      case "Department": return "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400";
      case "Branch": return "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400";
      default: return "bg-secondary text-secondary-foreground";
    }
  };

  const getChipCategory = (type: AssignmentType) => {
    switch (type) {
      case "employee": return "Employee";
      case "advisor": return "Advisor";
      case "role": return "Role";
      case "department": return "Department";
      case "branch": return "Branch";
      default: return "General";
    }
  };

  return (
    <div ref={containerRef} className="relative" data-testid="assignment-search-bar">
      <div className="flex items-center gap-1.5 flex-wrap border rounded-md px-2 py-1 bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {value.map((chip, idx) => (
          <Badge
            key={`${chip.type}-${chip.id}-${idx}`}
            className={`shrink-0 gap-1 cursor-pointer text-xs py-0 ${getCategoryColor(getChipCategory(chip.type))}`}
            onClick={() => removeChip(idx)}
            data-testid={`chip-assignment-${idx}`}
          >
            {getCategoryIcon(getChipCategory(chip.type))}
            <span className="opacity-60 text-[10px]">{getChipCategory(chip.type)}:</span>
            {chip.label}
            <X className="h-3 w-3" />
          </Badge>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightedIndex(-1);
            if (!showSuggestions) setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length > 0 ? "Add more..." : placeholder}
          className="flex-1 min-w-[100px] bg-transparent border-0 outline-none text-sm py-1 placeholder:text-muted-foreground"
          data-testid="input-assignment-search"
        />
        {(value.length > 0 || query) && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              onChange([]);
              inputRef.current?.focus();
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            data-testid="button-clear-assignment"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 border rounded-md bg-popover shadow-md max-h-56 overflow-y-auto" data-testid="assignment-suggestions">
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
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectOption(opt);
                    }}
                    onTouchEnd={(e) => {
                      e.preventDefault();
                      selectOption(opt);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                      flatIndex === highlightedIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted"
                    }`}
                    data-testid={`suggestion-${opt.id}`}
                  >
                    {getCategoryIcon(opt.category)}
                    {opt.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {showSuggestions && filteredSuggestions.length === 0 && query.trim() && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 border rounded-md bg-popover shadow-md p-3">
          <p className="text-sm text-muted-foreground text-center">No results for "{query}"</p>
        </div>
      )}
    </div>
  );
}
