import { cn } from "@/lib/utils";
import { X, Coffee, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useState } from "react";
import { getDepartmentColor, getShiftColor, getShiftColorByIndex, getEmployeeColor, formatCompactStartTime, formatTimeRange } from "./utils";

export type ShiftStatus = "approved" | "pending" | "leave" | "open";

interface ShiftCardProps {
  shiftName: string;
  timeRange: string;
  startTime?: string;
  endTime?: string;
  status?: ShiftStatus;
  employeeName?: string;
  isCompact?: boolean;
  onRemove?: () => void;
  onClick?: () => void;
  className?: string;
  departmentId?: string;
  departmentName?: string;
  note?: string;
  roles?: string[];
}

export function ShiftCard({
  shiftName,
  timeRange,
  startTime,
  endTime,
  status = "approved",
  employeeName,
  isCompact = false,
  onRemove,
  onClick,
  className,
  departmentId,
  departmentName,
  note,
  roles,
}: ShiftCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  
  const statusStyles: Record<ShiftStatus, string> = {
    approved: "bg-[#4CAF50] text-white",
    pending: "bg-[#E57373] text-white",
    leave: "bg-[#FFD54F] text-gray-900",
    open: "bg-[#E8EAF6] text-gray-700 border border-dashed border-gray-400",
  };

  const cardContent = (
    <div
      className={cn(
        "rounded-lg relative group transition-all cursor-pointer",
        statusStyles[status],
        "px-2 py-1",
        className
      )}
      data-testid="shift-card"
    >
      <div className="flex items-center justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">
            {shiftName}
          </div>
        </div>
        {onRemove && (
          <button
            className="h-4 w-4 opacity-0 group-hover:opacity-100 -mr-0.5 text-inherit rounded-sm hover:bg-white/20 flex items-center justify-center"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            data-testid="button-remove-shift"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <PopoverTrigger asChild>
        <div onClick={() => setDetailsOpen(true)}>{cardContent}</div>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="space-y-2">
          <div className="font-medium text-sm">{shiftName}</div>
          {timeRange && (
            <div className="text-xs text-muted-foreground font-mono">{timeRange}</div>
          )}
          {departmentName && (
            <div className="text-xs"><span className="text-muted-foreground">Dept:</span> {departmentName}</div>
          )}
          {roles && roles.length > 0 && (
            <div className="text-xs"><span className="text-muted-foreground">Roles:</span> {roles.join(', ')}</div>
          )}
          {employeeName && (
            <div className="text-xs"><span className="text-muted-foreground">Assigned:</span> {employeeName}</div>
          )}
          {note && (
            <div className="text-xs text-muted-foreground">{note}</div>
          )}
          <div className="flex gap-1 pt-1">
            {onRemove && (
              <Button
                variant="destructive"
                size="sm"
                className="flex-1"
                onClick={() => {
                  onRemove();
                  setDetailsOpen(false);
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type ViewMode = "day" | "3day" | "week" | "month";

interface EmployeeShiftCardProps {
  shiftName: string;
  timeRange: string;
  startTime: string;
  endTime?: string;
  status?: ShiftStatus;
  isCompact?: boolean;
  viewMode?: ViewMode;
  onRemove?: () => void;
  className?: string;
  shiftRowId?: string;
  departmentId?: string;
  departmentName?: string;
  note?: string;
  roles?: string[];
  colorIndex?: number | null;
  isBorrowed?: boolean;
  borrowedDeptName?: string;
  onDutyBlocks?: () => void;
  dutyBlockCount?: number;
}

export function EmployeeShiftCard({
  shiftName,
  timeRange,
  startTime,
  endTime,
  status = "approved",
  isCompact = false,
  viewMode = "week",
  onRemove,
  className,
  shiftRowId,
  departmentId,
  departmentName,
  note,
  roles,
  colorIndex,
  isBorrowed = false,
  borrowedDeptName,
  onDutyBlocks,
  dutyBlockCount,
}: EmployeeShiftCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  
  // Use colorIndex for consistent colors across weeks when copying templates
  const shiftColor = colorIndex != null 
    ? getShiftColorByIndex(colorIndex) 
    : (departmentId ? getDepartmentColor(departmentId) : getShiftColor(shiftRowId));
  const compactRange = formatTimeRange(startTime, endTime || startTime);

  // For month view (compact), show start time with minutes if needed (e.g., "9" or "10:30")
  const startHour = startTime ? formatCompactStartTime(startTime) : "";
  const endHour = endTime ? formatCompactStartTime(endTime) : "";
  
  // For 3-day view: show start-end hours (e.g., "9-17") and shift name
  const is3DayView = viewMode === "3day";
  const hourRange = `${startHour}-${endHour}`;
  
  // For 3D view, use full width; for month view use fixed small size
  const isMonthCompact = isCompact && !is3DayView;
  
  // Only month view uses fixed small squares; week and 3-day use full width
  const isMonthView = viewMode === "month";
  const useFixedSize = isMonthView;
  
  const cardContent = (
    <div
      className={cn(
        "shiftBadge",
        isMonthView ? "shiftBadge--month" : "shiftBadge--fullWidth",
        shiftColor,
        "text-white",
        isBorrowed && "ring-1 ring-offset-1 ring-yellow-400",
        className
      )}
      data-testid="employee-shift-card"
    >
      <span className={cn(
        "shiftBadge__text font-mono font-semibold tabular-nums",
        isMonthView ? "text-[11px]" : "text-xs"
      )}>
        {isMonthView ? startHour : (is3DayView ? hourRange : compactRange)}
      </span>
      {!isMonthView && roles && roles.length > 0 && (
        <span className="opacity-80 text-center truncate max-w-full leading-none text-[9px]">
          {roles[0]}
        </span>
      )}
      {!isMonthView && shiftName && (
        <span className="opacity-90 text-center truncate max-w-full leading-none text-[10px]">
          {shiftName}
        </span>
      )}
      {isBorrowed && !isMonthView && (
        <span className="absolute -top-1 -right-1 bg-yellow-500 text-yellow-950 text-[8px] font-bold px-1 rounded shadow-sm" title={`Borrowed from ${borrowedDeptName || 'another dept'}`}>
          B
        </span>
      )}
    </div>
  );

  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="border-0 bg-transparent p-0 w-full"
          onClick={() => setDetailsOpen(true)}
          data-testid="button-employee-shift-card"
        >
          {cardContent}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="space-y-2">
          <div className="font-medium text-sm">{shiftName || 'Shift'}</div>
          <div className="text-xs text-muted-foreground font-mono">{timeRange}</div>
          {isBorrowed && borrowedDeptName && (
            <div className="text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 px-2 py-1 rounded flex items-center gap-1">
              <span className="font-medium">Borrowed shift</span>
              <span className="text-muted-foreground">in {borrowedDeptName}</span>
            </div>
          )}
          {departmentName && !isBorrowed && (
            <div className="text-xs"><span className="text-muted-foreground">Dept:</span> {departmentName}</div>
          )}
          {roles && roles.length > 0 && (
            <div className="text-xs"><span className="text-muted-foreground">Roles:</span> {roles.join(', ')}</div>
          )}
          {note && (
            <div className="text-xs text-muted-foreground">{note}</div>
          )}
          <div className="flex gap-1 pt-1 flex-wrap">
            {onDutyBlocks && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => {
                  setDetailsOpen(false);
                  onDutyBlocks();
                }}
                data-testid="button-open-duty-blocks"
              >
                <ListChecks className="h-3.5 w-3.5 mr-1" />
                Duties{dutyBlockCount ? ` (${dutyBlockCount})` : ""}
              </Button>
            )}
            {onRemove && (
              <Button
                variant="destructive"
                size="sm"
                className="flex-1"
                onClick={() => {
                  onRemove();
                  setDetailsOpen(false);
                }}
              >
                Unassign
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface MinimalShiftBlockProps {
  shiftName: string;
  timeRange: string;
  departmentName?: string;
  employeeName?: string;
  roles?: string[];
  note?: string;
  status?: ShiftStatus;
  onRemove?: () => void;
  onAssign?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  className?: string;
}

export function MinimalShiftBlock({
  shiftName,
  timeRange,
  departmentName,
  employeeName,
  roles,
  note,
  status = "approved",
  onRemove,
  onAssign,
  onEdit,
  onDelete,
  className,
}: MinimalShiftBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  
  const statusStyles: Record<ShiftStatus, string> = {
    approved: "bg-emerald-600 dark:bg-emerald-700",
    pending: "bg-amber-500 dark:bg-amber-600",
    leave: "bg-amber-400 dark:bg-amber-500",
    open: "bg-gray-300 dark:bg-gray-600 border border-dashed border-gray-400 dark:border-gray-500",
  };

  const blockContent = (
    <div
      className={cn(
        "rounded-md min-h-[44px] min-w-[44px] cursor-pointer transition-colors flex items-center justify-center",
        statusStyles[status],
        className
      )}
      data-testid="minimal-shift-block"
    />
  );

  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="border-0 bg-transparent p-0"
          onClick={() => setDetailsOpen(true)}
          data-testid="button-minimal-shift-block"
        >
          {blockContent}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="space-y-2">
          <div className="font-medium text-sm">{shiftName || "Shift"}</div>
          <div className="text-xs text-muted-foreground font-mono">{timeRange}</div>
          {departmentName && (
            <div className="text-xs"><span className="text-muted-foreground">Dept:</span> {departmentName}</div>
          )}
          {roles && roles.length > 0 && (
            <div className="text-xs"><span className="text-muted-foreground">Roles:</span> {roles.join(', ')}</div>
          )}
          {employeeName ? (
            <div className="text-xs"><span className="text-muted-foreground">Assigned:</span> {employeeName}</div>
          ) : (
            <div className="text-xs text-amber-600 dark:text-amber-400 font-medium">Unfilled</div>
          )}
          {note && (
            <div className="text-xs text-muted-foreground">{note}</div>
          )}
          <div className="flex flex-wrap gap-1 pt-1">
            {onAssign && !employeeName && (
              <Button
                variant="default"
                size="sm"
                className="flex-1"
                onClick={() => {
                  onAssign();
                  setDetailsOpen(false);
                }}
              >
                Assign
              </Button>
            )}
            {onRemove && employeeName && (
              <Button
                variant="destructive"
                size="sm"
                className="flex-1"
                onClick={() => {
                  onRemove();
                  setDetailsOpen(false);
                }}
              >
                Unassign
              </Button>
            )}
            {onEdit && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => {
                  onEdit();
                  setDetailsOpen(false);
                }}
              >
                Edit
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="flex-1 text-destructive"
                onClick={() => {
                  onDelete();
                  setDetailsOpen(false);
                }}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface LeaveCardProps {
  type: string;
  dateRange?: string;
  isCompact?: boolean;
  viewMode?: ViewMode;
  className?: string;
  onDelete?: () => void;
  timeOffId?: string;
}

export function LeaveCard({ type, dateRange, isCompact = false, viewMode = "week", className, onDelete, timeOffId }: LeaveCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isDayOff = type === "CHANGE_DAY_OFF";
  
  const label = type === "CHANGE_DAY_OFF" 
    ? "Off" 
    : type === "SICK" 
    ? "Sick" 
    : type === "ANNUAL" 
    ? "Leave" 
    : type === "BUSINESS"
    ? "Business"
    : type === "UNPAID"
    ? "Unpaid"
    : type === "TRAINING"
    ? "Training"
    : type;

  const isSickLeave = type === "SICK";
  const isBusinessLeave = type === "BUSINESS";
  
  // For 3-day view: use full width; for month view use fixed small size
  const is3DayView = viewMode === "3day";
  const isMonthCompact = isCompact && !is3DayView;
  
  // Only month view uses fixed small squares
  const isMonthView = viewMode === "month";
  
  const cardContent = (
    <div
      className={cn(
        "shiftBadge group relative",
        isMonthView ? "shiftBadge--month" : "shiftBadge--fullWidth",
        isDayOff 
          ? "bg-red-500 hover:bg-red-600 text-white" 
          : isSickLeave
            ? "bg-orange-500 hover:bg-orange-600 text-white"
            : isBusinessLeave
              ? "bg-blue-500 hover:bg-blue-600 text-white"
              : "bg-amber-400 hover:bg-amber-500 text-amber-900",
        className
      )}
      data-testid="leave-card"
    >
      {isMonthView ? (
        <span className="shiftBadge__text text-[9px] font-semibold">
          {isDayOff ? "Off" : label}
        </span>
      ) : (
        <span className="shiftBadge__text text-xs font-semibold">
          {label}
        </span>
      )}
      {onDelete && (
        <button
          className="absolute top-0.5 right-0.5 h-4 w-4 opacity-0 group-hover:opacity-100 rounded-sm hover:bg-white/20 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          data-testid="button-remove-timeoff"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  if (!onDelete) {
    return cardContent;
  }

  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="border-0 bg-transparent p-0 w-full" onClick={() => setDetailsOpen(true)}>
          {cardContent}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-3" align="start">
        <div className="space-y-2">
          <div className="font-medium text-sm">{label}</div>
          <div className="text-xs text-muted-foreground">
            {isDayOff ? "Scheduled day off" : "Time off / leave"}
          </div>
          {onDelete && (
            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              onClick={() => {
                onDelete();
                setDetailsOpen(false);
              }}
              data-testid="button-delete-timeoff"
            >
              <X className="h-3 w-3 mr-1" />
              Remove
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface OffDayCardProps {
  isCompact?: boolean;
  viewMode?: ViewMode;
  className?: string;
}

export function OffDayCard({ isCompact = false, viewMode = "week", className }: OffDayCardProps) {
  const isMonthView = viewMode === "month";
  
  return (
    <div
      className={cn(
        "shiftBadge bg-gray-400 dark:bg-gray-600 text-white",
        isMonthView ? "shiftBadge--month" : "shiftBadge--fullWidth",
        className
      )}
      data-testid="off-day-card"
    >
      <span className={cn(
        "shiftBadge__text font-semibold",
        isMonthView ? "text-[9px]" : "text-xs"
      )}>
        OFF
      </span>
    </div>
  );
}

export type DeptShiftAssignment = {
  id: string;
  employeeId: string;
  employeeName: string;
  hasTimeOff?: boolean;
  isSick?: boolean;
  isBorrowed?: boolean;
  borrowedFromBranchName?: string;
  breakStart?: string;
  breakEnd?: string;
  breakHasConflict?: boolean;
};

interface DeptShiftCellProps {
  shiftName: string;
  timeRange: string;
  departmentName?: string;
  roles?: string[];
  assignments: DeptShiftAssignment[];
  onRemoveAssignment?: (assignmentId: string) => void;
  onAssign?: () => void;
  onDeleteShiftRow?: () => void;
  isManager?: boolean;
  className?: string;
  renderAssignment?: (assignment: DeptShiftAssignment, index: number) => React.ReactNode;
  colorIndex?: number | null;
}

export function DeptShiftCell({
  shiftName,
  timeRange,
  departmentName,
  roles,
  assignments,
  onRemoveAssignment,
  onAssign,
  onDeleteShiftRow,
  isManager = false,
  className,
  renderAssignment,
  colorIndex,
}: DeptShiftCellProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasAssignments = assignments.length > 0;
  const maxVisible = 3;
  const visibleAssignments = assignments.slice(0, maxVisible);
  const overflowCount = assignments.length > maxVisible ? assignments.length - maxVisible : 0;
  
  // Use shift colorIndex if available, otherwise use employee-based colors
  const shiftColor = colorIndex != null ? getShiftColorByIndex(colorIndex) : null;

  const cellContent = (
    <div
      className={cn(
        "min-h-[28px] px-0.5 py-0.5 cursor-pointer transition-colors flex flex-col gap-0.5",
        !hasAssignments && "bg-transparent",
        className
      )}
      data-testid="dept-shift-cell"
    >
      {hasAssignments && (
        <div className="flex flex-col gap-0.5 w-full">
          {visibleAssignments.map((a, index) => (
            renderAssignment ? renderAssignment(a, index) : (
              <div
                key={a.id}
                className={cn(
                  "text-[10px] font-medium truncate leading-tight text-center px-1 py-0.5 rounded-sm text-white w-full relative",
                  shiftColor || getEmployeeColor(a.employeeId),
                  a.isSick && "line-through opacity-70",
                  a.hasTimeOff && !a.isSick && "opacity-70",
                  a.isBorrowed && "ring-2 ring-yellow-400 ring-offset-1"
                )}
                title={a.isBorrowed ? `Borrowed from ${a.borrowedFromBranchName || 'another branch'}` : undefined}
              >
                {a.employeeName}
                {a.isBorrowed && (
                  <span className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-yellow-950 text-[8px] font-bold px-1 rounded shadow-sm">
                    B
                  </span>
                )}
              </div>
            )
          ))}
          {overflowCount > 0 && (
            <div className="text-[10px] text-muted-foreground">+{overflowCount} more</div>
          )}
        </div>
      )}
    </div>
  );

  if (!hasAssignments) {
    return cellContent;
  }

  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="border-0 bg-transparent p-0 w-full text-left"
          onClick={() => setDetailsOpen(true)}
          data-testid="button-dept-shift-cell"
        >
          {cellContent}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
          <div className="space-y-2">
            <div className="font-medium text-sm">{shiftName || "Shift"}</div>
            <div className="text-xs text-muted-foreground font-mono">{timeRange}</div>
            {departmentName && (
              <div className="text-xs">
                <span className="text-muted-foreground">Dept:</span> {departmentName}
              </div>
            )}
            {roles && roles.length > 0 && (
              <div className="text-xs">
                <span className="text-muted-foreground">Roles:</span> {roles.join(", ")}
              </div>
            )}
            <div className="border-t pt-2 mt-2">
              <div className="text-xs text-muted-foreground mb-1">Assigned ({assignments.length})</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {assignments.map((a) => (
                  <div key={a.id} className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className={cn("text-xs truncate", a.isSick && "line-through opacity-70")}>
                        {a.employeeName}
                      </span>
                      {onRemoveAssignment && isManager && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1 text-destructive"
                          onClick={() => {
                            onRemoveAssignment(a.id);
                            if (assignments.length === 1) setDetailsOpen(false);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    {a.breakStart && a.breakEnd && (
                      <div className={cn(
                        "text-[10px] flex items-center gap-1 pl-1",
                        a.breakHasConflict ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                      )}>
                        <Coffee className="h-2.5 w-2.5" />
                        <span>Break: {a.breakStart.slice(0, 5)}-{a.breakEnd.slice(0, 5)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              {onAssign && isManager && (
                <Button
                  variant="default"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    onAssign();
                    setDetailsOpen(false);
                  }}
                >
                  Assign More
                </Button>
              )}
              {onDeleteShiftRow && isManager && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    onDeleteShiftRow();
                    setDetailsOpen(false);
                  }}
                >
                  Delete Row
                </Button>
              )}
            </div>
          </div>
      </PopoverContent>
    </Popover>
  );
}
