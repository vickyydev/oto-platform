import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Activity,
  Search,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  X,
  Filter,
} from "lucide-react";
import { ActivityLog, activityTypes, Branch } from "@shared/schema";
import { useBranchContext } from "@/hooks/use-branch-context";
import { format, formatDistanceToNow } from "date-fns";

const PAGE_SIZE = 20;

const activityTypeLabels: Record<string, string> = {
  promotion: "Promotion",
  salary_change: "Salary Change",
  incentive_change: "Incentive Change",
  employment_ended: "Employment Ended",
  contract_created: "Contract Created",
  contract_finalized: "Contract Finalized",
  contract_sent: "Contract Sent",
  contract_resent: "Contract Resent",
  signing_link_created: "Signing Link Created",
  contract_signed: "Contract Signed",
  contract_activated: "Contract Activated",
  contract_superseded: "Contract Superseded",
  employee_created: "Employee Added",
  employee_updated: "Employee Updated",
  branch_transfer: "Branch Transfer",
  probation_completed: "Probation Completed",
  policy_created: "Policy Created",
  policy_published: "Policy Published",
  policy_archived: "Policy Archived",
  policy_attached: "Policy Attached",
  policy_acknowledged: "Policy Acknowledged",
  USER_CREATED: "User Created",
  USER_DISABLED: "User Disabled",
  USER_ENABLED: "User Enabled",
  USER_PASSWORD_RESET_BY_ADMIN: "Password Reset by Admin",
  USER_PASSWORD_CHANGED: "Password Changed",
  attention_item_created: "Attention Item Created",
  attention_item_resolved: "Attention Item Resolved",
  template_created: "Template Created",
  template_updated: "Template Updated",
};

const activityTypeColors: Record<string, string> = {
  promotion: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  salary_change: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  incentive_change: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  employment_ended: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  contract_created: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  contract_finalized: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  contract_sent: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  contract_resent: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  signing_link_created: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  contract_signed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  contract_activated: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  contract_superseded: "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200",
  employee_created: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  employee_updated: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  branch_transfer: "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200",
  probation_completed: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
  policy_created: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  policy_published: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  policy_archived: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200",
  policy_attached: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  policy_acknowledged: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  USER_CREATED: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  USER_DISABLED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  USER_ENABLED: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  USER_PASSWORD_RESET_BY_ADMIN: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  USER_PASSWORD_CHANGED: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  attention_item_created: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  attention_item_resolved: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  template_created: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  template_updated: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "dd-MM-yyyy");
}

