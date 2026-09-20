import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Briefcase, Building2, Users, Calendar, Thermometer, Palmtree, Clock } from "lucide-react";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { useAvatarWorkStatus } from "@/hooks/use-avatar-work-status";

type LeaveBalance = {
  employeeId: string;
  daysWorked: number;
  daysEarned: number;
  daysUsed: number;
  balance: number;
  policyName: string | null;
};

type SickLeaveBalance = {
  employeeId: string;
  daysUsed: number;
  daysAllowed: number;
  proRatedEntitlement: number;
  remaining: number;
  year: number;
};

type AllLeaveBalances = {
  employeeId: string;
  year: number;
  monthsWorkedThisYear: number;
  totalMonthsEmployed: number;
  annual: {
    total: number;
    earned: number;
    used: number;
    balance: number;
    canClaim: boolean;
    waitingMonths: number;
  };
  business: {
    total: number;
    earned: number;
    used: number;
    balance: number;
  };
  sick: {
    used: number;
    paidDaysRemaining: number;
    maxPaidDays: number;
  };
  publicHolidays: {
    total: number;
    remaining: number;
  };
};

type Role = {
  id: string;
  name: string;
  proficiencyLevel?: string | null;
  isPrimary?: boolean;
};

type Department = {
  id: string;
  name: string;
};

type EmployeeDetails = {
  id: string;
  fullName: string;
  profilePhotoPath?: string | null;
  primaryDepartmentId?: string | null;
  defaultMergeData?: {
    positionTitle?: string;
  } | null;
  status?: string | null;
  probationEndDate?: string | null;
  probationReviewCompletedAt?: string | null;
  offboardingDate?: string | null;
};

interface EmployeeInfoPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  employeeName: string;
  avatarUrl?: string | null;
}

