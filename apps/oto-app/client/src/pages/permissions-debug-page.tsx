import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield, Search, ChevronDown, ChevronRight, CheckCircle, XCircle, Filter, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MODULES, MODULE_KEYS, type ModuleKey, type EffectivePermissions, type EffectiveModulePermission } from "@shared/permissions";

interface DebugUserEntry {
  userId: number;
  username: string;
  role: string;
  homeBranchId: string | null;
  overrideCount: number;
  effective: EffectivePermissions;
}

interface Branch {
  id: string;
  name: string;
}

export default function PermissionsDebugPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());

  const { data: debugData = [], isLoading } = useQuery<DebugUserEntry[]>({
    queryKey: ["/api/permissions/debug/all"],
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const branchMap = useMemo(() => {
    const map: Record<string, string> = {};
    branches.forEach(b => { map[b.id] = b.name; });
    return map;
  }, [branches]);

  const filtered = useMemo(() => {
    let result = debugData;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(u => u.username.toLowerCase().includes(term) || u.role.toLowerCase().includes(term));
    }
    if (roleFilter !== "all") {
      result = result.filter(u => u.role === roleFilter);
    }
    if (moduleFilter !== "all") {
      result = result.filter(u => {
        const mod = u.effective.modules.find(m => m.moduleKey === moduleFilter);
        return mod?.allowed;
      });
    }
    return result;
  }, [debugData, searchTerm, roleFilter, moduleFilter]);

  const toggleExpanded = (userId: number) => {
    setExpandedUsers(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const roles = useMemo(() => {
    const set = new Set(debugData.map(u => u.role));
    return Array.from(set).sort();
  }, [debugData]);

  const stats = useMemo(() => {
    const total = debugData.length;
    const withOverrides = debugData.filter(u => u.overrideCount > 0).length;
    const byRole: Record<string, number> = {};
    debugData.forEach(u => { byRole[u.role] = (byRole[u.role] || 0) + 1; });
    return { total, withOverrides, byRole };
  }, [debugData]);

  function sourceLabel(source: string) {
    switch (source) {
      case "admin_bypass": return "Admin";
      case "override": return "Override";
      case "role_default": return "Role";
      default: return source;
    }
  }

  function sourceVariant(source: string): "default" | "secondary" | "outline" | "destructive" {
    switch (source) {
      case "admin_bypass": return "default";
      case "override": return "secondary";
      default: return "outline";
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <Shield className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Permissions Debug</h1>
          <p className="text-muted-foreground text-sm">View effective permissions for all users in the system</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Total Users</p>
            <p className="text-2xl font-bold" data-testid="text-total-users">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">With Overrides</p>
            <p className="text-2xl font-bold" data-testid="text-with-overrides">{stats.withOverrides}</p>
          </CardContent>
        </Card>
        {Object.entries(stats.byRole).slice(0, 2).map(([role, count]) => (
          <Card key={role}>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm text-muted-foreground capitalize">{role}</p>
              <p className="text-2xl font-bold">{count}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by username..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search-users"
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-role-filter">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue placeholder="All Roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            {roles.map(r => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={moduleFilter} onValueChange={setModuleFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-module-filter">
            <SelectValue placeholder="All Modules" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modules</SelectItem>
            {MODULE_KEYS.map(key => (
              <SelectItem key={key} value={key}>{MODULES[key].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading permissions data...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <Users className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground">No users found matching your criteria</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(user => {
            const isExpanded = expandedUsers.has(user.userId);
            const allowedCount = user.effective.modules.filter(m => m.allowed).length;
            const totalCount = user.effective.modules.length;

            return (
              <Collapsible key={user.userId} open={isExpanded} onOpenChange={() => toggleExpanded(user.userId)}>
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover-elevate py-3">
                      <div className="flex items-center justify-between gap-4 flex-wrap">
                        <div className="flex items-center gap-3">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          <div>
                            <p className="font-medium" data-testid={`text-username-${user.userId}`}>{user.username}</p>
                            <p className="text-xs text-muted-foreground">
                              {user.homeBranchId ? branchMap[user.homeBranchId] || user.homeBranchId : "No home branch"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="capitalize">{user.role}</Badge>
                          <Badge variant="secondary">{allowedCount}/{totalCount} modules</Badge>
                          {user.overrideCount > 0 && (
                            <Badge variant="default">{user.overrideCount} override{user.overrideCount > 1 ? "s" : ""}</Badge>
                          )}
                          <div className="flex gap-0.5">
                            {user.effective.modules.map(m => (
                              <div
                                key={m.moduleKey}
                                className={`h-2 w-2 rounded-full ${m.allowed ? "bg-green-500" : "bg-muted-foreground/30"}`}
                                title={`${MODULES[m.moduleKey].label}: ${m.allowed ? "Allowed" : "Denied"}`}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pt-0 pb-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {user.effective.modules.map((mod: EffectiveModulePermission) => (
                          <div
                            key={mod.moduleKey}
                            className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/50"
                            data-testid={`row-module-${user.userId}-${mod.moduleKey}`}
                          >
                            <div className="flex items-center gap-2">
                              {mod.allowed ? (
                                <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                              ) : (
                                <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                              )}
                              <span className="text-sm">{MODULES[mod.moduleKey].label}</span>
                            </div>
                            <div className="flex items-center gap-1 flex-wrap justify-end">
                              <Badge variant={sourceVariant(mod.source)} className="text-xs">
                                {sourceLabel(mod.source)}
                              </Badge>
                              {mod.branchScope && (
                                <Badge variant="outline" className="text-xs">
                                  {mod.branchScope === "HOME_ONLY" ? "Home" : mod.branchScope === "ALL" ? "All" : "Custom"}
                                </Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 flex gap-2 flex-wrap">
                        <p className="text-xs text-muted-foreground">
                          App Modes: {user.effective.appModes.join(", ") || "None"}
                        </p>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
}
