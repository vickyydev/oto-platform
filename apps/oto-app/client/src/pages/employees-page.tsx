import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useSearch, useLocation } from "wouter";
import { EmployeeWithAccess, Branch, ContractInstance, type AccessSummary, type LeaveBalance, type Department } from "@shared/schema";
import { useState, useEffect, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Users, Edit, Trash2, Mail, Phone, MapPin, Building2, Eye, FileX, X, FileSignature, History, Upload, Shield, UserCheck, GripVertical, ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle, Scan, PenTool, KeyRound, CheckSquare, Square, Briefcase, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { useAvatarWorkStatus, type AvatarWorkStatus } from "@/hooks/use-avatar-work-status";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityPreviewTooltip } from "@/components/activity-preview-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DndContext, DragEndEvent, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

function EmployeeStatusIcons({ employeeId }: { employeeId: string }) {
  const { data, isLoading, error } = useQuery<{
    isOnboardingComplete: boolean;
    steps: {
      step4_contractSigned?: { complete: boolean };
      step5_loginCreated?: { complete: boolean };
      step6_faceEnrollment?: { complete: boolean };
    };
  }>({
    queryKey: ["/api/employees", employeeId, "onboarding-status"],
    enabled: !!employeeId,
  });

  if (isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }

  if (error || !data) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const contractSigned = data.steps.step4_contractSigned?.complete ?? false;
  const loginCreated = data.steps.step5_loginCreated?.complete ?? false;
  const faceEnrolled = data.steps.step6_faceEnrollment?.complete ?? false;

  return (
    <div className="flex items-center gap-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={contractSigned ? "text-green-600" : "text-red-500"}>
            <PenTool className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{contractSigned ? "Contract signed" : "Contract not signed"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={loginCreated ? "text-green-600" : "text-red-500"}>
            <KeyRound className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{loginCreated ? "Login enabled" : "No login"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={faceEnrolled ? "text-green-600" : "text-red-500"}>
            <Scan className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{faceEnrolled ? "Face enrolled" : "Face not enrolled"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function EmployeesTableSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-9 w-20" />
        </div>
      ))}
    </div>
  );
}