export function EmployeeInfoPopup({
  open,
  onOpenChange,
  employeeId,
  employeeName,
  avatarUrl,
}: EmployeeInfoPopupProps) {
  const [rolesExpanded, setRolesExpanded] = useState(false);
  const MAX_VISIBLE_ROLES = 2;

  useEffect(() => {
    if (open) {
      setRolesExpanded(false);
    }
  }, [open, employeeId]);

  const { data: employeeDetails } = useQuery<EmployeeDetails>({
    queryKey: ["/api/employees", employeeId],
    enabled: open && !!employeeId,
  });

  const { data: popupAvatarStatus } = useAvatarWorkStatus(
    open && employeeId ? [employeeId] : [],
    { scope: "GLOBAL" }
  );

  const { data: employeeRoles } = useQuery<(Role & { role: Role })[]>({
    queryKey: ["/api/employees", employeeId, "roles"],
    enabled: open && !!employeeId,
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
    enabled: open,
  });

  const { data: leaveBalance } = useQuery<LeaveBalance>({
    queryKey: ["/api/employees", employeeId, "leave-balance"],
    enabled: open && !!employeeId,
  });

  const { data: sickLeaveBalance } = useQuery<SickLeaveBalance>({
    queryKey: ["/api/employees", employeeId, "sick-leave-balance"],
    enabled: open && !!employeeId,
  });

  const { data: allLeaveBalances } = useQuery<AllLeaveBalances>({
    queryKey: [`/api/employees/${employeeId}/all-leave-balances`],
    enabled: open && !!employeeId,
  });

  const positionTitle = employeeDetails?.defaultMergeData?.positionTitle;
  const department = departments?.find(d => d.id === employeeDetails?.primaryDepartmentId);
  
  const roles = employeeRoles?.map(er => ({
    id: er.role?.id || er.id,
    name: er.role?.name || "Unknown",
    proficiencyLevel: (er as any).proficiencyLevel,
    isPrimary: (er as any).isPrimary,
  })) || [];

  const visibleRoles = rolesExpanded ? roles : roles.slice(0, MAX_VISIBLE_ROLES);
  const hasMoreRoles = roles.length > MAX_VISIBLE_ROLES;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="sr-only">Employee Information</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 overflow-y-auto flex-1 py-2">
          <EmployeeAvatar
            employeeId={employeeId}
            fullName={employeeName}
            profilePhotoPath={employeeDetails?.profilePhotoPath || avatarUrl}
            workStatus={popupAvatarStatus?.[employeeId]?.status as any}
            size="lg"
          />
          
          <h2 className="text-lg font-semibold" data-testid="text-employee-popup-name">
            {employeeName}
          </h2>

          <div className="w-full space-y-2 mt-1">
            {department && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50" data-testid="employee-department-info">
                <Building2 className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">Department</div>
                  <div className="font-medium truncate">{department.name}</div>
                </div>
              </div>
            )}

            {positionTitle && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50" data-testid="employee-position-info">
                <Briefcase className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">Position</div>
                  <div className="font-medium truncate">{positionTitle}</div>
                </div>
              </div>
            )}

            {roles.length > 0 && (
              <div className="p-3 rounded-lg bg-muted/50" data-testid="employee-roles-info">
                <div className="flex items-center gap-3 mb-2">
                  <Users className="h-5 w-5 text-muted-foreground shrink-0" />
                  <div className="text-xs text-muted-foreground">
                    Roles ({roles.length})
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pl-8">
                  {visibleRoles.map((role) => (
                    <Badge 
                      key={role.id} 
                      variant={role.isPrimary ? "default" : "secondary"}
                      className="text-xs"
                      data-testid={`badge-role-${role.id}`}
                    >
                      {role.name}
                      {role.proficiencyLevel && (
                        <span className="ml-1 opacity-70">
                          ({role.proficiencyLevel})
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
                {hasMoreRoles && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 ml-6 h-7 text-xs"
                    onClick={() => setRolesExpanded(!rolesExpanded)}
                    data-testid="button-expand-roles"
                  >
                    {rolesExpanded ? (
                      <>
                        <ChevronUp className="h-3 w-3 mr-1" />
                        Show less
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3 mr-1" />
                        Show {roles.length - MAX_VISIBLE_ROLES} more
                      </>
                    )}
                  </Button>
                )}
              </div>
            )}

            {allLeaveBalances && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50" data-testid="employee-holiday-balance">
                <Palmtree className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">Holiday Balance ({allLeaveBalances.year})</div>
                  {allLeaveBalances.annual.canClaim ? (
                    <div className="flex items-center gap-2">
                      <span className={`font-semibold text-lg ${(allLeaveBalances.annual.balance + allLeaveBalances.publicHolidays.remaining) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {allLeaveBalances.annual.balance + allLeaveBalances.publicHolidays.remaining}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        days left (Annual: {allLeaveBalances.annual.balance}, PH: {allLeaveBalances.publicHolidays.remaining})
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-muted-foreground text-sm">
                      <Clock className="h-3.5 w-3.5" />
                      <span>Annual leave available in {Math.max(0, allLeaveBalances.annual.waitingMonths - allLeaveBalances.totalMonthsEmployed)} months</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {allLeaveBalances && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50" data-testid="employee-business-leave-balance">
                <Briefcase className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">Business Leave ({allLeaveBalances.year})</div>
                  <div className="flex items-center gap-2">
                    <span className={`font-semibold text-lg ${allLeaveBalances.business.balance >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {allLeaveBalances.business.balance}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      days left ({allLeaveBalances.business.earned} earned, {allLeaveBalances.business.used} used)
                    </span>
                  </div>
                </div>
              </div>
            )}

            {sickLeaveBalance && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50" data-testid="employee-sick-leave-balance">
                <Thermometer className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">Sick Leave ({sickLeaveBalance.year})</div>
                  <div className="flex items-center gap-2">
                    <span className={`font-semibold text-lg ${sickLeaveBalance.remaining > 0 ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}`}>
                      {sickLeaveBalance.daysUsed} / {sickLeaveBalance.proRatedEntitlement}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      sick days used
                    </span>
                  </div>
                </div>
              </div>
            )}

            {leaveBalance && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50" data-testid="employee-leave-balance">
                <Calendar className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">Days Off Balance</div>
                  <div className="flex items-center gap-2">
                    <span className={`font-semibold text-lg ${leaveBalance.balance >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {leaveBalance.balance >= 0 ? '+' : ''}{leaveBalance.balance}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({leaveBalance.daysEarned} earned, {leaveBalance.daysUsed} used)
                    </span>
                  </div>
                </div>
              </div>
            )}

            {!department && !positionTitle && roles.length === 0 && !leaveBalance && !sickLeaveBalance && !allLeaveBalances && (
              <div className="text-center text-muted-foreground text-sm py-4">
                No additional details available
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
