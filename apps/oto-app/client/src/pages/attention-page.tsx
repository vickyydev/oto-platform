import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link, useLocation, useSearch } from "wouter";
import {
  AlertTriangle,
  CheckCircle,
  FileText,
  UserMinus,
  Clock,
  Calendar,
  RefreshCw,
  AlertCircle,
  UserCheck,
  Camera,
  KeyRound,
  Plane,
  Briefcase,
  Package,
  FileWarning,
  Wrench,
  BellOff,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AttentionItem, Employee } from "@shared/schema";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { useBranchContext } from "@/hooks/use-branch-context";
import { formatDate, formatDateTime } from "@/lib/format-utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { ProbationReviewsPanel } from "@/pages/reviews-page";

interface AttentionResponse {
  items: AttentionItem[];
  lastCalculatedAt: string | null;
  paused?: boolean;
}

interface AttentionTypeConfig {
  label: string;
  icon: React.ElementType;
  color: string;
}

const typeConfigs: Record<string, AttentionTypeConfig> = {
  CONTRACT_NOT_SENT: {
    label: "Contract Not Sent",
    icon: FileText,
    color: "text-amber-600 dark:text-amber-400",
  },
  CONTRACT_NOT_SIGNED: {
    label: "Awaiting Signature",
    icon: Clock,
    color: "text-blue-600 dark:text-blue-400",
  },
  CHANGE_NO_CONTRACT: {
    label: "Missing Contract",
    icon: FileText,
    color: "text-orange-600 dark:text-orange-400",
  },
  UNSIGNED_EMPLOYMENT_CONTRACT: {
    label: "Unsigned Employment",
    icon: FileWarning,
    color: "text-red-600 dark:text-red-400",
  },
  TERMS_CHANGED_REQUIRES_NEW_CONTRACT: {
    label: "Terms Changed",
    icon: FileWarning,
    color: "text-orange-600 dark:text-orange-400",
  },
  PROBATION_REVIEW_DUE_SOON: {
    label: "Probation Review Due",
    icon: Calendar,
    color: "text-purple-600 dark:text-purple-400",
  },
  PROBATION_REVIEW_OVERDUE: {
    label: "Probation Overdue",
    icon: AlertTriangle,
    color: "text-red-600 dark:text-red-400",
  },
  MISSING_OFFBOARD_DOC: {
    label: "Missing Document",
    icon: UserMinus,
    color: "text-red-600 dark:text-red-400",
  },
  OFFBOARDING_DATES_INCOMPLETE: {
    label: "Incomplete Offboarding",
    icon: UserMinus,
    color: "text-gray-600 dark:text-gray-400",
  },
  OFFBOARDING_LETTER_UNSIGNED: {
    label: "Offboarding Unsigned",
    icon: FileText,
    color: "text-amber-600 dark:text-amber-400",
  },
  VISA_EXPIRING: {
    label: "Visa Expiring",
    icon: Plane,
    color: "text-rose-600 dark:text-rose-400",
  },
  WORK_PERMIT_EXPIRING: {
    label: "Work Permit Expiring",
    icon: Briefcase,
    color: "text-rose-600 dark:text-rose-400",
  },
  MISSING_VISA_WP_POLICY: {
    label: "Missing Visa/WP Info",
    icon: AlertTriangle,
    color: "text-amber-600 dark:text-amber-400",
  },
  EMPLOYEE_UNSIGNED: {
    label: "Employee Unsigned",
    icon: UserCheck,
    color: "text-orange-600 dark:text-orange-400",
  },
  COMPANY_PROPERTY_NOT_RETURNED: {
    label: "Property Not Returned",
    icon: Package,
    color: "text-red-600 dark:text-red-400",
  },
  FACE_ENROLLMENT_REQUIRED: {
    label: "Face Enrollment",
    icon: Camera,
    color: "text-blue-600 dark:text-blue-400",
  },
  FREQUENT_PIN_USAGE: {
    label: "Frequent PIN Usage",
    icon: KeyRound,
    color: "text-amber-600 dark:text-amber-400",
  },
  TIMEKEEPING_ANOMALY_REQUIRES_ACTION: {
    label: "Timekeeping Issue",
    icon: Clock,
    color: "text-red-600 dark:text-red-400",
  },
};

