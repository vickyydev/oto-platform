import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Search,
  Shield,
  Users,
  Loader2,
  Edit,
  Contact,
  ChevronDown,
  ChevronUp,
  Check,
  X,
} from "lucide-react";

interface FilterTag {
  category: string;
  value: string;
  label: string;
}

interface FilterSuggestion {
  category: string;
  value: string;
  label: string;
  displayCategory: string;
}

const FILTER_CATEGORY_COLORS: Record<string, string> = {
  level: "bg-purple-600 text-white",
  department: "bg-amber-600 text-white",
  branch: "bg-blue-600 text-white",
  type: "bg-emerald-600 text-white",
  name: "bg-slate-600 text-white",
};

interface ModuleAccess {
  core: boolean;
  hr: boolean;
  events: boolean;
  ops: boolean;
  setup: boolean;
}

interface AccessPolicyData {
  id: string | null;
  accessLevel: string;
  modules: ModuleAccess;
  branchScope: string;
  branchIds: string[] | null;
  coreAccountEnabled: boolean;
  coreUserId: string | null;
  provisioningStatus: string | null;
  source: "policy" | "role";
}

interface ModuleOverride {
  moduleKey: string;
  enabled: boolean;
  branchScopeType: string;
  branchIds: string[];
}

interface PersonPermission {
  personId: string;
  fullName: string;
  preferredName: string | null;
  nickname: string | null;
  email: string;
  personType: string;
  userId: string | null;
  userRole: string | null;
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  accessPolicy: AccessPolicyData | null;
  moduleOverrides: ModuleOverride[];
}

interface Branch {
  id: string;
  name: string;
}

const MODULE_KEYS = ["core", "ops", "events", "hr", "setup"] as const;
const MODULE_LABELS: Record<string, string> = {
  core: "Today",
  hr: "HR",
  events: "Events",
  ops: "Ops",
  setup: "Setup",
};

const ACCESS_LEVEL_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  STAFF: "Staff",
};