// Employee row component for reuse in both flat and grouped views
function EmployeeTableRow({
  employee,
  canEdit,
  canDelete,
  isAllBranches,
  branchMap,
  leaveBalanceMap,
  deleteMutation,
  isSelected,
  onToggleSelect,
  workStatus,
}: {
  employee: EmployeeWithAccess;
  canEdit: boolean;
  canDelete: boolean;
  isAllBranches: boolean;
  branchMap: Map<string, Branch>;
  leaveBalanceMap: Map<string, LeaveBalance>;
  deleteMutation: { mutate: (id: string) => void };
  isSelected?: boolean;
  onToggleSelect?: () => void;
  workStatus?: AvatarWorkStatus;
}) {
  return (
    <TableRow data-testid={`employee-row-${employee.id}`}>
      {canDelete && onToggleSelect && (
        <TableCell className="w-10">
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleSelect}
            data-testid={`checkbox-select-${employee.id}`}
          />
        </TableCell>
      )}
      <TableCell>
        <Link href={`/employees/${employee.id}`} className="block">
          <div className="flex items-center gap-3 hover-elevate rounded-md p-1 -m-1 cursor-pointer">
            <EmployeeAvatar
              employeeId={employee.id}
              fullName={employee.fullName}
              profilePhotoPath={employee.profilePhotoPath}
              size="md"
              workStatus={workStatus}
            />
            <div>
              <p className="font-medium">{employee.fullName}</p>
              <p className="text-sm text-muted-foreground">{employee.nickname || employee.email}</p>
            </div>
          </div>
        </Link>
      </TableCell>
      {isAllBranches && (
        <TableCell>
          <div className="flex items-center gap-1 text-sm">
            <Building2 className="h-3 w-3 text-muted-foreground" />
            <span>{branchMap.get(employee.branchId || "")?.name || "Unknown"}</span>
          </div>
        </TableCell>
      )}
      <TableCell>
        <span className="text-sm">{employee.defaultMergeData?.positionTitle || "—"}</span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {(() => {
            const isInProbation = employee.status === "active" && 
              employee.probationEndDate && 
              new Date(employee.probationEndDate) > new Date() &&
              !employee.probationReviewCompletedAt;
            
            let displayStatus: string = employee.status;
            let badgeColor = "";
            
            if (employee.employmentState === "LEAVING") {
              displayStatus = "Leaving";
              badgeColor = "bg-amber-600";
            } else if (employee.employmentState === "LEFT") {
              displayStatus = "Left";
              badgeColor = "";
            } else if (isInProbation) {
              displayStatus = "Probation";
              badgeColor = "bg-blue-600";
            } else if (employee.status === "active") {
              displayStatus = "Active";
              badgeColor = "bg-green-600";
            }
            
            return (
              <Badge 
                variant={employee.status === "active" ? "default" : "secondary"}
                className={badgeColor}
              >
                {displayStatus}
              </Badge>
            );
          })()}
        </div>
      </TableCell>
      <TableCell>
        <EmployeeStatusIcons employeeId={employee.id} />
      </TableCell>
      <TableCell>
        {employee.accessSummary ? (
          <div className="flex flex-wrap gap-1">
            <Badge variant="outline" className="text-xs px-1.5 py-0 leading-tight">{employee.accessSummary.accessLevel}</Badge>
            {employee.accessSummary.modules.hr && employee.accessSummary.modules.core && employee.accessSummary.modules.studio && employee.accessSummary.modules.events && employee.accessSummary.modules.ops && employee.accessSummary.modules.setup ? (
              <Badge variant="secondary" className="text-xs px-1.5 py-0">All</Badge>
            ) : (
              <>
                {employee.accessSummary.modules.hr && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">HR</Badge>
                )}
                {employee.accessSummary.modules.core && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Today</Badge>
                )}
                {employee.accessSummary.modules.ops && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Ops</Badge>
                )}
                {employee.accessSummary.modules.studio && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Studio</Badge>
                )}
                {employee.accessSummary.modules.events && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Events</Badge>
                )}
                {employee.accessSummary.modules.setup && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Setup</Badge>
                )}
              </>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <ActivityPreviewTooltip employeeId={employee.id}>
            <Button variant="ghost" size="icon" data-testid={`button-activity-${employee.id}`}>
              <History className="h-4 w-4 text-muted-foreground" />
            </Button>
          </ActivityPreviewTooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link href={`/employees/${employee.id}`}>
                <Button variant="ghost" size="icon" data-testid={`button-${canEdit ? 'edit' : 'view'}-${employee.id}`}>
                  {canEdit ? <Edit className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </Link>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{canEdit ? "Edit" : "View"}</p>
            </TooltipContent>
          </Tooltip>
          {canEdit && employee.status === "active" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/contracts/new?employeeId=${employee.id}`}>
                  <Button variant="ghost" size="icon" data-testid={`button-create-contract-${employee.id}`}>
                    <FileSignature className="h-4 w-4" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Contract</p>
              </TooltipContent>
            </Tooltip>
          )}
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid={`button-delete-${employee.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Employee</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete {employee.fullName}? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteMutation.mutate(employee.id)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

// Sortable employee row wrapper for drag-and-drop reordering
function SortableEmployeeTableRow({
  employee,
  canEdit,
  canDelete,
  isAllBranches,
  branchMap,
  leaveBalanceMap,
  deleteMutation,
  canDrag,
  workStatus,
}: {
  employee: EmployeeWithAccess;
  canEdit: boolean;
  canDelete: boolean;
  isAllBranches: boolean;
  branchMap: Map<string, Branch>;
  leaveBalanceMap: Map<string, LeaveBalance>;
  deleteMutation: { mutate: (id: string) => void };
  canDrag: boolean;
  workStatus?: AvatarWorkStatus;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `emp-${employee.id}`, disabled: !canDrag });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <TableRow 
      ref={setNodeRef} 
      style={style}
      data-testid={`employee-row-${employee.id}`}
    >
      {canDrag && (
        <TableCell className="w-8">
          <div 
            {...attributes} 
            {...listeners} 
            className="cursor-grab active:cursor-grabbing p-1"
          >
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
        </TableCell>
      )}
      <TableCell>
        <Link href={`/employees/${employee.id}`} className="block">
          <div className="flex items-center gap-3 hover-elevate rounded-md p-1 -m-1 cursor-pointer">
            <EmployeeAvatar
              employeeId={employee.id}
              fullName={employee.fullName}
              profilePhotoPath={employee.profilePhotoPath}
              size="md"
              workStatus={workStatus}
            />
            <div>
              <p className="font-medium">{employee.fullName}</p>
              <p className="text-sm text-muted-foreground">{employee.nickname || employee.email}</p>
            </div>
          </div>
        </Link>
      </TableCell>
      {isAllBranches && (
        <TableCell>
          <div className="flex items-center gap-1 text-sm">
            <Building2 className="h-3 w-3 text-muted-foreground" />
            <span>{branchMap.get(employee.branchId || "")?.name || "Unknown"}</span>
          </div>
        </TableCell>
      )}
      <TableCell>
        <span className="text-sm">{employee.defaultMergeData?.positionTitle || "—"}</span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {(() => {
            const isInProbation = employee.status === "active" && 
              employee.probationEndDate && 
              new Date(employee.probationEndDate) > new Date() &&
              !employee.probationReviewCompletedAt;
            
            let displayStatus: string = employee.status;
            let badgeColor = "";
            
            if (employee.employmentState === "LEAVING") {
              displayStatus = "Leaving";
              badgeColor = "bg-amber-600";
            } else if (employee.employmentState === "LEFT") {
              displayStatus = "Left";
              badgeColor = "";
            } else if (isInProbation) {
              displayStatus = "Probation";
              badgeColor = "bg-blue-600";
            } else if (employee.status === "active") {
              displayStatus = "Active";
              badgeColor = "bg-green-600";
            }
            
            return (
              <Badge 
                variant={employee.status === "active" ? "default" : "secondary"}
                className={badgeColor}
              >
                {displayStatus}
              </Badge>
            );
          })()}
        </div>
      </TableCell>
      <TableCell>
        {(() => {
          const balance = leaveBalanceMap.get(employee.id);
          if (!balance) return <span className="text-sm text-muted-foreground">—</span>;
          const isPositive = balance.balance > 0;
          const isNegative = balance.balance < 0;
          return (
            <div className="flex flex-col gap-0.5">
              <Badge 
                variant={isNegative ? "destructive" : isPositive ? "default" : "secondary"}
                className={isPositive ? "bg-green-600" : ""}
              >
                {balance.balance >= 0 ? balance.balance : balance.balance} days
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {balance.daysEarned} earned, {balance.daysUsed} used
              </span>
            </div>
          );
        })()}
      </TableCell>
      <TableCell>
        <EmployeeStatusIcons employeeId={employee.id} />
      </TableCell>
      <TableCell>
        {employee.accessSummary ? (
          <div className="flex flex-wrap gap-1">
            <Badge variant="outline" className="text-xs px-1.5 py-0 leading-tight">{employee.accessSummary.accessLevel}</Badge>
            {employee.accessSummary.modules.hr && employee.accessSummary.modules.core && employee.accessSummary.modules.studio && employee.accessSummary.modules.events && employee.accessSummary.modules.ops && employee.accessSummary.modules.setup ? (
              <Badge variant="secondary" className="text-xs px-1.5 py-0">All</Badge>
            ) : (
              <>
                {employee.accessSummary.modules.hr && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">HR</Badge>
                )}
                {employee.accessSummary.modules.core && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Today</Badge>
                )}
                {employee.accessSummary.modules.ops && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Ops</Badge>
                )}
                {employee.accessSummary.modules.studio && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Studio</Badge>
                )}
                {employee.accessSummary.modules.events && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Events</Badge>
                )}
                {employee.accessSummary.modules.setup && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">Setup</Badge>
                )}
              </>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <ActivityPreviewTooltip employeeId={employee.id}>
            <Button variant="ghost" size="icon" data-testid={`button-activity-${employee.id}`}>
              <History className="h-4 w-4 text-muted-foreground" />
            </Button>
          </ActivityPreviewTooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link href={`/employees/${employee.id}`}>
                <Button variant="ghost" size="icon" data-testid={`button-${canEdit ? 'edit' : 'view'}-${employee.id}`}>
                  {canEdit ? <Edit className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </Link>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{canEdit ? "Edit" : "View"}</p>
            </TooltipContent>
          </Tooltip>
          {canEdit && employee.status === "active" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href={`/contracts/new?employeeId=${employee.id}`}>
                  <Button variant="ghost" size="icon" data-testid={`button-create-contract-${employee.id}`}>
                    <FileSignature className="h-4 w-4" />
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Contract</p>
              </TooltipContent>
            </Tooltip>
          )}
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid={`button-delete-${employee.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Employee</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete {employee.fullName}? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteMutation.mutate(employee.id)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

// Sortable department group component for drag-and-drop reordering
function SortableDepartmentGroup({ 
  id, 
  name, 
  employeeCount,
  isCollapsed,
  onToggleCollapse,
  children,
  canDrag,
}: { 
  id: string; 
  name: string;
  employeeCount: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  children: React.ReactNode;
  canDrag: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !canDrag });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="mb-4">
      <div 
        className="flex items-center gap-2 py-2 px-3 bg-muted/50 rounded-t-md border-b cursor-pointer hover-elevate"
        onClick={onToggleCollapse}
      >
        {canDrag && (
          <div 
            {...attributes} 
            {...listeners} 
            className="cursor-grab active:cursor-grabbing p-1 -m-1"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="flex items-center gap-2 flex-1">
          {isCollapsed ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-medium">{name}</span>
          <Badge variant="secondary" className="text-xs">
            {employeeCount}
          </Badge>
        </div>
      </div>
      {!isCollapsed && (
        <div className="border-x border-b rounded-b-md overflow-hidden">
          {children}
        </div>
      )}
    </div>
  );
}

function EmptyState({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="text-center py-16">
      <Users className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
      <h3 className="text-lg font-medium mb-2">No employees yet</h3>
      <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
        {canEdit 
          ? "Add your first employee to start generating contracts for them."
          : "No employees have been added to this branch yet."}
      </p>
      {canEdit && (
        <Button asChild data-testid="button-add-first-employee">
          <Link href="/employees/new">
            <Plus className="mr-2 h-4 w-4" />
            Add Employee
          </Link>
        </Button>
      )}
    </div>
  );
}

export default function EmployeesPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { selectedBranchId, isAllBranches, selectedBranch } = useBranchContext();
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  
  // Staff role has read-only access
  const canEdit = user?.role !== "staff";
  const canDelete = user?.role && ["admin", "global_admin", "operator_admin"].includes(user.role);
  const urlParams = new URLSearchParams(searchString);
  const initialFilter = urlParams.get("status") || "active";
  const initialUnsigned = urlParams.get("unsigned") === "true";
  
  const initialNoLogin = urlParams.get("nologin") === "true";
  
  const [statusFilter, setStatusFilter] = useState<string>(initialFilter);
  const [showUnsignedOnly, setShowUnsignedOnly] = useState(initialUnsigned);
  const [showNoLoginOnly, setShowNoLoginOnly] = useState(initialNoLogin);
  const [searchQuery, setSearchQuery] = useState("");
  
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const urlStatus = params.get("status") || "active";
    const urlUnsigned = params.get("unsigned") === "true";
    const urlNoLogin = params.get("nologin") === "true";
    if (urlStatus !== statusFilter) {
      setStatusFilter(urlStatus);
    }
    if (urlUnsigned !== showUnsignedOnly) {
      setShowUnsignedOnly(urlUnsigned);
    }
    if (urlNoLogin !== showNoLoginOnly) {
      setShowNoLoginOnly(urlNoLogin);
    }
  }, [searchString]);
  
  const { data: employees, isLoading } = useQuery<EmployeeWithAccess[]>({
    queryKey: ["/api/employees"],
  });

  const { data: contracts } = useQuery<ContractInstance[]>({
    queryKey: ["/api/contracts"],
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  // Fetch all departments (always enabled for grouping)
  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  // Collapsed state for departments
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());

  const toggleDeptCollapse = (deptId: string) => {
    setCollapsedDepts(prev => {
      const next = new Set(prev);
      if (next.has(deptId)) {
        next.delete(deptId);
      } else {
        next.add(deptId);
      }
      return next;
    });
  };

  // Reorder departments mutation
  const reorderDepartmentsMutation = useMutation({
    mutationFn: async (orderedIds: string[]) =>
      apiRequest("POST", "/api/departments/reorder", { orderedIds }),
    onMutate: async (orderedIds) => {
      const queryKey = ["/api/departments"];
      await queryClient.cancelQueries({ queryKey });
      const previousData = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: Department[] | undefined) => {
        if (!old) return old;
        return orderedIds.map(id => old.find(d => d.id === id)).filter(Boolean) as Department[];
      });
      return { previousData };
    },
    onError: (_err, _orderedIds, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["/api/departments"], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
    },
  });

  // Reorder employees mutation with optimistic update
  const reorderEmployeesMutation = useMutation({
    mutationFn: async (orderedIds: string[]) =>
      apiRequest("POST", "/api/employees/reorder", { orderedIds }),
    onMutate: async (orderedIds) => {
      await queryClient.cancelQueries({ queryKey: ["/api/employees"] });
      const previousData = queryClient.getQueryData(["/api/employees"]);
      
      // Update displayOrder in cache based on new order
      queryClient.setQueryData(["/api/employees"], (old: EmployeeWithAccess[] | undefined) => {
        if (!old) return old;
        return old.map(emp => {
          const newIndex = orderedIds.indexOf(emp.id);
          if (newIndex !== -1) {
            return { ...emp, displayOrder: newIndex };
          }
          return emp;
        });
      });
      
      return { previousData };
    },
    onError: (_err, _orderedIds, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["/api/employees"], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // Check if this is an employee drag (prefixed with "emp-")
    if (activeId.startsWith("emp-") && overId.startsWith("emp-")) {
      const activeEmpId = activeId.replace("emp-", "");
      const overEmpId = overId.replace("emp-", "");
      
      // Find the department these employees belong to
      if (!employeesByDepartment) return;
      
      for (const [, deptEmployees] of Array.from(employeesByDepartment.entries())) {
        const oldIndex = deptEmployees.findIndex((e: EmployeeWithAccess) => e.id === activeEmpId);
        const newIndex = deptEmployees.findIndex((e: EmployeeWithAccess) => e.id === overEmpId);
        
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const newOrder = arrayMove([...deptEmployees], oldIndex, newIndex);
          reorderEmployeesMutation.mutate(newOrder.map((e: EmployeeWithAccess) => e.id));
          break;
        }
      }
      return;
    }

    // Otherwise it's a department drag
    if (!departments) return;
    const oldIndex = departments.findIndex((d) => d.id === activeId);
    const newIndex = departments.findIndex((d) => d.id === overId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const newOrder = arrayMove([...departments], oldIndex, newIndex);
      reorderDepartmentsMutation.mutate(newOrder.map((d) => d.id));
    }
  };

  // Fetch leave balances for the selected branch
  const { data: leaveBalances } = useQuery<LeaveBalance[]>({
    queryKey: [`/api/leave-balances?branchId=${selectedBranchId}`],
    enabled: !!selectedBranchId && !isAllBranches,
  });

  // Create a map of employee ID to leave balance
  const leaveBalanceMap = useMemo(() => {
    return new Map(leaveBalances?.map(b => [b.employeeId, b]) || []);
  }, [leaveBalances]);

  const branchMap = new Map(branches?.map((b) => [b.id, b]) || []);

  // Filter contracts by branch context (matching dashboard approach)
  const filteredContracts = useMemo(() => {
    if (!contracts) return [];
    if (isAllBranches) return contracts;
    return contracts.filter(c => c.branchId === selectedBranchId);
  }, [contracts, isAllBranches, selectedBranchId]);

  // Calculate which employees have signed contracts (within branch context)
  const employeesWithSignedContract = useMemo(() => {
    return new Set(
      filteredContracts
        .filter(c => c.status === "active" || c.signingStatus === "signed")
        .map(c => c.employeeId)
    );
  }, [filteredContracts]);

  // Count unsigned active employees for display
  const unsignedCount = useMemo(() => {
    if (!employees) return 0;
    return employees.filter(emp => {
      if (emp.status !== "active") return false;
      if (!isAllBranches && emp.branchId !== selectedBranchId) return false;
      return !employeesWithSignedContract.has(emp.id);
    }).length;
  }, [employees, employeesWithSignedContract, isAllBranches, selectedBranchId]);

  // Count employees without login access
  const noLoginCount = useMemo(() => {
    if (!employees) return 0;
    return employees.filter(emp => {
      if (emp.status !== "active") return false;
      if (!isAllBranches && emp.branchId !== selectedBranchId) return false;
      return !emp.accessSummary || !emp.accessSummary.coreUserId;
    }).length;
  }, [employees, isAllBranches, selectedBranchId]);

  const filteredEmployees = employees?.filter((emp) => {
    // Status filter (now includes employment state awareness)
    if (statusFilter === "active") {
      if (emp.status !== "active") return false;
      if (emp.employmentState === "LEAVING" || emp.employmentState === "LEFT") return false;
    }
    if (statusFilter === "leaving") {
      if (emp.employmentState !== "LEAVING") return false;
    }
    if (statusFilter === "former") {
      if (emp.status === "active" && emp.employmentState !== "LEFT") return false;
    }
    // Branch filter
    if (!isAllBranches && emp.branchId !== selectedBranchId) return false;
    // Unsigned filter - only applies to active employees
    if (showUnsignedOnly) {
      if (emp.status !== "active") return false;
      if (employeesWithSignedContract.has(emp.id)) return false;
    }
    // No login filter - only applies to active employees
    if (showNoLoginOnly) {
      if (emp.status !== "active") return false;
      if (emp.accessSummary && emp.accessSummary.coreUserId) return false;
    }
    // Search filter - search by name, nickname, email, position
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      const fullName = (emp.fullName || "").toLowerCase();
      const nickname = (emp.nickname || "").toLowerCase();
      const email = (emp.email || "").toLowerCase();
      const positionTitle = (emp.defaultMergeData?.positionTitle || "").toLowerCase();
      const thaiName = (emp.thaiName || "").toLowerCase();
      
      if (!fullName.includes(query) && 
          !nickname.includes(query) && 
          !email.includes(query) && 
          !positionTitle.includes(query) &&
          !thaiName.includes(query)) {
        return false;
      }
    }
    return true;
  });

  // Group employees by department (always show grouped view)
  // Sort employees within each group by displayOrder
  const employeesByDepartment = useMemo(() => {
    if (!filteredEmployees) return null;
    
    const grouped = new Map<string | null, typeof filteredEmployees>();
    
    for (const emp of filteredEmployees) {
      const deptId = emp.primaryDepartmentId || null;
      if (!grouped.has(deptId)) {
        grouped.set(deptId, []);
      }
      grouped.get(deptId)!.push(emp);
    }
    
    // Sort employees within each group by displayOrder
    for (const [, emps] of Array.from(grouped.entries())) {
      emps.sort((a: EmployeeWithAccess, b: EmployeeWithAccess) => (a.displayOrder || 0) - (b.displayOrder || 0));
    }
    
    return grouped;
  }, [filteredEmployees]);

  const filteredEmployeeIds = useMemo(() => {
    return filteredEmployees?.map(e => e.id) || [];
  }, [filteredEmployees]);

  const { data: avatarStatusMap } = useAvatarWorkStatus(filteredEmployeeIds, {
    branchId: isAllBranches ? undefined : selectedBranchId || undefined,
    scope: isAllBranches ? "GLOBAL" : "BRANCH",
  });

  const clearUnsignedFilter = () => {
    setShowUnsignedOnly(false);
    const params = new URLSearchParams(searchString);
    params.delete("unsigned");
    const newSearch = params.toString();
    setLocation(newSearch ? `/employees?${newSearch}` : "/employees");
  };

  const clearNoLoginFilter = () => {
    setShowNoLoginOnly(false);
    const params = new URLSearchParams(searchString);
    params.delete("nologin");
    const newSearch = params.toString();
    setLocation(newSearch ? `/employees?${newSearch}` : "/employees");
  };

  const handleStatusFilterChange = (newStatus: string) => {
    setStatusFilter(newStatus);
    const params = new URLSearchParams(searchString);
    if (newStatus === "active") {
      params.delete("status");
    } else {
      params.set("status", newStatus);
    }
    const newSearch = params.toString();
    setLocation(newSearch ? `/employees?${newSearch}` : "/employees");
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/employees/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      toast({
        title: "Employee deleted",
        description: "The employee has been removed from the system.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Bulk delete state and mutation (admin only)
  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  const bulkDeleteMutation = useMutation({
    mutationFn: async (employeeIds: string[]) => {
      const response = await apiRequest("POST", "/api/employees/bulk-delete", { employeeIds });
      return response.json();
    },
    onSuccess: (data: { deletedCount: number; errorCount: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      setSelectedEmployees(new Set());
      setShowBulkDeleteDialog(false);
      toast({
        title: "Bulk delete complete",
        description: `${data.deletedCount} employees deleted${data.errorCount > 0 ? `, ${data.errorCount} errors` : ""}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const toggleSelectEmployee = (employeeId: string) => {
    setSelectedEmployees(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) {
        next.delete(employeeId);
      } else {
        next.add(employeeId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!filteredEmployees) return;
    if (selectedEmployees.size === filteredEmployees.length) {
      setSelectedEmployees(new Set());
    } else {
      setSelectedEmployees(new Set(filteredEmployees.map(e => e.id)));
    }
  };

  const handleBulkDelete = () => {
    if (selectedEmployees.size === 0) return;
    bulkDeleteMutation.mutate(Array.from(selectedEmployees));
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-medium" data-testid="text-employees-title">Employees</h1>
            <p className="text-muted-foreground text-sm sm:text-base">
              Manage your employee directory
            </p>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0 flex-wrap">
            {canEdit && (
              <>
                <Link href="/employees/bulk-upload">
                  <Button variant="outline" size="icon" data-testid="button-bulk-upload" title="Bulk Upload">
                    <Upload className="h-4 w-4" />
                  </Button>
                </Link>
                <Link href="/employees/casual">
                  <Button variant="outline" size="icon" data-testid="button-casual-workers" title="Casual Workers">
                    <Briefcase className="h-4 w-4" />
                  </Button>
                </Link>
                <Button asChild size="sm" data-testid="button-new-employee">
                  <Link href="/employees/new">
                    <Plus className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Add</span>
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Search bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, nickname, email, or position..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 w-full"
            data-testid="input-employee-search"
          />
          {searchQuery && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted"
              onClick={() => setSearchQuery("")}
              data-testid="button-clear-search"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Bulk delete controls */}
        {canDelete && selectedEmployees.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" data-testid="button-bulk-delete">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete {selectedEmployees.size} Selected
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {selectedEmployees.size} Employees</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete {selectedEmployees.size} employees? This action cannot be undone. All contracts and assets associated with these employees will be archived.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleBulkDelete}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    disabled={bulkDeleteMutation.isPending}
                  >
                    {bulkDeleteMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      "Delete All"
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button 
              variant="ghost"
              size="sm"
              onClick={() => setSelectedEmployees(new Set())}
              data-testid="button-clear-selection"
            >
              Clear Selection
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Tabs value={statusFilter} onValueChange={handleStatusFilterChange}>
          <TabsList data-testid="tabs-employee-status">
            <TabsTrigger value="active" data-testid="tab-active">
              Active ({employees?.filter(e => e.status === "active" && e.employmentState !== "LEAVING" && e.employmentState !== "LEFT" && (isAllBranches || e.branchId === selectedBranchId)).length || 0})
            </TabsTrigger>
            <TabsTrigger value="leaving" data-testid="tab-leaving">
              Leaving ({employees?.filter(e => e.employmentState === "LEAVING" && (isAllBranches || e.branchId === selectedBranchId)).length || 0})
            </TabsTrigger>
            <TabsTrigger value="former" data-testid="tab-former">
              Former ({employees?.filter(e => (e.status !== "active" || e.employmentState === "LEFT") && (isAllBranches || e.branchId === selectedBranchId)).length || 0})
            </TabsTrigger>
            <TabsTrigger value="all" data-testid="tab-all">
              All ({employees?.filter(e => isAllBranches || e.branchId === selectedBranchId).length || 0})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {showUnsignedOnly && (
          <Badge 
            variant="secondary" 
            className="flex items-center gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
            data-testid="badge-unsigned-filter"
          >
            <FileX className="h-3 w-3" />
            Unsigned only
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 p-0 ml-1"
              onClick={clearUnsignedFilter}
              data-testid="button-clear-unsigned-filter"
            >
              <X className="h-3 w-3" />
            </Button>
          </Badge>
        )}

        {!showUnsignedOnly && unsignedCount > 0 && (
          <Link href="/employees?unsigned=true">
            <Badge 
              variant="outline" 
              className="cursor-pointer border-amber-500/50 text-amber-600 dark:text-amber-400"
              data-testid="badge-unsigned-count"
            >
              <FileX className="h-3 w-3 mr-1" />
              {unsignedCount} without signed contract
            </Badge>
          </Link>
        )}

        {showNoLoginOnly && (
          <Badge 
            variant="secondary" 
            className="flex items-center gap-1 bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
            data-testid="badge-nologin-active"
          >
            <Shield className="h-3 w-3" />
            No login: {filteredEmployees?.length || 0} employees
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 p-0 ml-1"
              onClick={clearNoLoginFilter}
              data-testid="button-clear-nologin"
            >
              <X className="h-3 w-3" />
            </Button>
          </Badge>
        )}

        {!showNoLoginOnly && noLoginCount > 0 && (
          <Link href="/employees?nologin=true">
            <Badge 
              variant="outline" 
              className="cursor-pointer border-red-500/50 text-red-600 dark:text-red-400"
              data-testid="badge-nologin-count"
            >
              <Shield className="h-3 w-3 mr-1" />
              {noLoginCount} without login
            </Badge>
          </Link>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {isAllBranches ? "All Employees" : `${selectedBranch?.name} Employees`}
          </CardTitle>
          <CardDescription>
            {filteredEmployees?.length || 0} employee{(filteredEmployees?.length || 0) !== 1 ? "s" : ""} {isAllBranches ? "across all branches" : "in this branch"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <EmployeesTableSkeleton />
          ) : filteredEmployees?.length === 0 ? (
            <EmptyState canEdit={canEdit} />
          ) : employeesByDepartment && departments ? (
            // Grouped by department view with drag-and-drop
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={(departments || []).map(d => d.id)} strategy={verticalListSortingStrategy}>
                {(departments || []).map((dept) => {
                  const deptEmployees = employeesByDepartment.get(dept.id) || [];
                  if (deptEmployees.length === 0) return null;
                  
                  return (
                    <SortableDepartmentGroup
                      key={dept.id}
                      id={dept.id}
                      name={dept.name}
                      employeeCount={deptEmployees.length}
                      isCollapsed={collapsedDepts.has(dept.id)}
                      onToggleCollapse={() => toggleDeptCollapse(dept.id)}
                      canDrag={canEdit}
                    >
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {canEdit && <TableHead className="w-8"></TableHead>}
                            <TableHead>Name</TableHead>
                            <TableHead>Position</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Leave</TableHead>
                            <TableHead>Onboarding</TableHead>
                            <TableHead>Access</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <SortableContext 
                            items={deptEmployees.map(e => `emp-${e.id}`)} 
                            strategy={verticalListSortingStrategy}
                          >
                            {deptEmployees.map((employee) => (
                              <SortableEmployeeTableRow 
                                key={employee.id}
                                employee={employee}
                                canEdit={canEdit}
                                canDelete={canDelete}
                                isAllBranches={isAllBranches}
                                branchMap={branchMap}
                                leaveBalanceMap={leaveBalanceMap}
                                deleteMutation={deleteMutation}
                                canDrag={canEdit}
                                workStatus={avatarStatusMap?.[employee.id]?.status as AvatarWorkStatus}
                              />
                            ))}
                          </SortableContext>
                        </TableBody>
                      </Table>
                    </SortableDepartmentGroup>
                  );
                })}
                {/* Employees with department IDs not in the departments list (e.g., from other branches) */}
                {Array.from(employeesByDepartment.entries())
                  .filter(([deptId]) => deptId !== null && !(departments || []).find(d => d.id === deptId))
                  .map(([deptId, emps]) => (
                    <div key={deptId} className="mb-4">
                      <div 
                        className="flex items-center gap-2 py-2 px-3 bg-muted/30 rounded-t-md border-b cursor-pointer hover-elevate"
                        onClick={() => toggleDeptCollapse(deptId as string)}
                      >
                        <div className="flex items-center gap-2 flex-1">
                          {collapsedDepts.has(deptId as string) ? (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          )}
                          <span className="font-medium text-muted-foreground">Other Department</span>
                          <Badge variant="secondary" className="text-xs">
                            {emps.length}
                          </Badge>
                        </div>
                      </div>
                      {!collapsedDepts.has(deptId as string) && (
                        <div className="border-x border-b rounded-b-md overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                {canEdit && <TableHead className="w-8"></TableHead>}
                                <TableHead>Name</TableHead>
                                <TableHead>Position</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Leave</TableHead>
                                <TableHead>Onboarding</TableHead>
                                <TableHead>Access</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              <SortableContext 
                                items={emps.map(e => `emp-${e.id}`)} 
                                strategy={verticalListSortingStrategy}
                              >
                                {emps.map((employee) => (
                                  <SortableEmployeeTableRow 
                                    key={employee.id}
                                    employee={employee}
                                    canEdit={canEdit}
                                    canDelete={canDelete}
                                    isAllBranches={isAllBranches}
                                    branchMap={branchMap}
                                    leaveBalanceMap={leaveBalanceMap}
                                    deleteMutation={deleteMutation}
                                    canDrag={canEdit}
                                    workStatus={avatarStatusMap?.[employee.id]?.status as AvatarWorkStatus}
                                  />
                                ))}
                              </SortableContext>
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </div>
                  ))}
                {/* Employees without a department */}
                {employeesByDepartment.get(null) && employeesByDepartment.get(null)!.length > 0 && (
                  <div className="mb-4">
                    <div 
                      className="flex items-center gap-2 py-2 px-3 bg-muted/30 rounded-t-md border-b cursor-pointer hover-elevate"
                      onClick={() => toggleDeptCollapse("__no_dept__")}
                    >
                      <div className="flex items-center gap-2 flex-1">
                        {collapsedDepts.has("__no_dept__") ? (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="font-medium text-muted-foreground">No Department</span>
                        <Badge variant="secondary" className="text-xs">
                          {employeesByDepartment.get(null)!.length}
                        </Badge>
                      </div>
                    </div>
                    {!collapsedDepts.has("__no_dept__") && (
                      <div className="border-x border-b rounded-b-md overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              {canEdit && <TableHead className="w-8"></TableHead>}
                              <TableHead>Name</TableHead>
                              <TableHead>Position</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Leave</TableHead>
                              <TableHead>Onboarding</TableHead>
                              <TableHead>Access</TableHead>
                              <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <SortableContext 
                              items={employeesByDepartment.get(null)!.map(e => `emp-${e.id}`)} 
                              strategy={verticalListSortingStrategy}
                            >
                              {employeesByDepartment.get(null)!.map((employee) => (
                                <SortableEmployeeTableRow 
                                  key={employee.id}
                                  employee={employee}
                                  canEdit={canEdit}
                                  canDelete={canDelete}
                                  isAllBranches={isAllBranches}
                                  branchMap={branchMap}
                                  leaveBalanceMap={leaveBalanceMap}
                                  deleteMutation={deleteMutation}
                                  canDrag={canEdit}
                                  workStatus={avatarStatusMap?.[employee.id]?.status as AvatarWorkStatus}
                                />
                              ))}
                            </SortableContext>
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}
              </SortableContext>
            </DndContext>
          ) : (
            // Flat table view (all branches or no departments)
            <Table>
              <TableHeader>
                <TableRow>
                  {canDelete && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={filteredEmployees && filteredEmployees.length > 0 && selectedEmployees.size === filteredEmployees.length}
                        onCheckedChange={toggleSelectAll}
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                  )}
                  <TableHead>Name</TableHead>
                  {isAllBranches && <TableHead>Branch</TableHead>}
                  <TableHead>Position</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Onboarding</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEmployees?.map((employee) => (
                  <EmployeeTableRow 
                    key={employee.id}
                    employee={employee}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    isAllBranches={isAllBranches}
                    branchMap={branchMap}
                    leaveBalanceMap={leaveBalanceMap}
                    deleteMutation={deleteMutation}
                    isSelected={selectedEmployees.has(employee.id)}
                    onToggleSelect={() => toggleSelectEmployee(employee.id)}
                    workStatus={avatarStatusMap?.[employee.id]?.status as AvatarWorkStatus}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