function SeverityBadge({ severity }: { severity: string }) {
  const variants = {
    high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800",
    urgent: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800",
    medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800",
    low: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700",
  };

  return (
    <Badge variant="outline" className={variants[severity as keyof typeof variants] || variants.low}>
      {severity === "urgent" ? "Urgent" : severity}
    </Badge>
  );
}

function getFixAction(item: AttentionItem): { label: string; href: string } | null {
  const baseEmployeeUrl = item.employeeId ? `/employees/${item.employeeId}` : null;
  
  switch (item.type) {
    case "CONTRACT_NOT_SENT":
    case "CONTRACT_NOT_SIGNED":
      return item.contractInstanceId 
        ? { label: "View Contract", href: `/contracts/${item.contractInstanceId}` }
        : null;
    case "CHANGE_NO_CONTRACT":
    case "UNSIGNED_EMPLOYMENT_CONTRACT":
    case "EMPLOYEE_UNSIGNED":
      return baseEmployeeUrl 
        ? { label: "View Employee", href: baseEmployeeUrl }
        : null;
    case "PROBATION_REVIEW_DUE_SOON":
    case "PROBATION_REVIEW_OVERDUE":
      return baseEmployeeUrl 
        ? { label: "View Employee", href: baseEmployeeUrl }
        : null;
    case "MISSING_OFFBOARD_DOC":
    case "OFFBOARDING_DATES_INCOMPLETE":
    case "OFFBOARDING_LETTER_UNSIGNED":
      return baseEmployeeUrl 
        ? { label: "View Employee", href: baseEmployeeUrl }
        : null;
    case "VISA_EXPIRING":
    case "WORK_PERMIT_EXPIRING":
    case "MISSING_VISA_WP_POLICY":
      return baseEmployeeUrl 
        ? { label: "View Employee", href: baseEmployeeUrl }
        : null;
    case "COMPANY_PROPERTY_NOT_RETURNED":
      return baseEmployeeUrl 
        ? { label: "View Employee", href: baseEmployeeUrl }
        : null;
    case "FACE_ENROLLMENT_REQUIRED":
    case "FREQUENT_PIN_USAGE":
      return baseEmployeeUrl 
        ? { label: "View Employee", href: baseEmployeeUrl }
        : null;
    case "TIMEKEEPING_ANOMALY_REQUIRES_ACTION":
      return baseEmployeeUrl 
        ? { label: "View Timekeeping", href: `/timekeeping-review/employee/${item.employeeId}` }
        : null;
    default:
      return null;
  }
}

