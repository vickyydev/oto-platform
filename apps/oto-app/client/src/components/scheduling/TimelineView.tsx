import { useMemo, useState, useEffect } from "react";
import { format, parseISO, getDay } from "date-fns";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CheckCircle2, AlertCircle, Coffee, ListChecks } from "lucide-react";
import { getDepartmentColor, getShiftColorByIndex, getEmployeeColor, formatEmployeeName, getInitials, type NameDisplayMode } from "./utils";
import { EmployeeInfoPopup } from "./EmployeeInfoPopup";
import type { AvatarStatusMap } from "@/hooks/use-avatar-work-status";

type TimelineDutyBlock = {
  id: string;
  assignmentId: string;
  employeeId: string;
  dutyName: string | null;
  startTime: string;
  endTime: string;
  color?: string | null;
  dutyTypeId?: string | null;
};

type Department = {
  id: string;
  name: string;
};

type Role = {
  id: string;
  name: string;
};

type Employee = {
  id: string;
  fullName: string;
  nickname?: string | null;
  primaryDepartmentId?: string | null;
  profilePhotoPath?: string | null;
};

type ScheduleShiftRowRole = {
  roleId: string;
  role?: Role;
};

type ScheduleAssignment = {
  id: string;
  shiftRowId: string;
  shiftDate: string;
  employeeId: string;
  employee?: Employee;
};

type ScheduleShiftBreak = {
  id: string;
  shiftRowId: string;
  assignmentId: string;
  shiftDate: string;
  breakStartTime: string;
  breakEndTime: string;
  breakDurationMinutes: number;
  hasConflict: boolean;
};

type ScheduleShiftRow = {
  id: string;
  departmentId: string;
  startTime: string;
  endTime: string;
  label: string | null;
  shiftGroupId?: string | null;
  staffRequired: number;
  staffRequiredByDay?: Record<string, number> | null;
  colorIndex?: number | null;
  department?: Department;
  roles: ScheduleShiftRowRole[];
  assignments: ScheduleAssignment[];
  breaks?: ScheduleShiftBreak[];
};

type BranchEvent = {
  id: string;
  branchId: string;
  title: string;
  description: string | null;
  location: string | null;
  startDateTime: string;
  endDateTime: string;
  isAllDay: boolean;
  status?: string;
  source?: "local" | "core" | "studio";
};

type TimelineViewProps = {
  date: Date;
  shiftRows: ScheduleShiftRow[];
  employees: Employee[];
  departments: Department[];
  departmentFilter: string[];
  events?: BranchEvent[];
  dutyBlocks?: TimelineDutyBlock[];
  shiftGroups?: { id: string; name: string }[];
  onNavigateToDay?: (date: Date) => void;
  employeeStatusMap?: AvatarStatusMap;
};

const START_HOUR = 8;
const END_HOUR = 22;
const VISIBLE_HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
const HOUR_WIDTH_PORTRAIT = 32;
const HOUR_WIDTH_LANDSCAPE = 48;
const ROW_HEIGHT = 36;
const LEFT_COL_WIDTH = 120;

const DAY_KEYS: Record<number, string> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

function useIsLandscape() {
  const [isLandscape, setIsLandscape] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(orientation: landscape)").matches;
  });

  useEffect(() => {
    const mql = window.matchMedia("(orientation: landscape)");
    const handleChange = (e: MediaQueryListEvent) => {
      setIsLandscape(e.matches);
    };
    
    mql.addEventListener("change", handleChange);
    setIsLandscape(mql.matches);
    
    return () => {
      mql.removeEventListener("change", handleChange);
    };
  }, []);

  return isLandscape;
}

function timeToPosition(time: string, hourWidth: number): number {
  const [hours, minutes] = time.split(":").map(Number);
  const totalHours = hours + minutes / 60;
  return Math.max(0, (totalHours - START_HOUR) * hourWidth);
}

