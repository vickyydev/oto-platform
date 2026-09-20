import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, addDays, startOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isWeekend, getDay } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { Users, User, AlertCircle, CalendarDays, UserCircle, MapPin, Plus, Minus, Palmtree, Moon, Sun, Coffee, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { TimelineControls, type TimelineMode } from "@/components/scheduling";
import { getShiftColorByIndex } from "@/components/scheduling/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { timeOffTypeLabels, type TimeOffType } from "@shared/schema";

function isCurrentlyOnShift(date: string, startTime: string, endTime: string): boolean {
  const now = new Date();
  const today = format(now, "yyyy-MM-dd");
  if (date !== today) return false;
  
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

type Scope = "me" | "everyone";

type RotaShift = {
  date: string;
  start: string;
  end: string;
  employeeName: string;
  employeeId: string;
  department: string;
  departmentId: string;
  roles: string[];
  resolvedRoleName?: string;
  roleSource?: string;
  shiftGroupName?: string | null;
  shiftGroupId?: string | null;
  label: string | null;
  shiftRowId: string;
  staffRequired: number;
  staffRequiredByDay: Record<string, number> | null;
  branchId?: string;
  branchName?: string;
  isBorrowed?: boolean;
  breakStart?: string | null;
  breakEnd?: string | null;
  breakHasConflict?: boolean;
  colorIndex?: number | null;
  dutyBlocks?: { id: string; dutyName: string; startTime: string; endTime: string }[];
};

type Department = {
  id: string;
  name: string;
};

type BranchEvent = {
  id: string;
  title: string;
  startDateTime: string;
  endDateTime: string;
  isAllDay: boolean;
  location?: string;
  description?: string;
  source?: string;
  numChildren?: number;
  numAdults?: number;
  programName?: string;
  parentName?: string;
  partyHostName?: string;
};

type MyTimeOffRecord = {
  id: string;
  type: TimeOffType;
  startDate: string;
  endDate: string;
  note: string | null;
};

type MyTimeOffResponse = {
  timeOff: MyTimeOffRecord[];
  weeklyOffDays: number[];
  employeeId: string;
};

// Time off record with employee info for "everyone" scope
type AllTimeOffRecord = {
  id: string;
  type: TimeOffType;
  startDate: string;
  endDate: string;
  note: string | null;
  employeeId: string;
};

// Employee with weeklyOffDays
type EmployeeWithOffDays = {
  id: string;
  fullName: string;
  nickname?: string | null;
  weeklyOffDays: number[];
  branchId: string;
  primaryDepartmentId: string | null;
  status: string;
  startDate: string | null;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TIME_OFF_COLORS: Record<TimeOffType, string> = {
  SICK: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  ANNUAL: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  UNPAID: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  TRAINING: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  OTHER: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  CHANGE_DAY_OFF: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

const SHIFT_COLORS = [
  "bg-emerald-600",
  "bg-indigo-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-purple-600",
  "bg-orange-600",
  "bg-teal-600",
  "bg-pink-600",
  "bg-lime-600",
];

export default function RotaPage() {
  const { user } = useAuth();
  const { activeBranchId, branches, isLoading: branchesLoading } = useBranchContext();
  
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);
  
  const isStaffUser = user?.role === "staff";
  const [scope, setScope] = useState<Scope>("me");
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("day");
  const [selectedBranchId, setSelectedBranchId] = useState<string>("");
  const [currentDate, setCurrentDate] = useState(() => today);

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
    enabled: !!user,
  });

  const dateRange = useMemo(() => {
    switch (timelineMode) {
      case "day":
        return { from: currentDate, to: currentDate };
      case "3day":
        return { from: currentDate, to: addDays(currentDate, 2) };
      case "week":
        return { from: currentDate, to: addDays(currentDate, 6) };
      case "month":
        return { from: startOfMonth(currentDate), to: endOfMonth(currentDate) };
      default:
        return { from: currentDate, to: currentDate };
    }
  }, [timelineMode, currentDate]);

  const visibleDays = useMemo(() => {
    return eachDayOfInterval({ start: dateRange.from, end: dateRange.to });
  }, [dateRange]);

  const { data: shifts, isLoading, isError, error } = useQuery<RotaShift[]>({
    queryKey: ["/api/rota", { 
      scope: scope === "me" ? "me" : "branch", 
      branchId: selectedBranchId, 
      from: format(dateRange.from, "yyyy-MM-dd"),
      to: format(dateRange.to, "yyyy-MM-dd"),
    }],
    queryFn: async () => {
      const params = new URLSearchParams({
        scope: scope === "me" ? "me" : "branch",
        branchId: selectedBranchId,
        from: format(dateRange.from, "yyyy-MM-dd"),
        to: format(dateRange.to, "yyyy-MM-dd"),
      });
      const res = await fetch(`/api/rota?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch rota");
      return res.json();
    },
    enabled: !!selectedBranchId && !!user,
  });

  const eventsQueryStart = format(dateRange.from, "yyyy-MM-dd'T'00:00:00");
  const eventsQueryEnd = format(addDays(dateRange.to, 1), "yyyy-MM-dd'T'00:00:00");
  const { data: branchEvents } = useQuery<BranchEvent[]>({
    queryKey: ["/api/events", selectedBranchId, eventsQueryStart, eventsQueryEnd],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const params = new URLSearchParams({
        branchId: selectedBranchId,
        start: eventsQueryStart,
        end: eventsQueryEnd,
      });
      const res = await fetch(`/api/events?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  // Fetch my time off and weekly off days (used for current user in both scopes)
  const { data: myTimeOffData } = useQuery<MyTimeOffResponse>({
    queryKey: ["/api/my-time-off", user?.id, format(dateRange.from, "yyyy-MM-dd"), format(dateRange.to, "yyyy-MM-dd")],
    queryFn: async () => {
      const params = new URLSearchParams({
        dateFrom: format(dateRange.from, "yyyy-MM-dd"),
        dateTo: format(dateRange.to, "yyyy-MM-dd"),
      });
      const res = await fetch(`/api/my-time-off?${params}`, { credentials: "include" });
      if (!res.ok) return { timeOff: [], weeklyOffDays: [], employeeId: "" };
      return res.json();
    },
    enabled: !!user,
  });

  // Fetch borrowed-out assignments (employees from this branch working at other branches)
  type BorrowedOutAssignment = {
    id: string;
    employeeId: string;
    employeeName: string;
    shiftDate: string;
    startTime: string;
    endTime: string;
    shiftLabel: string | null;
    departmentName: string | null;
    toBranchId: string;
    toBranchName: string;
  };
  const { data: borrowedOutAssignments } = useQuery<BorrowedOutAssignment[]>({
    queryKey: ["/api/schedule/branches", selectedBranchId, "borrowed-out-assignments", format(dateRange.from, "yyyy-MM-dd")],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const params = new URLSearchParams({
        startDate: format(dateRange.from, "yyyy-MM-dd"),
        endDate: format(dateRange.to, "yyyy-MM-dd"),
      });
      const res = await fetch(`/api/schedule/branches/${selectedBranchId}/borrowed-out-assignments?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBranchId && scope === "everyone",
  });

  // Helper to get borrowed-out shifts for an employee on a specific date
  const getBorrowedOutForDate = (employeeId: string, dateStr: string): BorrowedOutAssignment[] => {
    if (!borrowedOutAssignments) return [];
    return borrowedOutAssignments.filter(a => a.employeeId === employeeId && a.shiftDate === dateStr);
  };

  // Fetch all time-off records for the branch (used by both scopes)
  const { data: allTimeOffRecords } = useQuery<AllTimeOffRecord[]>({
    queryKey: ["/api/time-off", selectedBranchId, format(dateRange.from, "yyyy-MM-dd"), format(dateRange.to, "yyyy-MM-dd")],
    queryFn: async () => {
      const params = new URLSearchParams({
        branchId: selectedBranchId,
        startDate: format(dateRange.from, "yyyy-MM-dd"),
        endDate: format(dateRange.to, "yyyy-MM-dd"),
      });
      const res = await fetch(`/api/time-off?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBranchId && !!user,
  });

  // Fetch employees with weeklyOffDays (used by both scopes)
  const { data: allEmployees } = useQuery<EmployeeWithOffDays[]>({
    queryKey: ["/api/employees", selectedBranchId, "weeklyOffDays"],
    queryFn: async () => {
      const params = new URLSearchParams({
        branchId: selectedBranchId,
        status: "active",
      });
      const res = await fetch(`/api/employees?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBranchId && !!user,
  });

  // Map employees to their weeklyOffDays
  const employeeOffDaysMap = useMemo(() => {
    const map = new Map<string, number[]>();
    if (allEmployees) {
      for (const emp of allEmployees) {
        map.set(emp.id, emp.weeklyOffDays || []);
      }
    }
    return map;
  }, [allEmployees]);

  // Fetch leave balances for display in schedule
  type LeaveBalanceData = {
    employeeId: string;
    balance: number;
  };
  type AllLeaveBalanceData = {
    employeeId: string;
    annual: { balance: number; canClaim: boolean };
    publicHolidays: { remaining: number };
  };

  const { data: leaveBalances } = useQuery<LeaveBalanceData[]>({
    queryKey: ["/api/leave-balances", selectedBranchId],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const res = await fetch(`/api/leave-balances?branchId=${selectedBranchId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBranchId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: allLeaveBalances } = useQuery<AllLeaveBalanceData[]>({
    queryKey: ["/api/all-leave-balances", selectedBranchId],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const params = new URLSearchParams({ branchId: selectedBranchId });
      const res = await fetch(`/api/all-leave-balances?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBranchId,
    staleTime: 5 * 60 * 1000,
  });

  // Create lookup maps for leave balances
  const leaveBalanceMap = useMemo(() => {
    const map = new Map<string, number>();
    if (leaveBalances) {
      for (const lb of leaveBalances) {
        map.set(lb.employeeId, lb.balance);
      }
    }
    return map;
  }, [leaveBalances]);

  const allLeaveBalanceMap = useMemo(() => {
    const map = new Map<string, AllLeaveBalanceData>();
    if (allLeaveBalances) {
      for (const alb of allLeaveBalances) {
        map.set(alb.employeeId, alb);
      }
    }
    return map;
  }, [allLeaveBalances]);

  // Helper to get display string for leave balances
  const getLeaveBalanceDisplay = (employeeId: string): string | null => {
    const parts: string[] = [];
    const daysOffBalance = leaveBalanceMap.get(employeeId);
    const allBalance = allLeaveBalanceMap.get(employeeId);
    
    if (daysOffBalance !== undefined) {
      parts.push(`Off: ${daysOffBalance >= 0 ? '+' : ''}${daysOffBalance}`);
    }
    if (allBalance) {
      const holidayBalance = (allBalance.annual.canClaim ? allBalance.annual.balance : 0) + allBalance.publicHolidays.remaining;
      parts.push(`Hol: ${holidayBalance}`);
    }
    return parts.length > 0 ? parts.join(" | ") : null;
  };

  // Map employees to their time-off records
  const employeeTimeOffMap = useMemo(() => {
    const map = new Map<string, AllTimeOffRecord[]>();
    if (allTimeOffRecords) {
      for (const record of allTimeOffRecords) {
        if (!map.has(record.employeeId)) {
          map.set(record.employeeId, []);
        }
        map.get(record.employeeId)!.push(record);
      }
    }
    return map;
  }, [allTimeOffRecords]);

  // Helper to check if a day is a weekly day off for a specific employee
  const isEmployeeWeeklyDayOff = (employeeId: string, day: Date): boolean => {
    const offDays = employeeOffDaysMap.get(employeeId);
    if (!offDays?.length) return false;
    const dayOfWeek = getDay(day);
    return offDays.includes(dayOfWeek);
  };

  // Helper to get time off for a specific employee and date
  const getEmployeeTimeOffForDate = (employeeId: string, day: Date): AllTimeOffRecord[] => {
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(23, 59, 59, 999);
    
    // For the current user, always use myTimeOffData (works in both scopes)
    if (myTimeOffData?.employeeId === employeeId && myTimeOffData?.timeOff?.length) {
      return myTimeOffData.timeOff.filter((record) => {
        const startDate = new Date(record.startDate);
        const endDate = new Date(record.endDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        return startDate <= dayEnd && endDate >= dayStart;
      });
    }
    
    // For other employees, use allTimeOffRecords
    const records = employeeTimeOffMap.get(employeeId);
    if (!records?.length) return [];
    
    return records.filter((record) => {
      const startDate = new Date(record.startDate);
      const endDate = new Date(record.endDate);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      return startDate <= dayEnd && endDate >= dayStart;
    });
  };

  // Helper to check if a day is a weekly day off
  const isWeeklyDayOff = (day: Date): boolean => {
    if (!myTimeOffData?.weeklyOffDays?.length) return false;
    const dayOfWeek = getDay(day); // 0 = Sunday, 1 = Monday, etc.
    return myTimeOffData.weeklyOffDays.includes(dayOfWeek);
  };

  // Helper to get time off for a specific date
  const getTimeOffForDate = (day: Date): MyTimeOffRecord[] => {
    if (!myTimeOffData?.timeOff?.length) return [];
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(23, 59, 59, 999);
    
    return myTimeOffData.timeOff.filter((record) => {
      const startDate = new Date(record.startDate);
      const endDate = new Date(record.endDate);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      return startDate <= dayEnd && endDate >= dayStart;
    });
  };

  const getEventsForDate = (day: Date): BranchEvent[] => {
    if (!branchEvents) return [];
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(24, 0, 0, 0);
    
    return branchEvents.filter((event) => {
      const eventStart = new Date(event.startDateTime);
      const eventEnd = new Date(event.endDateTime);
      return eventStart < dayEnd && eventEnd > dayStart;
    });
  };

  const uniqueShiftTypes = useMemo(() => {
    if (!shifts) return new Map<string, number>();
    const types = new Map<string, number>();
    let index = 0;
    for (const shift of shifts) {
      const key = `${shift.start}-${shift.end}-${shift.label || ""}`;
      if (!types.has(key)) {
        types.set(key, index);
        index++;
      }
    }
    return types;
  }, [shifts]);

  const getShiftColor = (shift: RotaShift): string => {
    if (shift.colorIndex != null) {
      return getShiftColorByIndex(shift.colorIndex);
    }
    const key = `${shift.start}-${shift.end}-${shift.label || ""}`;
    const index = uniqueShiftTypes.get(key) ?? 0;
    return SHIFT_COLORS[index % SHIFT_COLORS.length];
  };

  const shiftsGroupedByEmployee = useMemo(() => {
    const grouped: Map<string, Map<string, RotaShift[]>> = new Map();
    if (!shifts) return grouped;
    
    for (const shift of shifts) {
      if (!grouped.has(shift.employeeId)) {
        grouped.set(shift.employeeId, new Map());
      }
      const empShifts = grouped.get(shift.employeeId)!;
      if (!empShifts.has(shift.date)) {
        empShifts.set(shift.date, []);
      }
      empShifts.get(shift.date)!.push(shift);
    }
    return grouped;
  }, [shifts]);

  const uniqueEmployees = useMemo(() => {
    if (!shifts) return [];
    const seen = new Map<string, { id: string; name: string; departmentId: string; department: string }>();
    for (const shift of shifts) {
      if (!seen.has(shift.employeeId)) {
        seen.set(shift.employeeId, {
          id: shift.employeeId,
          name: shift.employeeName,
          departmentId: shift.departmentId,
          department: shift.department,
        });
      }
    }
    return Array.from(seen.values());
  }, [shifts]);

  const employeesByDepartment = useMemo(() => {
    const grouped: Map<string, { id: string; name: string }[]> = new Map();
    for (const emp of uniqueEmployees) {
      if (!grouped.has(emp.departmentId)) {
        grouped.set(emp.departmentId, []);
      }
      grouped.get(emp.departmentId)!.push({ id: emp.id, name: emp.name });
    }
    return grouped;
  }, [uniqueEmployees]);

  const filteredDepartments = useMemo(() => {
    if (!departments) return [];
    const deptIdsWithShifts = new Set(uniqueEmployees.map(e => e.departmentId));
    return departments.filter(d => deptIdsWithShifts.has(d.id));
  }, [departments, uniqueEmployees]);

  // Group shifts by shift row (unique time slot)
  type ShiftRowInfo = {
    id: string;
    start: string;
    end: string;
    label: string | null;
    department: string;
    departmentId: string;
    staffRequired: number;
    staffRequiredByDay: Record<string, number> | null;
    roles: string[];
    employees: Map<string, { id: string; name: string; dates: string[] }>;
  };

  const shiftRowsGrouped = useMemo(() => {
    const grouped = new Map<string, ShiftRowInfo>();
    if (!shifts) return grouped;
    
    for (const shift of shifts) {
      if (!grouped.has(shift.shiftRowId)) {
        grouped.set(shift.shiftRowId, {
          id: shift.shiftRowId,
          start: shift.start,
          end: shift.end,
          label: shift.label,
          department: shift.department,
          departmentId: shift.departmentId,
          staffRequired: shift.staffRequired,
          staffRequiredByDay: shift.staffRequiredByDay,
          roles: shift.roles,
          employees: new Map(),
        });
      }
      const row = grouped.get(shift.shiftRowId)!;
      if (!row.employees.has(shift.employeeId)) {
        row.employees.set(shift.employeeId, {
          id: shift.employeeId,
          name: shift.employeeName,
          dates: [],
        });
      }
      row.employees.get(shift.employeeId)!.dates.push(shift.date);
    }
    return grouped;
  }, [shifts]);

  // Helper to get staff count for a specific shift row on a specific date
  const getStaffCountForDate = (shiftRowId: string, dateStr: string): number => {
    if (!shifts) return 0;
    return shifts.filter(s => s.shiftRowId === shiftRowId && s.date === dateStr).length;
  };

  // Helper to get required staff for a specific shift row on a specific date
  const getRequiredStaffForDate = (row: ShiftRowInfo, date: Date): number => {
    const dayName = format(date, "EEEE").toLowerCase().slice(0, 3); // mon, tue, etc.
    if (row.staffRequiredByDay && row.staffRequiredByDay[dayName] !== undefined) {
      return row.staffRequiredByDay[dayName];
    }
    return row.staffRequired;
  };

  const navigateDate = (direction: "prev" | "next") => {
    const offset = direction === "next" ? 1 : -1;
    switch (timelineMode) {
      case "day":
        setCurrentDate(prev => addDays(prev, offset));
        break;
      case "3day":
        setCurrentDate(prev => addDays(prev, offset * 3));
        break;
      case "week":
        setCurrentDate(prev => addDays(prev, offset * 7));
        break;
      case "month":
        setCurrentDate(prev => new Date(prev.getFullYear(), prev.getMonth() + offset, 1));
        break;
    }
  };

  const goToToday = () => {
    switch (timelineMode) {
      case "day":
        setCurrentDate(today);
        break;
      case "3day":
        setCurrentDate(today);
        break;
      case "week":
        setCurrentDate(startOfWeek(today, { weekStartsOn: 1 }));
        break;
      case "month":
        setCurrentDate(startOfMonth(today));
        break;
    }
  };

  const dateRangeLabel = useMemo(() => {
    switch (timelineMode) {
      case "day":
        return format(currentDate, "d MMMM yyyy");
      case "3day":
        return `${format(dateRange.from, "d MMM")} - ${format(dateRange.to, "d MMM yyyy")}`;
      case "week":
        return `${format(dateRange.from, "d MMM")} - ${format(dateRange.to, "d MMM yyyy")}`;
      case "month":
        return format(currentDate, "MMMM yyyy");
      default:
        return "";
    }
  }, [timelineMode, currentDate, dateRange]);

  // Sync selectedBranchId with global activeBranchId or auto-select first available branch
  useEffect(() => {
    if (activeBranchId) {
      setSelectedBranchId(activeBranchId);
    } else if (branches && branches.length > 0) {
      // Auto-select first branch if no branch is selected
      setSelectedBranchId(branches[0].id);
    }
  }, [activeBranchId, branches]);

  const columnCount = visibleDays.length;
  const gridCols = timelineMode === "month"
    ? ""
    : columnCount === 1
      ? "grid-cols-[120px_minmax(0,1fr)] sm:grid-cols-[180px_minmax(0,1fr)]"
      : columnCount === 3
        ? "grid-cols-[100px_repeat(3,minmax(0,1fr))] sm:grid-cols-[160px_repeat(3,minmax(0,1fr))]"
        : "grid-cols-[120px_repeat(7,minmax(0,1fr))] sm:grid-cols-[180px_repeat(7,minmax(0,1fr))]";
  
  const monthGridStyle = timelineMode === "month" 
    ? { gridTemplateColumns: `120px repeat(${columnCount}, 35px)` } 
    : undefined;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 flex-wrap px-2 py-1.5 border-b bg-background">
        <div className="inline-flex rounded-md border bg-muted/30 p-0.5" data-testid="scope-toggle">
          <button
            onClick={() => setScope("everyone")}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium rounded-sm transition-colors",
              scope === "everyone"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground"
            )}
            data-testid="button-scope-everyone"
          >
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">Everyone</span>
          </button>
          <button
            onClick={() => setScope("me")}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium rounded-sm transition-colors",
              scope === "me"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground"
            )}
            data-testid="button-scope-me"
          >
            <UserCircle className="h-4 w-4" />
            <span className="hidden sm:inline">My Shifts</span>
          </button>
        </div>

        <div className="h-4 w-px bg-border hidden sm:block" />

        <TimelineControls
          mode={timelineMode}
          onModeChange={(mode) => {
            setTimelineMode(mode);
            if (mode === "3day" || mode === "day") {
              setCurrentDate(today);
            } else if (mode === "week") {
              setCurrentDate(startOfWeek(today, { weekStartsOn: 1 }));
            } else if (mode === "month") {
              setCurrentDate(startOfMonth(today));
            }
          }}
          dateRangeLabel={dateRangeLabel}
          onPrev={() => navigateDate("prev")}
          onNext={() => navigateDate("next")}
          onToday={goToToday}
        />

        <div className="flex-1" />
      </div>

      <div className="flex-1 overflow-auto">
        {branchesLoading || (!selectedBranchId && branches.length > 0) ? (
          <Card className="m-2">
            <CardContent className="py-8">
              <div className="space-y-3">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            </CardContent>
          </Card>
        ) : !selectedBranchId && branches.length === 0 ? (
          <div className="p-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                No branches available. Please contact your manager.
              </AlertDescription>
            </Alert>
          </div>
        ) : isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Failed to load schedule. {error instanceof Error ? error.message : "Please try again."}
              </AlertDescription>
            </Alert>
          </div>
        ) : isLoading ? (
          <Card className="m-2">
            <CardContent className="pt-6 space-y-4">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        ) : (
          <Card className="m-2 flex flex-col max-h-[calc(100vh-200px)]">
            <CardContent className="p-0 flex flex-col flex-1 overflow-hidden">
              <div className={cn("flex-1 overflow-auto", timelineMode === "3day" && "overflow-x-hidden")}>
                <div className={cn(
                  timelineMode === "week" && "min-w-[600px]",
                  timelineMode === "month" && "min-w-[1220px]"
                )}>
                  <div className={cn("grid border-b bg-[#263238] text-white sticky top-0 z-20", gridCols)} style={monthGridStyle}>
                    <div className={cn(
                      "font-medium border-r border-white/10 truncate",
                      timelineMode === "month" ? "p-1 text-xs" : "p-2 sm:p-3 text-xs sm:text-sm"
                    )}>Employee</div>
                    {visibleDays.map((day) => (
                      <div
                        key={day.toISOString()}
                        className={cn(
                          "text-center border-r border-white/10 last:border-r-0",
                          timelineMode === "month" ? "p-0.5" : "p-2",
                          isSameDay(day, today) && "bg-primary/20",
                          isWeekend(day) && "bg-white/5"
                        )}
                      >
                        {timelineMode === "month" ? (
                          <>
                            <div className="font-medium text-[10px] leading-tight">{format(day, "EEE").charAt(0)}</div>
                            <div className="text-[10px] opacity-75">{format(day, "d")}</div>
                          </>
                        ) : (
                          <>
                            <div className="font-medium text-sm">{format(day, "EEE")}</div>
                            <div className="text-xs opacity-75">{format(day, "d")}</div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className={cn("grid bg-purple-50 dark:bg-purple-900/20 border-b", gridCols)} style={monthGridStyle}>
                    <div className="p-2 font-medium border-r flex items-center gap-1.5">
                      <CalendarDays className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                      <span className="text-xs sm:text-sm text-purple-700 dark:text-purple-300">Events</span>
                    </div>
                    {visibleDays.map((day) => {
                      const events = getEventsForDate(day);
                      return (
                        <div
                          key={day.toISOString()}
                          className={cn(
                            "p-1 border-r last:border-r-0 min-h-[36px]",
                            isSameDay(day, today) && "bg-primary/5",
                            isWeekend(day) && "bg-muted/30"
                          )}
                        >
                          {events.length > 0 && (
                            <div className="flex flex-col gap-0.5">
                              {events.slice(0, 2).map((event) => (
                                <Popover key={event.id}>
                                  <PopoverTrigger asChild>
                                    <button
                                      className="w-full text-left px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-800/40 text-purple-700 dark:text-purple-300 text-[10px] font-medium hover-elevate truncate"
                                      data-testid={`button-event-${event.id}`}
                                    >
                                      {event.title}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-72 p-3" align="start">
                                    <div className="space-y-2">
                                      <div className="font-medium text-sm">{event.title}</div>
                                      {event.isAllDay ? (
                                        <div className="text-xs text-muted-foreground">All day</div>
                                      ) : (
                                        <div className="text-xs text-muted-foreground">
                                          {format(new Date(event.startDateTime), "h:mm a")} - {format(new Date(event.endDateTime), "h:mm a")}
                                        </div>
                                      )}
                                      {event.source === "studio" && (
                                        <div className="space-y-1 pt-1 border-t">
                                          {event.partyHostName && (
                                            <div className="text-xs text-muted-foreground flex items-center gap-2">
                                              <User className="h-3 w-3 text-pink-500" />
                                              <span className="text-pink-700 dark:text-pink-400">Party Host: {event.partyHostName}</span>
                                            </div>
                                          )}
                                          {(event.numChildren || event.numAdults) && (
                                            <div className="text-xs text-muted-foreground flex items-center gap-2">
                                              <Users className="h-3 w-3" />
                                              {event.numChildren ? `${event.numChildren} children` : ""}{event.numChildren && event.numAdults ? ", " : ""}{event.numAdults ? `${event.numAdults} adults` : ""}
                                            </div>
                                          )}
                                          {event.programName && (
                                            <div className="text-xs text-muted-foreground">
                                              Program: {event.programName}
                                            </div>
                                          )}
                                          {event.parentName && (
                                            <div className="text-xs text-muted-foreground">
                                              Contact: {event.parentName}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                      {event.location && (
                                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                                          <MapPin className="h-3 w-3" />
                                          {event.location}
                                        </div>
                                      )}
                                      {event.description && (
                                        <div className="text-xs text-muted-foreground">{event.description}</div>
                                      )}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              ))}
                              {events.length > 2 && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      className="text-[10px] text-purple-600 dark:text-purple-400 hover:underline"
                                      data-testid={`button-more-events-${day.toISOString()}`}
                                    >
                                      +{events.length - 2} more
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-64 p-2" align="start">
                                    <div className="text-xs font-medium mb-2">All Events</div>
                                    <div className="space-y-1 max-h-48 overflow-y-auto">
                                      {events.map((event) => (
                                        <div
                                          key={event.id}
                                          className="px-2 py-1.5 rounded bg-purple-50 dark:bg-purple-900/30"
                                        >
                                          <div className="text-xs font-medium text-purple-700 dark:text-purple-300">{event.title}</div>
                                          {event.isAllDay ? (
                                            <div className="text-[10px] text-muted-foreground">All day</div>
                                          ) : (
                                            <div className="text-[10px] text-muted-foreground">
                                              {format(new Date(event.startDateTime), "h:mm a")} - {format(new Date(event.endDateTime), "h:mm a")}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Leave Balance Summary - only shown when viewing "My Shifts" */}
                  {scope === "me" && myTimeOffData?.employeeId && (() => {
                    const empId = myTimeOffData.employeeId;
                    const daysOffBalance = leaveBalanceMap.get(empId);
                    const allBalance = allLeaveBalanceMap.get(empId);
                    const holidayBalance = allBalance 
                      ? (allBalance.annual.canClaim ? allBalance.annual.balance : 0) + allBalance.publicHolidays.remaining
                      : 0;
                    
                    return (
                      <div className="px-3 py-2 border-b bg-muted/30 flex items-center gap-4 flex-wrap text-sm" data-testid="my-leave-balance-summary">
                        <div className="flex items-center gap-1.5">
                          <Palmtree className="h-4 w-4 text-orange-600" />
                          <span className="font-medium">My Leave Balance:</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "flex items-center gap-1",
                            daysOffBalance !== undefined && daysOffBalance < 0 && "text-red-500"
                          )}>
                            <Moon className="h-3.5 w-3.5" />
                            <span className="text-xs font-medium">Days Off:</span>
                            <span className="font-semibold">{daysOffBalance !== undefined ? (daysOffBalance >= 0 ? `+${daysOffBalance}` : daysOffBalance) : '0'}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Sun className="h-3.5 w-3.5 text-amber-500" />
                            <span className="text-xs font-medium">Holiday:</span>
                            <span className="font-semibold">{holidayBalance}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* My Shifts Timeline Day View */}
                  {scope === "me" && timelineMode === "day" && myTimeOffData?.employeeId ? (() => {
                    const myShiftsToday = shifts?.filter(s => s.date === format(currentDate, "yyyy-MM-dd")) || [];
                    const dayOff = isWeeklyDayOff(currentDate);
                    const timeOffs = getTimeOffForDate(currentDate);
                    
                    const shiftTimes = myShiftsToday.length > 0
                      ? myShiftsToday.reduce((acc, s) => {
                          const [sh] = s.start.split(":").map(Number);
                          const [eh] = s.end.split(":").map(Number);
                          return { minH: Math.min(acc.minH, sh), maxH: Math.max(acc.maxH, eh + 1) };
                        }, { minH: 24, maxH: 0 })
                      : { minH: 8, maxH: 22 };
                    const TIMELINE_START = Math.max(0, shiftTimes.minH - 1);
                    const TIMELINE_END = Math.min(24, shiftTimes.maxH + 1);
                    const TIMELINE_HOURS = Array.from({ length: TIMELINE_END - TIMELINE_START }, (_, i) => TIMELINE_START + i);
                    const TOTAL_HOURS = TIMELINE_END - TIMELINE_START;
                    
                    const timeToPercent = (time: string) => {
                      const [h, m] = time.split(":").map(Number);
                      const pct = ((h + m / 60 - TIMELINE_START) / TOTAL_HOURS) * 100;
                      return Math.max(0, Math.min(pct, 100));
                    };

                    const DUTY_COLORS = [
                      "rgba(59, 130, 246, 0.6)",
                      "rgba(168, 85, 247, 0.6)",
                      "rgba(236, 72, 153, 0.6)",
                      "rgba(34, 197, 94, 0.6)",
                      "rgba(249, 115, 22, 0.6)",
                    ];
                    
                    return (
                      <div className="p-3 space-y-3">
                        <div className="text-sm font-medium text-muted-foreground">
                          {format(currentDate, "EEEE, d MMMM yyyy")}
                        </div>
                        
                        {dayOff ? (
                          <div className="flex items-center gap-3 p-4 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                            <div className="h-10 w-10 rounded-full bg-[#E57373] flex items-center justify-center text-white">
                              <Moon className="h-5 w-5" />
                            </div>
                            <div>
                              <div className="font-medium">Day Off</div>
                              <div className="text-sm text-muted-foreground">
                                {DAY_NAMES[getDay(currentDate)]} is your regular day off
                              </div>
                            </div>
                          </div>
                        ) : timeOffs.length > 0 ? (
                          <div className="space-y-2">
                            {timeOffs.map((to) => (
                              <div key={to.id} className="flex items-center gap-3 p-4 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                                <div className={cn(
                                  "h-10 w-10 rounded-full flex items-center justify-center text-white",
                                  to.type === "SICK" ? "bg-orange-500" : to.type === "CHANGE_DAY_OFF" ? "bg-[#E57373]" : "bg-[#FFB74D]"
                                )}>
                                  <Palmtree className="h-5 w-5" />
                                </div>
                                <div>
                                  <div className="font-medium">{timeOffTypeLabels[to.type]}</div>
                                  <div className="text-sm text-muted-foreground">
                                    {format(new Date(to.startDate), "d MMM")} - {format(new Date(to.endDate), "d MMM yyyy")}
                                  </div>
                                  {to.note && <div className="text-xs text-muted-foreground mt-1">{to.note}</div>}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : myShiftsToday.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-muted-foreground">
                            <p>No shifts scheduled for today</p>
                          </div>
                        ) : (
                          <div className="w-full">
                            <div className="flex border-b pb-1 mb-2">
                              {TIMELINE_HOURS.map((hour) => (
                                <div
                                  key={hour}
                                  className="text-[10px] text-muted-foreground text-center"
                                  style={{ width: `${100 / TOTAL_HOURS}%` }}
                                >
                                  {hour.toString().padStart(2, "0")}:00
                                </div>
                              ))}
                            </div>

                            <div className="space-y-2">
                              {myShiftsToday.map((shift, shiftIdx) => {
                                const shiftLeftPct = timeToPercent(shift.start);
                                const shiftRightPct = timeToPercent(shift.end);
                                const shiftWidthPct = Math.max(shiftRightPct - shiftLeftPct, 5);
                                const shiftColor = getShiftColor(shift);
                                const onShiftNow = isCurrentlyOnShift(shift.date, shift.start, shift.end);
                                
                                let breakIndicator = null;
                                if (shift.breakStart && shift.breakEnd) {
                                  const breakLeftPct = timeToPercent(shift.breakStart) - shiftLeftPct;
                                  const breakRightPct = timeToPercent(shift.breakEnd) - shiftLeftPct;
                                  const breakWidthPct = Math.max(breakRightPct - breakLeftPct, 0.5);
                                  const breakLeftRel = (breakLeftPct / shiftWidthPct) * 100;
                                  const breakWidthRel = (breakWidthPct / shiftWidthPct) * 100;
                                  breakIndicator = (
                                    <div
                                      className="absolute top-0 bottom-0"
                                      style={{
                                        left: `${breakLeftRel}%`,
                                        width: `${breakWidthRel}%`,
                                        backgroundColor: shift.breakHasConflict ? "rgba(245, 158, 11, 0.85)" : "rgba(0, 0, 0, 0.35)",
                                        backgroundImage: "repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.35) 3px, rgba(255,255,255,0.35) 5px)",
                                        borderLeft: "1.5px solid rgba(255,255,255,0.5)",
                                        borderRight: "1.5px solid rgba(255,255,255,0.5)",
                                      }}
                                    />
                                  );
                                }

                                const dutyBlockIndicators = (shift.dutyBlocks || []).map((db, idx) => {
                                  const dbLeftPct = timeToPercent(db.startTime) - shiftLeftPct;
                                  const dbRightPct = timeToPercent(db.endTime) - shiftLeftPct;
                                  const dbWidthPct = Math.max(dbRightPct - dbLeftPct, 0.5);
                                  const dbLeftRel = (dbLeftPct / shiftWidthPct) * 100;
                                  const dbWidthRel = (dbWidthPct / shiftWidthPct) * 100;
                                  return (
                                    <div
                                      key={db.id}
                                      className="absolute top-0 bottom-0"
                                      style={{
                                        left: `${dbLeftRel}%`,
                                        width: `${dbWidthRel}%`,
                                        backgroundColor: DUTY_COLORS[idx % DUTY_COLORS.length],
                                        backgroundImage: "repeating-linear-gradient(-45deg, transparent, transparent 3px, rgba(255,255,255,0.15) 3px, rgba(255,255,255,0.15) 5px)",
                                      }}
                                    />
                                  );
                                });
                                
                                return (
                                  <div key={`${shift.shiftRowId}-${shiftIdx}`} className="space-y-1.5">
                                    <div className="relative" style={{ height: 40 }}>
                                      {TIMELINE_HOURS.map((hour) => (
                                        <div
                                          key={hour}
                                          className="absolute top-0 bottom-0 border-r border-dashed border-muted/30"
                                          style={{ left: `${((hour - TIMELINE_START) / TOTAL_HOURS) * 100}%`, width: `${100 / TOTAL_HOURS}%` }}
                                        />
                                      ))}
                                      <div
                                        className={cn(
                                          "absolute top-1 bottom-1 rounded-sm text-white text-xs font-medium flex items-center justify-center overflow-hidden",
                                          onShiftNow && "ring-2 ring-green-500 ring-offset-1",
                                          shiftColor
                                        )}
                                        style={{ left: `${shiftLeftPct}%`, width: `${shiftWidthPct}%` }}
                                        data-testid={`my-timeline-shift-${shiftIdx}`}
                                      >
                                        <span className="truncate px-1 relative z-10">
                                          {shift.start.slice(0,5)} – {shift.end.slice(0,5)}
                                          {shift.shiftGroupName && ` · ${shift.shiftGroupName}`}
                                        </span>
                                        {dutyBlockIndicators}
                                        {breakIndicator}
                                      </div>
                                    </div>
                                      
                                    <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-2.5" data-testid={`my-shift-info-${shiftIdx}`}>
                                      <div className="flex items-center gap-2.5 flex-wrap">
                                        <div className={cn("inline-block px-3 py-1 rounded text-sm font-semibold text-white", shiftColor)}>
                                          {shift.start.slice(0,5)} – {shift.end.slice(0,5)}
                                        </div>
                                        {onShiftNow && (
                                          <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400 text-xs font-semibold">Currently on shift</Badge>
                                        )}
                                      </div>
                                      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                                        {shift.shiftGroupName && (
                                          <>
                                            <span className="text-muted-foreground">Group</span>
                                            <span className="font-semibold">{shift.shiftGroupName}</span>
                                          </>
                                        )}
                                        {shift.resolvedRoleName && shift.roleSource !== "shift_group" && (
                                          <>
                                            <span className="text-muted-foreground">Role</span>
                                            <span className="font-semibold">{shift.resolvedRoleName}</span>
                                          </>
                                        )}
                                        {shift.label && (
                                          <>
                                            <span className="text-muted-foreground">Shift</span>
                                            <span className="font-semibold">{shift.label}</span>
                                          </>
                                        )}
                                        <span className="text-muted-foreground">Department</span>
                                        <span className="font-semibold">{shift.department}</span>
                                        {shift.isBorrowed && shift.branchName && (
                                          <>
                                            <span className="text-muted-foreground">Branch</span>
                                            <span>
                                              <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 text-xs font-semibold">
                                                @ {shift.branchName}
                                              </Badge>
                                            </span>
                                          </>
                                        )}
                                      </div>
                                      {shift.breakStart && shift.breakEnd && (
                                        <div className={cn(
                                          "text-sm flex items-center gap-2 pt-2 border-t",
                                          shift.breakHasConflict ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                                        )}>
                                          <Coffee className="h-4 w-4" />
                                          <span className="font-medium">Break: {shift.breakStart.slice(0,5)} – {shift.breakEnd.slice(0,5)}</span>
                                        </div>
                                      )}
                                      {shift.dutyBlocks && shift.dutyBlocks.length > 0 && (
                                        <div className="text-sm space-y-1.5 pt-2 border-t">
                                          <div className="flex items-center gap-1.5 text-muted-foreground font-semibold">
                                            <ListChecks className="h-4 w-4" />
                                            <span>Duty Blocks</span>
                                          </div>
                                          {shift.dutyBlocks.map((db, idx) => (
                                            <div key={db.id} className="flex items-center gap-2 pl-1">
                                              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: DUTY_COLORS[idx % DUTY_COLORS.length] }} />
                                              <span className="font-semibold">{db.dutyName || "Duty"}</span>
                                              <span className="text-muted-foreground">{db.startTime.slice(0,5)} – {db.endTime.slice(0,5)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  );
                                })}
                              </div>
                            </div>
                        )}
                      </div>
                    );
                  })() : scope === "me" && timelineMode !== "day" && myTimeOffData?.employeeId ? (() => {
                    const shiftsByDate = new Map<string, RotaShift[]>();
                    for (const shift of shifts || []) {
                      if (shift.employeeId !== myTimeOffData.employeeId) continue;
                      const existing = shiftsByDate.get(shift.date) || [];
                      existing.push(shift);
                      shiftsByDate.set(shift.date, existing);
                    }

                    return (
                      <div className="p-3 space-y-3">
                        {visibleDays.map((day) => {
                          const dateStr = format(day, "yyyy-MM-dd");
                          const dayShifts = shiftsByDate.get(dateStr) || [];
                          const dayOff = myTimeOffData.weeklyOffDays?.includes(getDay(day));
                          const timeOffs = getTimeOffForDate(day);

                          return (
                            <div key={dateStr} className="rounded-md border bg-card p-3 space-y-2">
                              <div className="text-sm font-medium text-muted-foreground">
                                {format(day, "EEEE, d MMMM yyyy")}
                              </div>

                              {dayShifts.length > 0 ? (
                                <div className="space-y-2">
                                  {dayShifts.map((shift, idx) => {
                                    const shiftColor = getShiftColor(shift);
                                    const onShiftNow = isCurrentlyOnShift(shift.date, shift.start, shift.end);
                                    return (
                                      <div key={`${shift.assignmentId || shift.shiftRowId}-${idx}`} className="rounded-md border bg-muted/30 px-4 py-3 space-y-2.5" data-testid={`my-shift-info-${dateStr}-${idx}`}>
                                        <div className="flex items-center gap-2.5 flex-wrap">
                                          <div className={cn("inline-block px-3 py-1 rounded text-sm font-semibold text-white", shiftColor)}>
                                            {shift.start.slice(0,5)} – {shift.end.slice(0,5)}
                                          </div>
                                          {onShiftNow && (
                                            <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400 text-xs font-semibold">Currently on shift</Badge>
                                          )}
                                        </div>
                                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                                          {shift.shiftGroupName && (
                                            <>
                                              <span className="text-muted-foreground">Group</span>
                                              <span className="font-semibold">{shift.shiftGroupName}</span>
                                            </>
                                          )}
                                          {shift.resolvedRoleName && shift.roleSource !== "shift_group" && (
                                            <>
                                              <span className="text-muted-foreground">Role</span>
                                              <span className="font-semibold">{shift.resolvedRoleName}</span>
                                            </>
                                          )}
                                          {shift.label && (
                                            <>
                                              <span className="text-muted-foreground">Shift</span>
                                              <span className="font-semibold">{shift.label}</span>
                                            </>
                                          )}
                                          <span className="text-muted-foreground">Department</span>
                                          <span className="font-semibold">{shift.department}</span>
                                          {shift.branchName && (
                                            <>
                                              <span className="text-muted-foreground">Branch</span>
                                              <span className="font-semibold">{shift.branchName}</span>
                                            </>
                                          )}
                                        </div>
                                        {shift.breakStart && shift.breakEnd && (
                                          <div className={cn(
                                            "text-sm flex items-center gap-2 pt-2 border-t",
                                            shift.breakHasConflict ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                                          )}>
                                            <Coffee className="h-4 w-4" />
                                            <span className="font-medium">Break: {shift.breakStart.slice(0,5)} – {shift.breakEnd.slice(0,5)}</span>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : timeOffs.length > 0 ? (
                                <div className="text-sm text-muted-foreground">{timeOffs.map((to) => timeOffTypeLabels[to.type]).join(", ")}</div>
                              ) : dayOff ? (
                                <div className="text-sm text-muted-foreground">Day Off</div>
                              ) : (
                                <div className="text-sm text-muted-foreground">No shifts scheduled</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })() : scope === "me" && !myTimeOffData?.employeeId ? (
                    <div className="p-8 text-center">
                      <UserCircle className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                      <p className="text-muted-foreground font-medium mb-2">No employee record linked</p>
                      <p className="text-sm text-muted-foreground">Your account is not linked to an employee record. Please contact your manager to set up your employee profile.</p>
                    </div>
                  ) : departments && departments.length > 0 ? (
                    <>
                      {/* Sort departments by displayOrder for consistent ordering */}
                      {[...departments].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)).map((dept) => {
                        // HOME DEPARTMENT ONLY: Show employees ONLY under their home department (primaryDepartmentId)
                        // Borrowed shifts from other departments will show in their home department row with a badge
                        // Filter: status must be 'active' (signed contract)
                        // Show all active employees for advance scheduling - cells before start date will be visually indicated
                        let homeDeptEmployees = allEmployees?.filter(e => 
                          e.branchId === selectedBranchId && 
                          e.primaryDepartmentId === dept.id &&
                          e.status === "active"
                        ).map(e => ({ id: e.id, name: e.nickname || e.fullName, startDate: e.startDate })) || [];
                        
                        // Sort employees alphabetically by name for consistent ordering
                        homeDeptEmployees.sort((a, b) => a.name.localeCompare(b.name));
                        
                        // For "My Shifts" scope, filter to only show current user's employee record
                        if (scope === "me" && myTimeOffData?.employeeId) {
                          homeDeptEmployees = homeDeptEmployees.filter(emp => emp.id === myTimeOffData.employeeId);
                        }
                        
                        const hasEmployees = homeDeptEmployees.length > 0;
                        
                        // In "My Shifts" mode, skip departments where the user is not present
                        if (scope === "me" && !hasEmployees) {
                          return null;
                        }
                          
                        return (
                          <div key={dept.id} className="border-b last:border-b-0">
                            {/* Department Header */}
                            <div className={cn("grid bg-muted/50", gridCols)} style={monthGridStyle}>
                              <div className="p-2 font-semibold border-r text-sm">
                                {dept.name}
                              </div>
                              {visibleDays.map((day) => (
                                <div
                                  key={day.toISOString()}
                                  className={cn(
                                    "p-1 border-r last:border-r-0",
                                    isSameDay(day, today) && "bg-primary/5",
                                    isWeekend(day) && "bg-muted/30"
                                  )}
                                />
                              ))}
                            </div>

                              {/* Employee rows under this department */}
                              {homeDeptEmployees.length > 0 ? (
                                homeDeptEmployees.map((emp) => {
                                  const initials = emp.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
                                  
                                  // Get all shifts for this employee across all days (ALL departments)
                                  const empShiftsByDate = shiftsGroupedByEmployee.get(emp.id) || new Map();
                                  
                                  return (
                                    <div key={emp.id} className={cn("grid border-t", gridCols)} style={monthGridStyle}>
                                      <div className="py-1.5 px-2 border-r flex items-center gap-2">
                                        <Avatar className="h-6 w-6 bg-primary shrink-0">
                                          <AvatarFallback className="text-[10px] text-white bg-primary">{initials}</AvatarFallback>
                                        </Avatar>
                                        <div className="min-w-0 flex-1">
                                          <span className="text-xs font-medium truncate block">{emp.name}</span>
                                        </div>
                                      </div>
                                      {visibleDays.map((day) => {
                                        const dateStr = format(day, "yyyy-MM-dd");
                                        // Check if employee has started by this date
                                        const empStartDate = emp.startDate ? emp.startDate.split("T")[0] : null;
                                        const hasNotStarted = empStartDate && dateStr < empStartDate;
                                        
                                        // Show ALL shifts for this employee (borrowed shifts already included in rota response)
                                        const dayShifts = empShiftsByDate.get(dateStr) || [];
                                        const empDayOff = isEmployeeWeeklyDayOff(emp.id, day);
                                        const empTimeOffs = getEmployeeTimeOffForDate(emp.id, day);
                                        
                                        // Determine what to show
                                        const hasShift = dayShifts.length > 0;
                                        const hasTimeOff = empTimeOffs.length > 0;
                                        
                                        return (
                                          <div
                                            key={day.toISOString()}
                                            className={cn(
                                              "p-0.5 border-r last:border-r-0 min-h-[40px] flex flex-col gap-0.5 items-center justify-center",
                                              isSameDay(day, today) && "bg-primary/5",
                                              isWeekend(day) && "bg-muted/30"
                                            )}
                                          >
                                            {hasShift ? (
                                              // Multiple shifts: show compact pill with popover
                                              dayShifts.length > 1 ? (() => {
                                                const hasCrossBranchShift = dayShifts.some(s => s.branchId && s.branchId !== selectedBranchId);
                                                const hasBorrowedShift = dayShifts.some(s => s.departmentId !== dept.id) || hasCrossBranchShift;
                                                return (
                                                  <Popover>
                                                    <PopoverTrigger asChild>
                                                      <button
                                                        className={cn(
                                                          "w-full px-1 py-1 rounded text-[11px] font-medium text-center text-white cursor-pointer hover-elevate min-h-[36px] flex flex-col items-center justify-center bg-violet-600 relative",
                                                          hasCrossBranchShift && "ring-2 ring-yellow-400 ring-offset-1"
                                                        )}
                                                        data-testid={`multi-shift-${emp.id}-${dateStr}`}
                                                      >
                                                        <div>{dayShifts.length} shifts</div>
                                                        {hasCrossBranchShift && timelineMode !== "month" && (
                                                          <div className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-yellow-950 text-[7px] px-1 py-0.5 rounded font-bold shadow-sm z-10">
                                                            B
                                                          </div>
                                                        )}
                                                        {hasBorrowedShift && !hasCrossBranchShift && timelineMode !== "month" && (
                                                          <div className="absolute -top-1 -right-1 bg-white text-violet-600 text-[8px] px-1 rounded font-bold border border-violet-600">
                                                            @
                                                          </div>
                                                        )}
                                                      </button>
                                                    </PopoverTrigger>
                                                    <PopoverContent className="w-64 p-3" align="start">
                                                      <div className="space-y-2">
                                                        <div className="font-medium text-sm">{emp.name}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                          {format(day, "EEEE, MMMM d, yyyy")}
                                                        </div>
                                                        <div className="space-y-1.5">
                                                          {dayShifts.map((shift, idx) => {
                                                            const isCrossBranch = shift.branchId && shift.branchId !== selectedBranchId;
                                                            const isBorrowed = shift.departmentId !== dept.id || isCrossBranch;
                                                            const shiftColor = getShiftColor(shift);
                                                            return (
                                                              <div key={idx} className="space-y-0.5">
                                                                <div className="flex items-center gap-2 flex-wrap">
                                                                  <div className={cn("px-2 py-1 rounded text-xs font-medium text-white", shiftColor)}>
                                                                    {shift.start.slice(0,5)} – {shift.end.slice(0,5)}
                                                                  </div>
                                                                  <div className="text-xs">
                                                                    {shift.shiftGroupName && (
                                                                      <span className="text-muted-foreground font-medium">{shift.shiftGroupName}</span>
                                                                    )}
                                                                    {shift.shiftGroupName && (shift.roles?.length > 0 || shift.label) && <span className="text-muted-foreground mx-1">·</span>}
                                                                    {shift.roles && shift.roles.length > 0 && shift.roleSource === "shift_group" && (
                                                                      <span className="text-muted-foreground font-medium">{shift.roles.join(", ")}</span>
                                                                    )}
                                                                    {!shift.shiftGroupName && shift.resolvedRoleName && shift.roleSource !== "shift_group" && (
                                                                      <span className="text-muted-foreground font-medium">{shift.resolvedRoleName}</span>
                                                                    )}
                                                                    {(shift.resolvedRoleName || shift.shiftGroupName || (shift.roles?.length > 0)) && shift.label && <span className="text-muted-foreground mx-1">·</span>}
                                                                    {shift.label && <span>{shift.label}</span>}
                                                                    {isCrossBranch ? (
                                                                      <span className="ml-1 bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 px-1.5 py-0.5 rounded font-medium">
                                                                        @ {shift.branchName}
                                                                      </span>
                                                                    ) : isBorrowed && (
                                                                      <span className="ml-1 text-violet-600 dark:text-violet-400 font-medium">
                                                                        (borrowed from {shift.department})
                                                                      </span>
                                                                    )}
                                                                  </div>
                                                                </div>
                                                                {shift.breakStart && shift.breakEnd && (
                                                                  <div className={cn(
                                                                    "text-[10px] flex items-center gap-1 pl-1",
                                                                    shift.breakHasConflict ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                                                                  )}>
                                                                    <Coffee className="h-2.5 w-2.5" />
                                                                    <span>Lunch: {shift.breakStart.slice(0, 5)} - {shift.breakEnd.slice(0, 5)}</span>
                                                                  </div>
                                                                )}
                                                                {shift.dutyBlocks && shift.dutyBlocks.length > 0 && (
                                                                  <div className="space-y-0.5 pl-1">
                                                                    {shift.dutyBlocks.map((db: any) => (
                                                                      <div key={db.id} className="text-[10px] flex items-center gap-1 text-muted-foreground">
                                                                        <ListChecks className="h-2.5 w-2.5 text-indigo-500" />
                                                                        <span>{db.dutyName || "Duty"}: {db.startTime.slice(0, 5)} - {db.endTime.slice(0, 5)}</span>
                                                                      </div>
                                                                    ))}
                                                                  </div>
                                                                )}
                                                              </div>
                                                            );
                                                          })}
                                                        </div>
                                                      </div>
                                                    </PopoverContent>
                                                  </Popover>
                                                );
                                              })() : (
                                                // Single shift: show with borrowed badge if from different department
                                                dayShifts.map((shift, idx) => {
                                                  const [startH, startM] = shift.start.split(':');
                                                  const [endH, endM] = shift.end.split(':');
                                                  const sH = parseInt(startH, 10);
                                                  const eH = parseInt(endH, 10);
                                                  // Show HH:mm when minutes are not 00, otherwise just the hour
                                                  const startStr = startM === '00' ? String(sH) : `${sH}:${startM}`;
                                                  const endStr = endM === '00' ? String(eH) : `${eH}:${endM}`;
                                                  const timeLabel = timelineMode === "month" ? startStr : `${startStr}–${endStr}`;
                                                  const shiftColor = getShiftColor(shift);
                                                  const onShiftNow = isCurrentlyOnShift(dateStr, shift.start, shift.end);
                                                  const isCrossBranch = shift.branchId && shift.branchId !== selectedBranchId;
                                                  const isBorrowed = shift.departmentId !== dept.id || isCrossBranch;
                                                  
                                                  return (
                                                    <Popover key={`${shift.shiftRowId}-${idx}`}>
                                                      <PopoverTrigger asChild>
                                                        <button
                                                          className={cn(
                                                            "w-full px-1 py-1 rounded text-[11px] font-medium text-center text-white cursor-pointer hover-elevate min-h-[36px] flex flex-col items-center justify-center relative",
                                                            onShiftNow && "ring-2 ring-green-500 ring-offset-1",
                                                            isCrossBranch ? "ring-2 ring-yellow-400 ring-offset-1" : "",
                                                            shiftColor
                                                          )}
                                                          data-testid={`shift-${emp.id}-${dateStr}-${idx}`}
                                                        >
                                                          <div>{timeLabel}</div>
                                                          {shift.resolvedRoleName && timelineMode !== "month" && (
                                                            <div className="text-[9px] opacity-80 truncate max-w-full">{shift.resolvedRoleName}</div>
                                                          )}
                                                          {shift.label && timelineMode !== "month" && (
                                                            <div className="text-[9px] opacity-90">{shift.label}</div>
                                                          )}
                                                          {timelineMode === "day" && shift.breakStart && shift.breakEnd && (
                                                            <div className="text-[9px] opacity-90 flex items-center gap-0.5 mt-0.5">
                                                              <Coffee className="h-2.5 w-2.5" />
                                                              <span>Lunch {shift.breakStart.slice(0,5)}-{shift.breakEnd.slice(0,5)}</span>
                                                            </div>
                                                          )}
                                                          {timelineMode === "day" && shift.dutyBlocks && shift.dutyBlocks.length > 0 && (
                                                            <div className="mt-0.5 space-y-0.5">
                                                              {shift.dutyBlocks.map((db: any) => (
                                                                <div key={db.id} className="text-[9px] opacity-90 flex items-center gap-0.5">
                                                                  <ListChecks className="h-2.5 w-2.5" />
                                                                  <span>{db.dutyName || "Duty"} {db.startTime.slice(0,5)}-{db.endTime.slice(0,5)}</span>
                                                                </div>
                                                              ))}
                                                            </div>
                                                          )}
                                                          {isCrossBranch && timelineMode !== "month" && (
                                                            <div className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-yellow-950 text-[7px] px-1 py-0.5 rounded font-bold shadow-sm z-10">
                                                              @ {shift.branchName?.split(' ')[0]}
                                                            </div>
                                                          )}
                                                          {isBorrowed && !isCrossBranch && timelineMode !== "month" && (
                                                            <div className="absolute -top-1 -right-1 bg-violet-600 text-white text-[8px] px-1 rounded font-bold">
                                                              @
                                                            </div>
                                                          )}
                                                        </button>
                                                      </PopoverTrigger>
                                                      <PopoverContent className="w-56 p-3" align="start">
                                                        <div className="space-y-2">
                                                          <div className="font-medium text-sm">{emp.name}</div>
                                                          <div className="text-xs text-muted-foreground">
                                                            {format(day, "EEEE, MMMM d, yyyy")}
                                                          </div>
                                                          <div className={cn("inline-block px-2 py-1 rounded text-xs font-medium text-white", shiftColor)}>
                                                            {shift.start.slice(0,5)} – {shift.end.slice(0,5)}
                                                          </div>
                                                          {shift.shiftGroupName && (
                                                            <div className="text-xs">
                                                              <span className="text-muted-foreground">Group: </span>
                                                              {shift.shiftGroupName}
                                                            </div>
                                                          )}
                                                          {shift.resolvedRoleName && shift.roleSource !== "shift_group" && (
                                                            <div className="text-xs">
                                                              <span className="text-muted-foreground">Role: </span>
                                                              {shift.resolvedRoleName}
                                                            </div>
                                                          )}
                                                          {!shift.resolvedRoleName || shift.roleSource === "shift_group" ? (
                                                            shift.roles && shift.roles.length > 0 ? (
                                                              <div className="text-xs">
                                                                <span className="text-muted-foreground">Role: </span>
                                                                {shift.roles.join(", ")}
                                                              </div>
                                                            ) : null
                                                          ) : null}
                                                          {shift.label && (
                                                            <div className="text-xs">
                                                              <span className="text-muted-foreground">Shift: </span>
                                                              {shift.label}
                                                            </div>
                                                          )}
                                                          <div className="text-xs">
                                                            <span className="text-muted-foreground">Department: </span>
                                                            {shift.department}
                                                            {isBorrowed && !isCrossBranch && (
                                                              <span className="ml-1 text-violet-600 dark:text-violet-400 font-medium">(borrowed)</span>
                                                            )}
                                                          </div>
                                                          {isCrossBranch && (
                                                            <div className="text-xs flex items-center gap-1.5">
                                                              <span className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 px-1.5 py-0.5 rounded font-medium">
                                                                @ {shift.branchName}
                                                              </span>
                                                              <span className="text-muted-foreground">(borrowed)</span>
                                                            </div>
                                                          )}
                                                          {shift.breakStart && shift.breakEnd && (
                                                            <div className={cn(
                                                              "text-xs flex items-center gap-1",
                                                              shift.breakHasConflict ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                                                            )}>
                                                              <Coffee className="h-3 w-3" />
                                                              <span>Lunch: {shift.breakStart.slice(0, 5)} - {shift.breakEnd.slice(0, 5)}</span>
                                                            </div>
                                                          )}
                                                          {shift.dutyBlocks && shift.dutyBlocks.length > 0 && (
                                                            <div className="text-xs space-y-1 pt-1 border-t">
                                                              <div className="flex items-center gap-1 text-muted-foreground font-medium">
                                                                <ListChecks className="h-3.5 w-3.5 text-indigo-500" />
                                                                <span>Duty Blocks</span>
                                                              </div>
                                                              {shift.dutyBlocks.map((db: any) => (
                                                                <div key={db.id} className="flex items-center gap-1.5 pl-1 text-muted-foreground">
                                                                  <div className="w-2 h-2 rounded-full shrink-0 bg-indigo-500" />
                                                                  <span className="font-medium">{db.dutyName || "Duty"}</span>
                                                                  <span>{db.startTime.slice(0, 5)} - {db.endTime.slice(0, 5)}</span>
                                                                </div>
                                                              ))}
                                                            </div>
                                                          )}
                                                          {onShiftNow && (
                                                            <div className="text-xs text-green-600 dark:text-green-400 font-medium">
                                                              Currently on shift
                                                            </div>
                                                          )}
                                                        </div>
                                                      </PopoverContent>
                                                    </Popover>
                                                  );
                                                })
                                              )
                                            ) : empDayOff ? (
                                              // Show Day Off badge
                                              <Popover>
                                                <PopoverTrigger asChild>
                                                  <button
                                                    className="w-full text-center px-1 py-1 rounded bg-[#E57373] text-white text-[11px] font-medium hover-elevate min-h-[36px] flex flex-col items-center justify-center whitespace-nowrap"
                                                    data-testid={`dayoff-${emp.id}-${dateStr}`}
                                                  >
                                                    <div>Off</div>
                                                  </button>
                                                </PopoverTrigger>
                                                <PopoverContent className="w-48 p-3" align="start">
                                                  <div className="space-y-1">
                                                    <div className="font-medium text-sm">Weekly Day Off</div>
                                                    <div className="text-xs text-muted-foreground">
                                                      {DAY_NAMES[getDay(day)]} is {emp.name}'s regular day off
                                                    </div>
                                                  </div>
                                                </PopoverContent>
                                              </Popover>
                                            ) : hasTimeOff ? (
                                              // Show Day Off or Leave badge based on type
                                              empTimeOffs.map((timeOff) => {
                                                const isDayOffType = timeOff.type === "CHANGE_DAY_OFF";
                                                const isSickLeave = timeOff.type === "SICK";
                                                const displayLabel = isDayOffType ? "Off" : isSickLeave ? "Sick" : "Leave";
                                                return (
                                                  <Popover key={timeOff.id}>
                                                    <PopoverTrigger asChild>
                                                      <button
                                                        className={cn(
                                                          "w-full text-center px-1 py-1 rounded text-white text-[11px] font-medium hover-elevate min-h-[36px] flex flex-col items-center justify-center whitespace-nowrap",
                                                          isDayOffType ? "bg-[#E57373]" : isSickLeave ? "bg-orange-500" : "bg-[#FFB74D]"
                                                        )}
                                                        data-testid={`timeoff-${emp.id}-${timeOff.id}`}
                                                      >
                                                        <div>{displayLabel}</div>
                                                      </button>
                                                    </PopoverTrigger>
                                                    <PopoverContent className="w-56 p-3" align="start">
                                                      <div className="space-y-2">
                                                        <div className="font-medium text-sm">{emp.name}</div>
                                                        <div className="text-xs font-medium">{timeOffTypeLabels[timeOff.type]}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                          {format(new Date(timeOff.startDate), "d MMM")} - {format(new Date(timeOff.endDate), "d MMM yyyy")}
                                                        </div>
                                                        {timeOff.note && (
                                                          <div className="text-xs text-muted-foreground border-t pt-2">
                                                            {timeOff.note}
                                                          </div>
                                                        )}
                                                      </div>
                                                    </PopoverContent>
                                                  </Popover>
                                                );
                                              })
                                            ) : hasNotStarted ? (
                                              // Employee has not started yet - show grayed out cell
                                              <div 
                                                className="w-full h-full flex items-center justify-center bg-muted/30 text-muted-foreground/30"
                                                title="Employee has not started yet"
                                                data-testid={`not-started-${emp.id}-${dateStr}`}
                                              >
                                                <Minus className="h-3 w-3" />
                                              </div>
                                            ) : (
                                              // Empty cell with + button
                                              <button
                                                className="w-full h-full flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground/60"
                                                data-testid={`add-shift-${emp.id}-${dateStr}`}
                                              >
                                                <Plus className="h-3 w-3" />
                                              </button>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                })
                              ) : (
                                <div className={cn("grid border-t", gridCols)} style={monthGridStyle}>
                                  <div className="py-2 px-2 border-r text-xs text-muted-foreground italic col-span-full">
                                    No employees in this department
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <div className="p-8 text-center">
                        <Users className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                        <p className="text-muted-foreground font-medium">No departments found</p>
                      </div>
                    )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