function AttentionItemCard({
  item,
  employees,
  onResolve,
  onSnooze,
  isResolving,
  isSnoozing,
  readOnly,
}: {
  item: AttentionItem;
  employees: Employee[];
  onResolve: (id: string) => void;
  onSnooze: (id: string) => void;
  isResolving: boolean;
  isSnoozing: boolean;
  readOnly: boolean;
}) {
  const config = typeConfigs[item.type] || typeConfigs.CONTRACT_NOT_SENT;
  const Icon = config.icon;
  const employee = employees.find(e => e.id === item.employeeId);
  const fixAction = getFixAction(item);
  const [showWarning, setShowWarning] = useState(false);
  const [warningReason, setWarningReason] = useState<string | null>(null);
  const [checkingCondition, setCheckingCondition] = useState(false);

  const handleSnoozeClick = async () => {
    setCheckingCondition(true);
    try {
      const res = await apiRequest("GET", `/api/attention-items/${item.id}/check-condition`);
      const data = await res.json();
      if (data.conditionStillActive) {
        setWarningReason(data.reason);
        setShowWarning(true);
      } else {
        onSnooze(item.id);
      }
    } catch {
      onSnooze(item.id);
    } finally {
      setCheckingCondition(false);
    }
  };

  const confirmSnooze = () => {
    setShowWarning(false);
    onSnooze(item.id);
  };

  return (
    <>
      <Card className="hover-elevate" data-testid={`attention-item-${item.id}`}>
        <CardContent className="p-4">
          <div className="flex items-start gap-4">
            <div className={`flex h-10 w-10 items-center justify-center rounded-full bg-muted flex-shrink-0 ${config.color}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <h3 className="font-medium text-sm">{
                    // Replace full name with nickname in title if employee has nickname
                    employee?.nickname && employee?.fullName
                      ? item.title.replace(employee.fullName, employee.nickname)
                      : item.title
                  }</h3>
                  {item.description && (
                    <p className="text-sm text-muted-foreground mt-1">{item.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <SeverityBadge severity={item.severity} />
                  <Badge variant="outline" className="text-xs">
                    {config.label}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 mt-3 flex-wrap">
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  {employee && (
                    <Link href={`/employees/${employee.id}`}>
                      <div className="flex items-center gap-2 hover:underline cursor-pointer">
                        <EmployeeAvatar
                          employeeId={employee.id}
                          fullName={employee.fullName}
                          profilePhotoPath={employee.profilePhotoPath}
                          size="sm"
                        />
                        <span>{employee.nickname || employee.fullName}</span>
                      </div>
                    </Link>
                  )}
                  {item.dueDate && (
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3 text-muted-foreground" />
                      Due: {formatDate(item.dueDate)}
                    </span>
                  )}
                  <span>Created: {formatDate(item.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2">
                  {fixAction && (
                    <Link href={fixAction.href}>
                      <Button variant="default" size="sm" data-testid={`button-fix-${item.id}`}>
                        <Wrench className="mr-1 h-3 w-3" />
                        {fixAction.label}
                      </Button>
                    </Link>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSnoozeClick}
                    disabled={readOnly || isSnoozing || isResolving || checkingCondition}
                    data-testid={`button-snooze-${item.id}`}
                  >
                    <BellOff className="mr-1 h-4 w-4" />
                    {checkingCondition ? "Checking..." : "Snooze"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onResolve(item.id)}
                    disabled={readOnly || isResolving || isSnoozing || checkingCondition}
                    data-testid={`button-resolve-${item.id}`}
                  >
                    <CheckCircle className="mr-1 h-4 w-4" />
                    Resolve
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showWarning} onOpenChange={setShowWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Condition Still Active
            </AlertDialogTitle>
            <AlertDialogDescription>
              The underlying issue that triggered this alert is still present.
              {warningReason && (
                <span className="block mt-2 text-sm font-medium">{warningReason}</span>
              )}
              <span className="block mt-2">
                Are you sure you want to snooze this item? It will be hidden for 24 hours, then show again if the issue is still present.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-resolve">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSnooze} data-testid="button-confirm-resolve">
              Snooze Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function AttentionPage() {
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const { toast } = useToast();
  const search = useSearch();
  const [, navigate] = useLocation();
  const requestedTab = new URLSearchParams(search).get("tab");
  const activeTab = requestedTab === "probation" || requestedTab === "all" ? requestedTab : "priority";
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [snoozingId, setSnoozingId] = useState<string | null>(null);

  const buildUrl = () => {
    const params = new URLSearchParams();
    if (!isAllBranches && selectedBranchId) {
      params.set("branchId", selectedBranchId);
    }
    if (activeTab === "all" && typeFilter !== "all") {
      params.set("types", typeFilter);
    }
    params.set("limit", "100");
    return `/api/attention-items?${params.toString()}`;
  };

  const { data: attentionResponse, isLoading, isError, refetch } = useQuery<AttentionResponse>({
    queryKey: [buildUrl()],
  });

  const attentionItems = attentionResponse?.items || [];
  const lastCalculatedAt = attentionResponse?.lastCalculatedAt;
  const isPaused = attentionResponse?.paused === true;

  const { data: employees } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const invalidateAttentionQueries = () => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === "string" && key.startsWith("/api/attention-items");
      },
    });
    queryClient.invalidateQueries({ queryKey: ["/api/sidebar/badges"] });
  };

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/attention-items/refresh");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Attention items refreshed",
        description: data.message,
      });
      invalidateAttentionQueries();
    },
    onError: (err: unknown) => {
      // The server's refusal carries its own words (Q35: "already being
      // checked for this park group"); show them rather than a blind failure.
      toast({
        title: "Refresh failed",
        description:
          err instanceof Error && err.message ? err.message : "Could not refresh attention items",
        variant: "destructive",
      });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (id: string) => {
      setResolvingId(id);
      const res = await apiRequest("POST", `/api/attention-items/${id}/resolve`, { permanent: true });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Item resolved",
        description: "The attention item has been permanently resolved.",
      });
      invalidateAttentionQueries();
      setResolvingId(null);
    },
    onError: () => {
      toast({
        title: "Resolve failed",
        description: "Could not resolve the attention item",
        variant: "destructive",
      });
      setResolvingId(null);
    },
  });

  const snoozeMutation = useMutation({
    mutationFn: async (id: string) => {
      setSnoozingId(id);
      const res = await apiRequest("POST", `/api/attention-items/${id}/resolve`, { permanent: false });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Item snoozed",
        description: "The attention item has been snoozed for 24 hours.",
      });
      invalidateAttentionQueries();
      setSnoozingId(null);
    },
    onError: () => {
      toast({
        title: "Snooze failed",
        description: "Could not snooze the attention item",
        variant: "destructive",
      });
      setSnoozingId(null);
    },
  });

  const filteredItems = activeTab === "priority"
    ? attentionItems.filter(item => item.severity === "high" || (item.severity as string) === "urgent")
    : attentionItems.filter(item =>
        (typeFilter === "all" || item.type === typeFilter) &&
        (severityFilter === "all" || item.severity === severityFilter)
      );

  const highCount = filteredItems.filter(i => i.severity === "high" || (i.severity as string) === "urgent").length;
  const mediumCount = filteredItems.filter(i => i.severity === "medium").length;
  const lowCount = filteredItems.filter(i => i.severity === "low").length;

  return (
    <div className="px-4 py-6 sm:p-6 max-w-5xl mx-auto space-y-6 min-h-[100dvh]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground mb-2">Manager workspace</p>
          <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-2" data-testid="text-attention-title">
            Needs action
          </h1>
          <p className="text-muted-foreground mt-1">
            {`${isAllBranches ? "Across all branches" : "For the selected branch"} · Review what needs your attention.`}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {activeTab !== "probation" && lastCalculatedAt && (
            <span className="text-xs text-muted-foreground" data-testid="text-last-calculated">
              Last updated: {formatDateTime(lastCalculatedAt)}
            </span>
          )}
          {activeTab !== "probation" && <Button
            variant="outline"
            onClick={() => refreshMutation.mutate()}
            disabled={isPaused || refreshMutation.isPending}
            data-testid="button-refresh-attention"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
            Refresh
          </Button>}
        </div>
      </div>

      <nav aria-label="Needs action sections" className="flex gap-1 border-b border-border overflow-x-auto">
        {([
          ["priority", "Priority"],
          ["probation", "Probation"],
          ["all", "All"],
        ] as const).map(([tab, label]) => (
          <Link
            key={tab}
            href={`/attention?tab=${tab}`}
            aria-current={activeTab === tab ? "page" : undefined}
            onClick={(event) => {
              // Wouter's search hook observes query changes when navigation goes through the router.
              event.preventDefault();
              navigate(`/attention?tab=${tab}`);
            }}
            className={`inline-flex min-h-11 items-center px-4 border-b-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              activeTab === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {activeTab === "probation" ? <ProbationReviewsPanel /> : <>
      {isPaused && (
        <Card className="border-amber-300" role="status">
          <CardContent className="py-4 text-sm">
            Attention alerts are temporarily paused. Saved alerts are shown for reference; new alerts, refresh, snooze and resolve are unavailable.
          </CardContent>
        </Card>
      )}

      {activeTab === "priority" && <p className="text-sm text-muted-foreground">High and urgent items first. For every open item, use All.</p>}
      {activeTab === "all" && <div className="flex flex-wrap gap-4">

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Type:</span>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-type-filter">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="CONTRACT_NOT_SENT">Contract Not Sent</SelectItem>
              <SelectItem value="CONTRACT_NOT_SIGNED">Awaiting Signature</SelectItem>
              <SelectItem value="CHANGE_NO_CONTRACT">Missing Contract</SelectItem>
              <SelectItem value="UNSIGNED_EMPLOYMENT_CONTRACT">Unsigned Employment</SelectItem>
              <SelectItem value="TERMS_CHANGED_REQUIRES_NEW_CONTRACT">Terms Changed</SelectItem>
              <SelectItem value="EMPLOYEE_UNSIGNED">Employee Unsigned</SelectItem>
              <SelectItem value="PROBATION_REVIEW_DUE_SOON">Probation Review Due</SelectItem>
              <SelectItem value="PROBATION_REVIEW_OVERDUE">Probation Overdue</SelectItem>
              <SelectItem value="MISSING_OFFBOARD_DOC">Missing Document</SelectItem>
              <SelectItem value="OFFBOARDING_DATES_INCOMPLETE">Incomplete Offboarding</SelectItem>
              <SelectItem value="OFFBOARDING_LETTER_UNSIGNED">Offboarding Unsigned</SelectItem>
              <SelectItem value="VISA_EXPIRING">Visa Expiring</SelectItem>
              <SelectItem value="WORK_PERMIT_EXPIRING">Work Permit Expiring</SelectItem>
              <SelectItem value="MISSING_VISA_WP_POLICY">Missing Visa/WP Info</SelectItem>
              <SelectItem value="COMPANY_PROPERTY_NOT_RETURNED">Property Not Returned</SelectItem>
              <SelectItem value="FACE_ENROLLMENT_REQUIRED">Face Enrollment</SelectItem>
              <SelectItem value="FREQUENT_PIN_USAGE">Frequent PIN Usage</SelectItem>
              <SelectItem value="TIMEKEEPING_ANOMALY_REQUIRES_ACTION">Timekeeping Issue</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Severity:</span>
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger className="w-[120px]" data-testid="select-severity-filter">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>}

      <div className="flex flex-wrap gap-4 text-sm" aria-live="polite">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          {highCount} High / urgent
        </span>
        {activeTab === "all" && <>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          {mediumCount} Medium
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-gray-500" />
          {lowCount} Low
        </span>
        </>}
        <span className="text-muted-foreground">
          Total: {filteredItems.length} items
        </span>
      </div>

      {isError ? (
        <Card><CardContent className="py-10 text-center space-y-3" role="alert">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
          <p className="font-medium">Could not load attention alerts</p>
          <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
          <Button variant="outline" onClick={() => refetch()} data-testid="button-retry-attention">Try again</Button>
        </CardContent></Card>
      ) : isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="flex items-start gap-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-8 w-24" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredItems.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <CheckCircle className="h-12 w-12 mx-auto mb-3 text-green-500" />
            <p className="text-lg font-medium">
              {isPaused ? "No saved alerts in this view" : activeTab === "priority" ? "No priority items" : "All clear"}
            </p>
            <p className="text-sm">
              {isPaused
                ? "Automatic alerts are paused."
                : activeTab === "priority"
                  ? "No high or urgent attention items for this branch. Check All for the full list."
                  : "No attention items match these filters."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredItems.map((item) => (
            <AttentionItemCard
              key={item.id}
              item={item}
              employees={employees || []}
              onResolve={(id) => resolveMutation.mutate(id)}
              onSnooze={(id) => snoozeMutation.mutate(id)}
              isResolving={resolvingId === item.id}
              isSnoozing={snoozingId === item.id}
              readOnly={isPaused}
            />
          ))}
        </div>
      )}
      </>}
    </div>
  );
}