const ACCESS_LEVEL_COLORS: Record<string, string> = {
  ADMIN: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  MANAGER: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  STAFF: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export default function PermissionsPage() {
  const { toast } = useToast();
  const [filterTags, setFilterTags] = useState<FilterTag[]>([]);
  const [filterInput, setFilterInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [editPerson, setEditPerson] = useState<PersonPermission | null>(null);
  const [editModules, setEditModules] = useState<ModuleAccess>({
    core: false, hr: false, events: false, ops: false, setup: false,
  });
  const [editAccessLevel, setEditAccessLevel] = useState<string>("STAFF");
  const [editBranchScope, setEditBranchScope] = useState<string>("ALL");
  const [editBranchIds, setEditBranchIds] = useState<string[]>([]);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const { data: people = [], isLoading } = useQuery<PersonPermission[]>({
    queryKey: ["/api/permissions/bulk"],
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const updateAccessMutation = useMutation({
    mutationFn: async ({ personId, data }: { personId: string; data: any }) => {
      return apiRequest("PUT", `/api/people/${personId}/access`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/permissions/bulk"] });
      toast({ title: "Permissions updated" });
      setEditPerson(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const toggleModuleMutation = useMutation({
    mutationFn: async ({ personId, modules, accessLevel, branchScope, branchIds }: {
      personId: string;
      modules: ModuleAccess;
      accessLevel: string;
      branchScope: string;
      branchIds: string[] | null;
    }) => {
      return apiRequest("PUT", `/api/people/${personId}/access`, {
        modules,
        accessLevel,
        branchScope,
        branchIds,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/permissions/bulk"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const availableSuggestions = useMemo((): FilterSuggestion[] => {
    const suggestions: FilterSuggestion[] = [];
    const levels = new Set<string>();
    const departments = new Set<string>();
    const branchNames = new Set<string>();
    const names = new Set<string>();
    people.forEach((p) => {
      if (p.accessPolicy?.accessLevel) levels.add(p.accessPolicy.accessLevel);
      if (p.departmentName) departments.add(p.departmentName);
      if (p.branchName) branchNames.add(p.branchName);
    });
    levels.forEach((l) => suggestions.push({ category: "level", value: l, label: ACCESS_LEVEL_LABELS[l] || l, displayCategory: "Level" }));
    Array.from(departments).sort().forEach((d) => suggestions.push({ category: "department", value: d, label: d, displayCategory: "Department" }));
    Array.from(branchNames).sort().forEach((b) => suggestions.push({ category: "branch", value: b, label: b, displayCategory: "Branch" }));
    suggestions.push({ category: "type", value: "EMPLOYEE", label: "Employee", displayCategory: "Type" });
    suggestions.push({ category: "type", value: "ADVISOR", label: "Advisor", displayCategory: "Type" });
    return suggestions;
  }, [people]);

  const filteredSuggestions = useMemo(() => {
    if (!filterInput.trim()) return availableSuggestions;
    const q = filterInput.toLowerCase();
    return availableSuggestions.filter((s) =>
      s.label.toLowerCase().includes(q) ||
      s.displayCategory.toLowerCase().includes(q)
    );
  }, [availableSuggestions, filterInput]);

  const addFilterTag = useCallback((suggestion: FilterSuggestion) => {
    const exists = filterTags.some((t) => t.category === suggestion.category && t.value === suggestion.value);
    if (!exists) {
      setFilterTags((prev) => [...prev, { category: suggestion.category, value: suggestion.value, label: suggestion.label }]);
    }
    setFilterInput("");
    setShowSuggestions(false);
    setSelectedSuggestionIndex(0);
    filterInputRef.current?.focus();
  }, [filterTags]);

  const removeFilterTag = useCallback((index: number) => {
    setFilterTags((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilterTags([]);
    setFilterInput("");
    setShowSuggestions(false);
  }, []);

  const handleFilterKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestionIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestionIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && filteredSuggestions.length > 0) {
      e.preventDefault();
      addFilterTag(filteredSuggestions[selectedSuggestionIndex]);
    } else if (e.key === "Backspace" && !filterInput && filterTags.length > 0) {
      removeFilterTag(filterTags.length - 1);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }, [filteredSuggestions, selectedSuggestionIndex, filterInput, filterTags, addFilterTag, removeFilterTag]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [filterInput]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
          filterInputRef.current && !filterInputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredPeople = useMemo(() => {
    if (filterTags.length === 0) return people;
    return people.filter((p) => {
      return filterTags.every((tag) => {
        switch (tag.category) {
          case "level":
            return p.accessPolicy?.accessLevel === tag.value;
          case "department":
            return p.departmentName === tag.value;
          case "branch":
            return p.branchName === tag.value;
          case "type":
            return p.personType === tag.value;
          case "name": {
            const name = (p.nickname || p.preferredName || p.fullName).toLowerCase();
            return name.includes(tag.value.toLowerCase());
          }
          default:
            return true;
        }
      });
    });
  }, [people, filterTags]);

  const openEditDialog = (person: PersonPermission) => {
    setEditPerson(person);
    if (person.accessPolicy) {
      setEditModules({ ...person.accessPolicy.modules });
      setEditAccessLevel(person.accessPolicy.accessLevel);
      setEditBranchScope(person.accessPolicy.branchScope);
      setEditBranchIds(person.accessPolicy.branchIds || []);
    } else {
      setEditModules({ core: false, hr: false, events: false, ops: false, setup: false });
      setEditAccessLevel("STAFF");
      setEditBranchScope("ALL");
      setEditBranchIds([]);
    }
  };

  const handleSave = () => {
    if (!editPerson) return;
    updateAccessMutation.mutate({
      personId: editPerson.personId,
      data: {
        modules: editModules,
        accessLevel: editAccessLevel,
        branchScope: editBranchScope,
        branchIds: editBranchScope === "SELECTED" ? editBranchIds : null,
      },
    });
  };

  const handleQuickModuleToggle = (person: PersonPermission, moduleKey: string, enabled: boolean) => {
    if (!person.accessPolicy) {
      toast({ title: "No access policy", description: "Open the edit dialog to set up access first.", variant: "destructive" });
      return;
    }
    const updatedModules = { ...person.accessPolicy.modules, [moduleKey]: enabled };
    toggleModuleMutation.mutate({
      personId: person.personId,
      modules: updatedModules,
      accessLevel: person.accessPolicy.accessLevel,
      branchScope: person.accessPolicy.branchScope,
      branchIds: person.accessPolicy.branchIds,
    });
  };

  const bulkUpdateMutation = useMutation({
    mutationFn: async ({ personIds, moduleKey, enabled }: {
      personIds: string[];
      moduleKey: string;
      enabled: boolean;
    }) => {
      return apiRequest("PUT", "/api/permissions/bulk-update", {
        personIds,
        moduleKey,
        enabled,
      });
    },
    onSuccess: async (res) => {
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/permissions/bulk"] });
      toast({ title: "Bulk update complete", description: `${data.updated} updated, ${data.skipped} skipped` });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleBulkModuleToggle = (moduleKey: string, enabled: boolean) => {
    const eligiblePeople = filteredPeople.filter(p => p.accessPolicy);
    if (eligiblePeople.length === 0) {
      toast({ title: "No eligible people", description: "None of the filtered people have access configured.", variant: "destructive" });
      return;
    }
    bulkUpdateMutation.mutate({
      personIds: eligiblePeople.map(p => p.personId),
      moduleKey,
      enabled,
    });
  };

  const bulkModuleStatus = useMemo(() => {
    const result: Record<string, { allOn: boolean; allOff: boolean; mixed: boolean }> = {};
    for (const key of MODULE_KEYS) {
      const eligible = filteredPeople.filter(p => p.accessPolicy);
      const onCount = eligible.filter(p => p.accessPolicy?.modules?.[key]).length;
      result[key] = {
        allOn: eligible.length > 0 && onCount === eligible.length,
        allOff: onCount === 0,
        mixed: onCount > 0 && onCount < eligible.length,
      };
    }
    return result;
  }, [filteredPeople]);

  const stats = useMemo(() => {
    const total = people.length;
    const withAccess = people.filter(p => p.accessPolicy).length;
    const admins = people.filter(p => p.accessPolicy?.accessLevel === "ADMIN").length;
    const managers = people.filter(p => p.accessPolicy?.accessLevel === "MANAGER").length;
    return { total, withAccess, admins, managers };
  }, [people]);

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-permissions-title">Access</h1>
          <p className="text-sm text-muted-foreground">Manage access levels and module permissions for all employees and advisors</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Total People</p>
            <p className="text-xl font-bold" data-testid="text-stat-total">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">With Access</p>
            <p className="text-xl font-bold" data-testid="text-stat-with-access">{stats.withAccess}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Admins</p>
            <p className="text-xl font-bold" data-testid="text-stat-admins">{stats.admins}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Managers</p>
            <p className="text-xl font-bold" data-testid="text-stat-managers">{stats.managers}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <div
            className="flex items-center flex-wrap gap-1.5 border rounded-md bg-background px-2.5 py-1.5 min-h-[36px] cursor-text"
            onClick={() => filterInputRef.current?.focus()}
            data-testid="filter-bar-container"
          >
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            {filterTags.map((tag, index) => (
              <span
                key={`${tag.category}-${tag.value}-${index}`}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap ${FILTER_CATEGORY_COLORS[tag.category] || "bg-muted text-muted-foreground"}`}
                data-testid={`filter-tag-${tag.category}-${tag.value}`}
              >
                {tag.category === "level" ? "Level" : tag.category === "department" ? "Department" : tag.category === "branch" ? "Branch" : tag.category === "type" ? "Type" : "Name"}:{" "}
                <span className="font-bold">{tag.label}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeFilterTag(index); }}
                  className="ml-0.5 hover:opacity-70"
                  data-testid={`filter-tag-remove-${index}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              ref={filterInputRef}
              type="text"
              value={filterInput}
              onChange={(e) => { setFilterInput(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={handleFilterKeyDown}
              placeholder={filterTags.length === 0 ? "Add filter..." : "Add filter..."}
              className="flex-1 min-w-[100px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
              data-testid="input-permissions-filter"
            />
            {filterTags.length > 0 && (
              <button
                onClick={clearAllFilters}
                className="text-muted-foreground hover:text-foreground shrink-0"
                data-testid="button-clear-all-filters"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {showSuggestions && filteredSuggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md max-h-[240px] overflow-y-auto"
              data-testid="filter-suggestions-dropdown"
            >
              {filteredSuggestions.map((suggestion, index) => {
                const isAlreadyAdded = filterTags.some((t) => t.category === suggestion.category && t.value === suggestion.value);
                return (
                  <button
                    key={`${suggestion.category}-${suggestion.value}`}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                      index === selectedSuggestionIndex ? "bg-accent" : ""
                    } ${isAlreadyAdded ? "opacity-40" : "hover-elevate"}`}
                    onClick={() => !isAlreadyAdded && addFilterTag(suggestion)}
                    disabled={isAlreadyAdded}
                    data-testid={`filter-suggestion-${suggestion.category}-${suggestion.value}`}
                  >
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${FILTER_CATEGORY_COLORS[suggestion.category] || "bg-muted text-muted-foreground"}`}>
                      {suggestion.displayCategory}
                    </span>
                    <span>{suggestion.label}</span>
                    {isAlreadyAdded && <Check className="h-3 w-3 ml-auto text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {filterTags.length > 0 && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {filteredPeople.length} of {people.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredPeople.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No people found matching your filters.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[180px]">Name</TableHead>
                    <TableHead className="w-[100px]">Access</TableHead>
                    {MODULE_KEYS.map((key) => (
                      <TableHead key={key} className="w-[70px] text-center">
                        {MODULE_LABELS[key]}
                      </TableHead>
                    ))}
                    <TableHead className="w-[90px] text-center">Scope</TableHead>
                    <TableHead className="w-[60px]"></TableHead>
                  </TableRow>
                  {filterTags.length > 0 && filteredPeople.length > 0 && (
                    <TableRow className="bg-muted/50">
                      <TableHead colSpan={2} className="text-xs font-medium py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5" />
                          <span>Bulk ({filteredPeople.length})</span>
                        </div>
                      </TableHead>
                      {MODULE_KEYS.map((key) => {
                        const status = bulkModuleStatus[key];
                        return (
                          <TableHead key={`bulk-${key}`} className="text-center py-1.5">
                            <div className="flex justify-center">
                              <Checkbox
                                checked={status?.allOn ? true : status?.mixed ? "indeterminate" : false}
                                onCheckedChange={(checked) => handleBulkModuleToggle(key, !!checked)}
                                disabled={bulkUpdateMutation.isPending}
                                data-testid={`checkbox-bulk-module-${key}`}
                              />
                            </div>
                          </TableHead>
                        );
                      })}
                      <TableHead className="py-1.5" />
                      <TableHead className="py-1.5" />
                    </TableRow>
                  )}
                </TableHeader>
                <TableBody>
                  {filteredPeople.map((person) => {
                    const displayName = person.nickname || person.preferredName || person.fullName;
                    const isExpanded = expandedRow === person.personId;
                    return (
                      <TableRow
                        key={person.personId}
                        className="group"
                        data-testid={`row-permission-${person.personId}`}
                      >
                        <TableCell>
                          <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-sm truncate">{displayName}</span>
                              {person.personType === "ADVISOR" && (
                                <Badge variant="outline" className="text-xs shrink-0">
                                  <Contact className="h-3 w-3 mr-0.5" />
                                  Advisor
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-xs text-muted-foreground truncate">
                              {person.departmentName && <span>{person.departmentName}</span>}
                              {person.departmentName && person.branchName && <span>·</span>}
                              {person.branchName && <span>{person.branchName}</span>}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {person.accessPolicy ? (
                            <Badge
                              variant="secondary"
                              className={`text-xs ${ACCESS_LEVEL_COLORS[person.accessPolicy.accessLevel] || ""}`}
                            >
                              {ACCESS_LEVEL_LABELS[person.accessPolicy.accessLevel] || person.accessPolicy.accessLevel}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">No login</span>
                          )}
                        </TableCell>
                        {MODULE_KEYS.map((key) => {
                          const enabled = person.accessPolicy?.modules?.[key] ?? false;
                          return (
                            <TableCell key={key} className="text-center">
                              <div className="flex justify-center">
                                <Checkbox
                                  checked={enabled}
                                  onCheckedChange={(checked) => handleQuickModuleToggle(person, key, !!checked)}
                                  disabled={!person.accessPolicy || toggleModuleMutation.isPending}
                                  data-testid={`checkbox-module-${person.personId}-${key}`}
                                />
                              </div>
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-center">
                          {person.accessPolicy ? (
                            <Badge variant="outline" className="text-xs">
                              {person.accessPolicy.branchScope === "ALL" ? "All" : "Selected"}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => openEditDialog(person)}
                            data-testid={`button-edit-permission-${person.personId}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editPerson} onOpenChange={(open) => !open && setEditPerson(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Edit Permissions - {editPerson?.nickname || editPerson?.preferredName || editPerson?.fullName}
            </DialogTitle>
            <DialogDescription>
              Configure access level and module permissions. Changes sync to the employee/advisor profile.
            </DialogDescription>
          </DialogHeader>

          {editPerson && (
            <div className="space-y-5 py-2">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Access Level</Label>
                <Select value={editAccessLevel} onValueChange={setEditAccessLevel}>
                  <SelectTrigger data-testid="select-edit-access-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                    <SelectItem value="MANAGER">Manager</SelectItem>
                    <SelectItem value="STAFF">Staff</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <Label className="text-sm font-medium">Module Access</Label>
                {MODULE_KEYS.map((key) => (
                  <div
                    key={key}
                    className="flex items-center justify-between"
                    data-testid={`edit-module-${key}`}
                  >
                    <span className="text-sm">{MODULE_LABELS[key]}</span>
                    <Switch
                      checked={editModules[key]}
                      onCheckedChange={(checked) =>
                        setEditModules((prev) => ({ ...prev, [key]: checked }))
                      }
                      data-testid={`switch-edit-module-${key}`}
                    />
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">Branch Scope</Label>
                <Select value={editBranchScope} onValueChange={setEditBranchScope}>
                  <SelectTrigger data-testid="select-edit-branch-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Branches</SelectItem>
                    <SelectItem value="SELECTED">Selected Branches</SelectItem>
                  </SelectContent>
                </Select>
                {editBranchScope === "SELECTED" && (
                  <div className="space-y-1.5 pl-2 pt-1">
                    {branches.map((branch) => (
                      <div key={branch.id} className="flex items-center gap-2">
                        <Checkbox
                          checked={editBranchIds.includes(branch.id)}
                          onCheckedChange={(checked) => {
                            setEditBranchIds((prev) =>
                              checked
                                ? [...prev, branch.id]
                                : prev.filter((id) => id !== branch.id)
                            );
                          }}
                          data-testid={`checkbox-edit-branch-${branch.id}`}
                        />
                        <Label className="text-sm">{branch.name}</Label>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {editPerson.moduleOverrides.length > 0 && (
                <div className="space-y-2 pt-2 border-t">
                  <Label className="text-sm font-medium text-muted-foreground">
                    Granular Module Overrides
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    This person has {editPerson.moduleOverrides.length} granular override(s) configured in their profile.
                    Edit those from the employee/advisor detail page.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {editPerson.moduleOverrides.map((o) => (
                      <Badge
                        key={o.moduleKey}
                        variant={o.enabled ? "default" : "secondary"}
                        className="text-xs"
                      >
                        {o.moduleKey}: {o.enabled ? "On" : "Off"}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditPerson(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={updateAccessMutation.isPending}
              data-testid="button-save-permissions"
            >
              {updateAccessMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}