function clampPosition(pos: number, hourWidth: number): number {
  const maxPos = (END_HOUR - START_HOUR) * hourWidth;
  return Math.max(0, Math.min(pos, maxPos));
}

function getRequiredStaffForDate(shiftRow: ScheduleShiftRow, date: Date): number {
  const dayKey = DAY_KEYS[getDay(date)];
  if (shiftRow.staffRequiredByDay && shiftRow.staffRequiredByDay[dayKey] !== undefined) {
    return shiftRow.staffRequiredByDay[dayKey];
  }
  return shiftRow.staffRequired || 0;
}

function shiftCoversHour(startTime: string, endTime: string, hour: number): boolean {
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startDecimal = startH + startM / 60;
  const endDecimal = endH + endM / 60;
  return startDecimal < (hour + 1) && endDecimal > hour;
}

type HourlyStaffing = {
  required: number;
  assigned: number;
  shortage: number;
  shifts: { label: string; required: number; assigned: number }[];
};

const DUTY_BLOCK_COLORS = [
  "rgba(59, 130, 246, 0.6)",
  "rgba(168, 85, 247, 0.6)",
  "rgba(236, 72, 153, 0.6)",
  "rgba(34, 197, 94, 0.6)",
  "rgba(249, 115, 22, 0.6)",
  "rgba(14, 165, 233, 0.6)",
];