export default function ActivityLogbookPage() {
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const [page, setPage] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const buildQueryUrl = () => {
    const params = new URLSearchParams();
    
    if (!isAllBranches && selectedBranchId) {
      params.set("branchId", selectedBranchId);
    }
    
    if (selectedTypes.length > 0) {
      params.set("types", selectedTypes.join(","));
    }
    
    if (searchText.trim()) {
      params.set("search", searchText.trim());
    }
    
    if (dateFrom) {
      params.set("dateFrom", dateFrom.toISOString());
    }
    
    if (dateTo) {
      params.set("dateTo", dateTo.toISOString());
    }
    
    params.set("limit", PAGE_SIZE.toString());
    params.set("offset", (page * PAGE_SIZE).toString());
    
    return `/api/activity-logs?${params.toString()}`;
  };

  const queryUrl = buildQueryUrl();

  const { data, isLoading } = useQuery<{ logs: ActivityLog[]; totalCount: number }>({
    queryKey: [queryUrl],
  });

  const totalPages = Math.ceil((data?.totalCount || 0) / PAGE_SIZE);

  const handleClearFilters = () => {
    setSearchText("");
    setSelectedTypes([]);
    setDateFrom(undefined);
    setDateTo(undefined);
    setPage(0);
  };

  const hasActiveFilters = searchText.trim() || selectedTypes.length > 0 || dateFrom || dateTo;

  const getBranchName = (branchId: string | null) => {
    if (!branchId) return "All Branches";
    const branch = branches?.find(b => b.id === branchId);
    return branch?.name || "Unknown Branch";
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-medium flex items-center gap-3" data-testid="text-activity-logbook-title">
          <Activity className="h-8 w-8" />
          Activity Logbook
        </h1>
        <p className="text-muted-foreground">
          Complete history of all activities and changes across the system
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
          <CardDescription>Filter activity logs by type, date, or search text</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search activities..."
                  value={searchText}
                  onChange={(e) => {
                    setSearchText(e.target.value);
                    setPage(0);
                  }}
                  className="pl-9"
                  data-testid="input-search-activity"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Activity Type</label>
              <Select
                value={selectedTypes.length === 1 ? selectedTypes[0] : ""}
                onValueChange={(value) => {
                  setSelectedTypes(value ? [value] : []);
                  setPage(0);
                }}
              >
                <SelectTrigger data-testid="select-activity-type">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {activityTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {activityTypeLabels[type] || type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">From Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                    data-testid="button-date-from"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4 text-foreground" />
                    {dateFrom ? formatDate(dateFrom) : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateFrom}
                    onSelect={(date) => {
                      setDateFrom(date);
                      setPage(0);
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">To Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                    data-testid="button-date-to"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4 text-foreground" />
                    {dateTo ? formatDate(dateTo) : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateTo}
                    onSelect={(date) => {
                      setDateTo(date);
                      setPage(0);
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {hasActiveFilters && (
            <div className="mt-4 flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearFilters}
                data-testid="button-clear-filters"
              >
                <X className="mr-1 h-4 w-4" />
                Clear all filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Activity History</CardTitle>
            <CardDescription>
              {data?.totalCount !== undefined
                ? `${data.totalCount} ${data.totalCount === 1 ? "entry" : "entries"} found`
                : "Loading..."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.logs && data.logs.length > 0 ? (
            <div className="space-y-4">
              {data.logs.map((log) => {
                // Determine the link destination based on activity type and IDs
                const getActivityLink = () => {
                  // Contract-related activities - link to contract detail
                  if (log.contractInstanceId) {
                    return `/contracts/${log.contractInstanceId}`;
                  }
                  // Employee-related activities - link to employee editor
                  if (log.employeeId) {
                    return `/employees/${log.employeeId}`;
                  }
                  // Template-related activities
                  if (log.templateId) {
                    return `/templates/${log.templateId}`;
                  }
                  // Policy-related activities - link to policies page
                  if (log.activityType.startsWith("policy_")) {
                    return "/policies";
                  }
                  // User-related activities - link to users page
                  if (["USER_CREATED", "USER_DISABLED", "USER_ENABLED", "USER_PASSWORD_RESET_BY_ADMIN"].includes(log.activityType)) {
                    return "/users";
                  }
                  // Attention item activities - link to dashboard (attention section)
                  if (log.attentionItemId || log.activityType.startsWith("attention_")) {
                    return "/";
                  }
                  return null;
                };
                
                const link = getActivityLink();
                const content = (
                  <div
                    className={`flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-md border ${link ? "hover-elevate cursor-pointer" : ""}`}
                    data-testid={`activity-log-${log.id}`}
                  >
                    <div className="flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          className={`${activityTypeColors[log.activityType] || "bg-secondary text-secondary-foreground"} no-default-hover-elevate no-default-active-elevate`}
                          data-testid={`badge-type-${log.id}`}
                        >
                          {activityTypeLabels[log.activityType] || log.activityType}
                        </Badge>
                        {isAllBranches && log.branchId && (
                          <Badge variant="outline" className="no-default-hover-elevate no-default-active-elevate">
                            {getBranchName(log.branchId)}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-foreground">{(log.summaryText || "").replace(/undefined undefined/g, "Unknown").replace(/for undefined\b/g, "for Unknown").replace(/\bundefined\b/g, "Unknown")}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 text-right shrink-0">
                      <span className="text-sm font-medium">{formatDate(log.createdAt)}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                );
                
                return link ? (
                  <Link key={log.id} href={link}>
                    {content}
                  </Link>
                ) : (
                  <div key={log.id}>{content}</div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8">
              <Activity className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
              <p className="text-muted-foreground">No activity logs found</p>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  className="mt-2"
                  onClick={handleClearFilters}
                  data-testid="button-clear-filters-empty"
                >
                  Clear filters to see all activity
                </Button>
              )}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-6 pt-4 border-t">
              <div className="text-sm text-muted-foreground">
                Page {page + 1} of {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                  disabled={page >= totalPages - 1}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