export function TimelineView({
  date,
  shiftRows,
  employees,
  departments,
  departmentFilter,
  events = [],
  dutyBlocks = [],
  shiftGroups = [],
  onNavigateToDay,
  employeeStatusMap,
}: TimelineViewProps) {
  const [photoDialogOpen, setPhotoDialogOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const isLandscape = useIsLandscape();
  const hourWidth = isLandscape ? HOUR_WIDTH_LANDSCAPE : HOUR_WIDTH_PORTRAIT;
  const nameMode: NameDisplayMode = isLandscape ? 'abbreviated' : 'initials';
  const dateStr = format(date, "yyyy-MM-dd");

  const handleEmployeeClick = (e: React.MouseEvent, employee: Employee) => {
    e.stopPropagation();
    setSelectedEmployee(employee);
    setPhotoDialogOpen(true);
  };

  const handleTimelineClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('[data-timeline-interactive]') ||
      target.closest('[data-radix-popper-content-wrapper]') ||
      target.closest('[role="dialog"]')
    ) {
      return;
    }
    onNavigateToDay?.(date);
  };

  const filteredShiftRows = useMemo(() => {
    return shiftRows.filter(row => {
      if (departmentFilter.length > 0 && !departmentFilter.includes(row.departmentId)) {
        return false;
      }
      return true;
    });
  }, [shiftRows, departmentFilter]);

  const shiftRowsWithAssignments = useMemo(() => {
    return filteredShiftRows.map(row => {
      const dayAssignments = row.assignments.filter(a => a.shiftDate === dateStr);
      const assignedCount = dayAssignments.length;
      const requiredCount = getRequiredStaffForDate(row, date);
      const isFilled = assignedCount >= requiredCount;
      
      const assignedEmployees = dayAssignments
        .map(a => {
          const emp = a.employee || employees.find(e => e.id === a.employeeId);
          return emp ? { ...emp, assignmentId: a.id, shiftRowId: row.id } : null;
        })
        .filter(Boolean) as (Employee & { assignmentId: string; shiftRowId: string })[];
      
      return {
        ...row,
        assignedCount,
        requiredCount,
        isFilled,
        assignedEmployees,
      };
    });
  }, [filteredShiftRows, dateStr, date, employees]);

  const departmentsWithData = useMemo(() => {
    const groupMap = new Map<string, {
      department: Department;
      shiftRows: typeof shiftRowsWithAssignments;
      employees: Map<string, {
        employee: Employee;
        shifts: { shiftRow: typeof shiftRowsWithAssignments[0]; assignmentId: string }[];
      }>;
      hourlyStaffing: Map<number, HourlyStaffing>;
    }>();

    const shiftGroupOrderMap = new Map<string, number>();
    shiftGroups.forEach((sg, idx) => {
      shiftGroupOrderMap.set(sg.id, idx);
    });

    shiftRowsWithAssignments.forEach(row => {
      const groupId = row.shiftGroupId || "ungrouped";
      const groupName = row.shiftGroupId
        ? shiftGroups.find(g => g.id === row.shiftGroupId)?.name || "Unknown Group"
        : (row.department?.name || departments.find(d => d.id === row.departmentId)?.name || "Ungrouped");

      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, {
          department: { id: groupId, name: groupName },
          shiftRows: [],
          employees: new Map(),
          hourlyStaffing: new Map(),
        });
      }

      const groupData = groupMap.get(groupId)!;
      groupData.shiftRows.push(row);

      VISIBLE_HOURS.forEach(hour => {
        if (shiftCoversHour(row.startTime, row.endTime, hour)) {
          if (!groupData.hourlyStaffing.has(hour)) {
            groupData.hourlyStaffing.set(hour, {
              required: 0,
              assigned: 0,
              shortage: 0,
              shifts: [],
            });
          }

          const hourData = groupData.hourlyStaffing.get(hour)!;
          hourData.required += row.requiredCount;
          hourData.assigned += row.assignedCount;
          hourData.shortage = Math.max(0, hourData.required - hourData.assigned);
          hourData.shifts.push({
            label: row.label || `${row.startTime.slice(0, 5)}-${row.endTime.slice(0, 5)}`,
            required: row.requiredCount,
            assigned: row.assignedCount,
          });
        }
      });
    });

    shiftRowsWithAssignments.forEach(row => {
      const groupId = row.shiftGroupId || "ungrouped";
      if (!groupMap.has(groupId)) return;

      const groupData = groupMap.get(groupId)!;

      row.assignedEmployees.forEach(assignedEmp => {
        if (!groupData.employees.has(assignedEmp.id)) {
          groupData.employees.set(assignedEmp.id, {
            employee: assignedEmp,
            shifts: [],
          });
        }
        groupData.employees.get(assignedEmp.id)!.shifts.push({
          shiftRow: row,
          assignmentId: assignedEmp.assignmentId,
        });
      });
    });

    const sortedGroups = Array.from(groupMap.entries()).sort((a, b) => {
      const orderA = shiftGroupOrderMap.get(a[0]) ?? 9999;
      const orderB = shiftGroupOrderMap.get(b[0]) ?? 9999;
      if (orderA !== orderB) return orderA - orderB;
      return a[1].department.name.localeCompare(b[1].department.name);
    });

    return sortedGroups.map(([, data]) => data);
  }, [shiftRowsWithAssignments, departments, employees, shiftGroups]);

  const dayEvents = useMemo(() => {
    return events.filter(event => {
      const eventDate = format(parseISO(event.startDateTime), "yyyy-MM-dd");
      return eventDate === dateStr;
    });
  }, [events, dateStr]);

  const gridWidth = (END_HOUR - START_HOUR) * hourWidth;

  if (departmentsWithData.length === 0 && dayEvents.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <p>No shifts or events scheduled for {format(date, "EEEE, d MMMM yyyy")}</p>
      </div>
    );
  }

  return (
    <div className="relative cursor-pointer" onClick={handleTimelineClick} data-testid="timeline-view-container">
      <ScrollArea className="w-full">
        <div style={{ minWidth: gridWidth + LEFT_COL_WIDTH }}>
          <div className="flex sticky top-0 z-20 bg-background border-b">
            <div className="shrink-0 px-2 py-1 font-medium text-xs border-r bg-muted/50 flex items-center" style={{ width: LEFT_COL_WIDTH }}>
              Shift / Staff
            </div>
            <div className="flex relative">
              {VISIBLE_HOURS.map((hour) => (
                <div
                  key={hour}
                  className="shrink-0 border-r border-dashed text-[10px] text-muted-foreground text-center pt-1"
                  style={{ width: hourWidth }}
                >
                  {hour.toString().padStart(2, "0")}
                </div>
              ))}
            </div>
          </div>

          {dayEvents.length > 0 && (
            <div className="flex border-b bg-purple-50 dark:bg-purple-900/20">
              <div className="shrink-0 px-2 py-1 text-xs font-medium border-r text-purple-700 dark:text-purple-300 flex items-center" style={{ width: LEFT_COL_WIDTH }}>
                Events
              </div>
              <div className="relative flex-1" style={{ height: ROW_HEIGHT }}>
                {VISIBLE_HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="absolute top-0 bottom-0 border-r border-dashed border-muted/50"
                    style={{ left: (hour - START_HOUR) * hourWidth, width: hourWidth }}
                  />
                ))}
                {dayEvents.map((event) => {
                  const startTime = format(parseISO(event.startDateTime), "HH:mm");
                  const endTime = format(parseISO(event.endDateTime), "HH:mm");
                  
                  let left: number;
                  let width: number;
                  
                  if (event.isAllDay) {
                    left = 0;
                    width = gridWidth;
                  } else {
                    const rawLeft = timeToPosition(startTime, hourWidth);
                    const rawRight = timeToPosition(endTime, hourWidth);
                    left = clampPosition(rawLeft, hourWidth);
                    const right = clampPosition(rawRight, hourWidth);
                    width = Math.max(right - left, 20);
                  }
                  
                  return (
                    <Popover key={event.id}>
                      <PopoverTrigger asChild>
                        <button
                          className="absolute top-1 bottom-1 rounded-sm bg-purple-500/80 dark:bg-purple-600/80 text-white text-[9px] leading-none font-medium flex items-center justify-center overflow-hidden cursor-pointer"
                          style={{ left, width }}
                          data-testid={`timeline-event-${event.id}`}
                          data-timeline-interactive
                        >
                          <span className="truncate px-0.5">{event.title}</span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="top" className="w-56 p-3" align="center">
                        <div className="space-y-1">
                          <p className="font-medium text-sm">{event.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {event.isAllDay ? "All day" : `${startTime} – ${endTime}`}
                          </p>
                          {event.location && (
                            <p className="text-xs text-muted-foreground">{event.location}</p>
                          )}
                          {event.source === "core" && (
                            <p className="text-xs text-purple-600 dark:text-purple-400">OTO Core Event</p>
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  );
                })}
              </div>
            </div>
          )}

          {departmentsWithData.map(({ department, employees: empMap, shiftRows: deptShiftRows, hourlyStaffing }) => {
            const hasAnyShortage = Array.from(hourlyStaffing.values()).some(h => h.shortage > 0);
            const employeesArray = Array.from(empMap.values());

            return (
              <div key={department.id} className="border-b" data-testid={`timeline-dept-${department.id}`}>
                <div className="flex bg-primary/15 dark:bg-primary/20">
                  <div className="shrink-0 px-2 py-1.5 border-r flex items-center gap-2" style={{ width: LEFT_COL_WIDTH }}>
                    <span className="text-xs font-semibold truncate flex-1">{department.name}</span>
                    {hasAnyShortage && (
                      <AlertCircle className="h-4 w-4 text-orange-500 shrink-0" />
                    )}
                  </div>
                  <div className="flex flex-1">
                    {VISIBLE_HOURS.map((hour) => {
                      const hourData = hourlyStaffing.get(hour);
                      
                      if (!hourData || hourData.required === 0) {
                        return (
                          <div
                            key={hour}
                            className="shrink-0 border-r border-dashed"
                            style={{ width: hourWidth, height: ROW_HEIGHT }}
                          />
                        );
                      }

                      const isFullyStaffed = hourData.assigned >= hourData.required;

                      return (
                        <Popover key={hour}>
                          <PopoverTrigger asChild>
                            <button
                              className={cn(
                                "shrink-0 border-r flex items-center justify-center gap-0.5",
                                isFullyStaffed 
                                  ? "bg-green-100 dark:bg-green-900/30" 
                                  : "bg-orange-100 dark:bg-orange-900/30"
                              )}
                              style={{ width: hourWidth, height: ROW_HEIGHT }}
                              data-timeline-interactive
                              data-testid={`timeline-hour-${department.id}-${hour}`}
                            >
                              {isFullyStaffed ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                              ) : (
                                <>
                                  <AlertCircle className="h-3 w-3 text-orange-600 dark:text-orange-400" />
                                  <span className="text-[10px] font-bold text-orange-600 dark:text-orange-400">
                                    -{hourData.shortage}
                                  </span>
                                </>
                              )}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-3" align="center" data-timeline-interactive>
                            <div className="space-y-2">
                              <div className="font-medium text-sm">
                                {hour.toString().padStart(2, "0")}:00 - {(hour + 1).toString().padStart(2, "0")}:00
                              </div>
                              <div className={cn(
                                "text-sm font-medium",
                                isFullyStaffed ? "text-green-600" : "text-orange-600"
                              )}>
                                {hourData.assigned} / {hourData.required} staff
                                {!isFullyStaffed && ` (need ${hourData.shortage} more)`}
                              </div>
                              {hourData.shifts.length > 0 && (
                                <div className="space-y-1 pt-1 border-t">
                                  <div className="text-xs text-muted-foreground font-medium">Shifts:</div>
                                  {hourData.shifts.map((shift, idx) => (
                                    <div key={idx} className="text-xs flex justify-between">
                                      <span className="truncate">{shift.label}</span>
                                      <span className={cn(
                                        "font-medium",
                                        shift.assigned >= shift.required ? "text-green-600" : "text-orange-600"
                                      )}>
                                        {shift.assigned}/{shift.required}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                      );
                    })}
                  </div>
                </div>

                {employeesArray.map(({ employee, shifts }) => {
                  const displaySource = employee.nickname || employee.fullName;
                  const initials = getInitials(displaySource);
                  const displayName = employee.nickname || formatEmployeeName(employee.fullName, nameMode);

                  return (
                    <div key={employee.id} className="flex border-t border-dashed">
                      <div 
                        className="shrink-0 py-1 px-2 border-r flex items-center gap-1.5 cursor-pointer pl-4" 
                        style={{ width: LEFT_COL_WIDTH }}
                        onClick={(e) => handleEmployeeClick(e, employee)}
                        data-timeline-interactive
                        data-testid={`timeline-employee-row-${employee.id}`}
                      >
                        {employeeStatusMap?.[employee.id]?.status === "CLOCKED_IN" && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" data-testid={`timeline-status-dot-${employee.id}`} />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">Clocked in</TooltipContent>
                          </Tooltip>
                        )}
                        <Avatar 
                          className="h-5 w-5 shrink-0"
                          data-testid={`timeline-avatar-${employee.id}`}
                        >
                          {employee.profilePhotoPath && (
                            <AvatarImage src={employee.profilePhotoPath} alt={employee.fullName} />
                          )}
                          <AvatarFallback className="bg-primary/10 text-primary text-[9px] font-medium">
                            {initials.slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-[11px] font-medium truncate">{displayName}</span>
                      </div>
                      <div className="relative flex-1" style={{ height: ROW_HEIGHT - 4 }}>
                        {VISIBLE_HOURS.map((hour) => (
                          <div
                            key={hour}
                            className="absolute top-0 bottom-0 border-r border-dashed border-muted/30"
                            style={{ left: (hour - START_HOUR) * hourWidth, width: hourWidth }}
                          />
                        ))}
                        {shifts.map(({ shiftRow, assignmentId }) => {
                          const rawLeft = timeToPosition(shiftRow.startTime, hourWidth);
                          const rawRight = timeToPosition(shiftRow.endTime, hourWidth);
                          const left = clampPosition(rawLeft, hourWidth);
                          const right = clampPosition(rawRight, hourWidth);
                          const shiftWidth = Math.max(right - left, 40);
                          const shiftColorClass = shiftRow.colorIndex != null 
                            ? getShiftColorByIndex(shiftRow.colorIndex) 
                            : getDepartmentColor(shiftRow.departmentId);

                          const assignmentBreak = (shiftRow.breaks || []).find(
                            (b) => b.assignmentId === assignmentId && b.shiftDate === dateStr
                          );

                          const assignmentDutyBlocks = dutyBlocks.filter(
                            (db) => db.assignmentId === assignmentId
                          ).sort((a, b) => a.startTime.localeCompare(b.startTime));

                          let breakIndicator = null;
                          if (assignmentBreak) {
                            const breakLeft = clampPosition(timeToPosition(assignmentBreak.breakStartTime, hourWidth), hourWidth) - left;
                            const breakRight = clampPosition(timeToPosition(assignmentBreak.breakEndTime, hourWidth), hourWidth) - left;
                            const breakWidth = Math.max(breakRight - breakLeft, 2);
                            breakIndicator = (
                              <div
                                className="absolute top-0 bottom-0"
                                style={{
                                  left: breakLeft,
                                  width: breakWidth,
                                  backgroundColor: assignmentBreak.hasConflict ? "rgba(245, 158, 11, 0.85)" : "rgba(0, 0, 0, 0.35)",
                                  backgroundImage: "repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.35) 3px, rgba(255,255,255,0.35) 5px)",
                                  borderLeft: "1.5px solid rgba(255,255,255,0.5)",
                                  borderRight: "1.5px solid rgba(255,255,255,0.5)",
                                }}
                                data-testid={`timeline-break-${assignmentId}`}
                              />
                            );
                          }

                          const dutyBlockIndicators = assignmentDutyBlocks.map((db, idx) => {
                            const dbLeft = clampPosition(timeToPosition(db.startTime, hourWidth), hourWidth) - left;
                            const dbRight = clampPosition(timeToPosition(db.endTime, hourWidth), hourWidth) - left;
                            const dbWidth = Math.max(dbRight - dbLeft, 2);
                            const bgColor = DUTY_BLOCK_COLORS[idx % DUTY_BLOCK_COLORS.length];
                            return (
                              <div
                                key={db.id}
                                className="absolute top-0 bottom-0"
                                style={{
                                  left: dbLeft,
                                  width: dbWidth,
                                  backgroundColor: bgColor,
                                  backgroundImage: "repeating-linear-gradient(-45deg, transparent, transparent 3px, rgba(255,255,255,0.15) 3px, rgba(255,255,255,0.15) 5px)",
                                }}
                                data-testid={`timeline-duty-${db.id}`}
                              />
                            );
                          });

                          return (
                            <Popover key={assignmentId}>
                              <PopoverTrigger asChild>
                                <button
                                  className={cn(
                                    "absolute top-1 bottom-1 rounded-sm text-white text-[8px] leading-none font-medium flex items-center justify-center overflow-hidden cursor-pointer",
                                    shiftColorClass
                                  )}
                                  style={{ left, width: shiftWidth }}
                                  data-testid={`timeline-shift-${assignmentId}`}
                                  data-timeline-interactive
                                >
                                  {shiftWidth > 60 && (() => {
                                    const groupName = shiftRow.shiftGroupId ? shiftGroups.find(g => g.id === shiftRow.shiftGroupId)?.name : null;
                                    const displayLabel = groupName || (shiftRow.roles.length > 0 ? shiftRow.roles[0]?.role?.name : null);
                                    return displayLabel ? <span className="truncate px-0.5 relative z-10 opacity-90">{displayLabel}</span> : null;
                                  })()}
                                  {dutyBlockIndicators}
                                  {breakIndicator}
                                </button>
                              </PopoverTrigger>
                              <PopoverContent side="top" className="w-64 p-3" align="center">
                                <div className="space-y-1.5">
                                  <p className="font-medium text-sm">{employee.nickname || employee.fullName}</p>
                                  <div className={cn("inline-block px-2 py-1 rounded text-xs font-medium text-white", shiftColorClass)}>
                                    {shiftRow.startTime.slice(0, 5)} – {shiftRow.endTime.slice(0, 5)}
                                  </div>
                                  {(() => {
                                    const groupName = shiftRow.shiftGroupId ? shiftGroups.find(g => g.id === shiftRow.shiftGroupId)?.name : null;
                                    const roleNames = shiftRow.roles.length > 0 ? shiftRow.roles.map(r => r.role?.name).filter(Boolean).join(', ') : null;
                                    return (
                                      <>
                                        {groupName && (
                                          <p className="text-xs">
                                            <span className="text-muted-foreground">Group: </span>
                                            {groupName}
                                          </p>
                                        )}
                                        {roleNames && (
                                          <p className="text-xs">
                                            <span className="text-muted-foreground">Role: </span>
                                            {roleNames}
                                          </p>
                                        )}
                                      </>
                                    );
                                  })()}
                                  {shiftRow.label && (
                                    <p className="text-xs">
                                      <span className="text-muted-foreground">Shift: </span>
                                      {shiftRow.label}
                                    </p>
                                  )}
                                  {assignmentBreak && (
                                    <div className={cn(
                                      "text-xs flex items-center gap-1.5 pt-1 border-t",
                                      assignmentBreak.hasConflict ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                                    )}>
                                      <Coffee className="h-3.5 w-3.5" />
                                      <span>Break: {assignmentBreak.breakStartTime.slice(0, 5)} – {assignmentBreak.breakEndTime.slice(0, 5)}</span>
                                      {assignmentBreak.hasConflict && (
                                        <span className="text-amber-500 font-medium">(conflict)</span>
                                      )}
                                    </div>
                                  )}
                                  {assignmentDutyBlocks.length > 0 && (
                                    <div className="text-xs space-y-1 pt-1 border-t">
                                      <div className="flex items-center gap-1 text-muted-foreground font-medium">
                                        <ListChecks className="h-3.5 w-3.5" />
                                        <span>Duty Blocks</span>
                                      </div>
                                      {assignmentDutyBlocks.map((db, idx) => (
                                        <div key={db.id} className="flex items-center gap-1.5 pl-1">
                                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: DUTY_BLOCK_COLORS[idx % DUTY_BLOCK_COLORS.length] }} />
                                          <span className="font-medium">{db.dutyName || "Duty"}</span>
                                          <span className="text-muted-foreground">{db.startTime.slice(0, 5)} – {db.endTime.slice(0, 5)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </PopoverContent>
                            </Popover>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {employeesArray.length === 0 && (
                  <div className="flex border-t border-dashed">
                    <div className="shrink-0 py-2 px-2 border-r text-xs text-muted-foreground italic pl-4" style={{ width: LEFT_COL_WIDTH }}>
                      No staff assigned
                    </div>
                    <div className="relative flex-1" style={{ height: ROW_HEIGHT - 8 }}>
                      {VISIBLE_HOURS.map((hour) => (
                        <div
                          key={hour}
                          className="absolute top-0 bottom-0 border-r border-dashed border-muted/30"
                          style={{ left: (hour - START_HOUR) * hourWidth, width: hourWidth }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      {selectedEmployee && (
        <EmployeeInfoPopup
          open={photoDialogOpen}
          onOpenChange={setPhotoDialogOpen}
          employeeId={selectedEmployee.id}
          employeeName={selectedEmployee.nickname || selectedEmployee.fullName}
          avatarUrl={selectedEmployee.profilePhotoPath}
        />
      )}
    </div>
  );
}
