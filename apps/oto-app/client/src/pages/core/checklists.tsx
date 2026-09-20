import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { 
  Clock, 
  Users, 
  User, 
  Briefcase, 
  Building2,
  Play,
  Eye,
  CheckCircle,
  Circle,
  ClipboardList,
  ChevronRight,
  Calendar,
  AlertCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { Link, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format, startOfDay, subDays } from "date-fns";
import { EmptyState } from "@/components/ui/empty-state";

interface ChecklistTemplate {
  id: string;
  name: string;
  description: string | null;
  recurrence: string;
  scheduledTime: string;
  assignedEmployeeName?: string | null;
  assignedRoleName?: string | null;
  assignedDepartmentName?: string | null;
  computedStatus?: string;
  latestRunId?: string | null;
}

type DatePreset = "today" | "yesterday" | "custom";

function ChecklistCard({ 
  checklist, 
  onStart 
}: { 
  checklist: ChecklistTemplate; 
  onStart: (id: string) => void;
}) {
  const isCompleted = checklist.computedStatus === 'completed';
  // scheduledTime is now the round time for expanded checker checklists
  const dueTimeStr = checklist.scheduledTime;
  const isOverdue = !isCompleted && dueTimeStr && (() => {
    const now = new Date();
    const [hours, minutes] = dueTimeStr.split(':').map(Number);
    const dueTime = new Date();
    dueTime.setHours(hours, minutes, 0, 0);
    return now > dueTime;
  })();

  const getAssignment = () => {
    if (checklist.assignedEmployeeName) return { icon: User, label: checklist.assignedEmployeeName };
    if (checklist.assignedRoleName) return { icon: Briefcase, label: checklist.assignedRoleName };
    if (checklist.assignedDepartmentName) return { icon: Building2, label: checklist.assignedDepartmentName };
    return { icon: Users, label: "Everyone" };
  };

  const assignment = getAssignment();
  const AssignmentIcon = assignment.icon;

  return (
    <Card 
      className={`hover-elevate active-elevate-2 overflow-visible ${isCompleted ? "opacity-60" : ""} ${isOverdue ? "border-red-400/50 border" : ""}`}
      data-testid={`card-checklist-${checklist.id}`}
    >
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 flex items-center justify-center shrink-0">
            {isCompleted ? (
              <CheckCircle className="h-5 w-5 text-green-600" />
            ) : isOverdue ? (
              <AlertCircle className="h-5 w-5 text-red-500" />
            ) : (
              <Circle className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className={`font-medium text-sm ${isCompleted ? "line-through text-muted-foreground" : ""}`}>
                {checklist.name}
                {(checklist as any).roundNumber && (
                  <span className="ml-1 text-muted-foreground">
                    (Round {(checklist as any).roundNumber})
                  </span>
                )}
              </h4>
              <Badge variant="outline" className="text-xs">{checklist.recurrence}</Badge>
            </div>
            <div className="flex items-center gap-2 text-xs flex-wrap mt-1 text-muted-foreground">
              <span className={isOverdue ? "text-red-500 flex items-center gap-1" : "flex items-center gap-1"}>
                <Clock className="h-3 w-3" />
                Due by {checklist.scheduledTime || 'End of day'}
                {isOverdue && <span className="font-medium ml-1">Overdue</span>}
              </span>
              <span className="flex items-center gap-1">
                <AssignmentIcon className="h-3 w-3" />
                <span>{assignment.label}</span>
              </span>
            </div>
          </div>
          <div className="shrink-0">
            {isCompleted && checklist.latestRunId ? (
              <Link href={`/core/checklist/${checklist.latestRunId}`}>
                <Button variant="ghost" size="icon" data-testid={`btn-view-${checklist.id}`}>
                  <Eye className="h-4 w-4" />
                </Button>
              </Link>
            ) : checklist.computedStatus === 'in_progress' && checklist.latestRunId ? (
              <Link href={`/core/checklist/${checklist.latestRunId}`}>
                <Button variant="ghost" size="icon" data-testid={`btn-continue-${checklist.id}`}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <Button 
                variant="ghost" 
                size="icon"
                onClick={() => onStart(checklist.id)}
                data-testid={`btn-start-${checklist.id}`}
              >
                <Play className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CoreChecklistsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { activeBranchId } = useBranchContext();
  const [, setLocation] = useLocation();
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [customDateRange, setCustomDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({ from: undefined, to: undefined });
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const datePickerClickCount = useRef(0);
  const hasFirstSelection = useRef(false);

  const getDateRange = () => {
    const today = startOfDay(new Date());
    if (datePreset === "today") {
      return { from: format(today, "yyyy-MM-dd"), to: format(today, "yyyy-MM-dd") };
    } else if (datePreset === "yesterday") {
      const yesterday = subDays(today, 1);
      return { from: format(yesterday, "yyyy-MM-dd"), to: format(yesterday, "yyyy-MM-dd") };
    } else if (customDateRange.from && customDateRange.to) {
      return { from: format(customDateRange.from, "yyyy-MM-dd"), to: format(customDateRange.to, "yyyy-MM-dd") };
    } else if (customDateRange.from) {
      return { from: format(customDateRange.from, "yyyy-MM-dd"), to: format(customDateRange.from, "yyyy-MM-dd") };
    }
    return { from: format(today, "yyyy-MM-dd"), to: format(today, "yyyy-MM-dd") };
  };

  const dateRange = getDateRange();

  const queryParams = new URLSearchParams();
  if (activeBranchId) queryParams.append("branchId", activeBranchId);
  queryParams.append("from", dateRange.from);
  queryParams.append("to", dateRange.to);

  const { data: checklists = [], isLoading } = useQuery<ChecklistTemplate[]>({
    queryKey: ["/api/checklists/by-date", { branchId: activeBranchId, from: dateRange.from, to: dateRange.to }],
    queryFn: async () => {
      const res = await fetch(`/api/checklists/by-date?${queryParams.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch checklists");
      return res.json();
    },
    enabled: !!user,
  });

  const startChecklistMutation = async (templateId: string) => {
    try {
      const res = await apiRequest("POST", `/api/checklist-runs/start`, { templateId, branchId: activeBranchId });
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/by-date"] });
      setLocation(`/core/checklist/${data.id}`);
    } catch (error) {
      toast({
        title: "Failed to start checklist",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  if (isLoading && checklists.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Expand checker checklists into multiple entries (one per round)
  const expandedChecklists = checklists.flatMap((c: any) => {
    if (c.checklistType === 'checker' && c.checkerRounds > 1) {
      const roundTimes = [c.scheduleTime1, c.scheduleTime2, c.scheduleTime3, c.scheduleTime4, c.scheduleTime5]
        .filter(Boolean)
        .slice(0, c.checkerRounds);
      
      return roundTimes.map((roundTime: string, index: number) => ({
        ...c,
        roundNumber: index + 1,
        roundTime,
        // Override scheduledTime with round time for display and overdue calculation
        scheduledTime: roundTime,
        // Create unique key for each round
        displayId: `${c.id}-round-${index + 1}`,
      }));
    }
    return [{ ...c, displayId: c.id }];
  });

  const pendingChecklists = expandedChecklists.filter((c: any) => c.computedStatus !== "completed");
  const completedChecklists = expandedChecklists.filter((c: any) => c.computedStatus === "completed");

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">Checklists</h1>
          <p className="text-sm text-muted-foreground">Complete your assigned checklists</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-1">
          <Button
            variant={datePreset === "today" ? "default" : "outline"}
            size="sm"
            onClick={() => setDatePreset("today")}
            data-testid="btn-date-today"
          >
            Today
          </Button>
          <Button
            variant={datePreset === "yesterday" ? "default" : "outline"}
            size="sm"
            onClick={() => setDatePreset("yesterday")}
            data-testid="btn-date-yesterday"
          >
            Yesterday
          </Button>
          <Popover 
            open={isDatePickerOpen} 
            modal={true}
            onOpenChange={(open) => {
              // Only allow programmatic opening via button click
              // Block ALL automatic close attempts - we handle closing ourselves
              if (!open) {
                return; // Block all auto-close attempts
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant={datePreset === "custom" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setDatePreset("custom");
                  datePickerClickCount.current = 0;
                  hasFirstSelection.current = false;
                  setCustomDateRange({ from: undefined, to: undefined });
                  setIsDatePickerOpen(true);
                }}
                data-testid="btn-date-custom"
              >
                <Calendar className="h-4 w-4 mr-1" />
                {datePreset === "custom" && customDateRange.from
                  ? customDateRange.to
                    ? `${format(customDateRange.from, "d MMM")} - ${format(customDateRange.to, "d MMM")}`
                    : format(customDateRange.from, "d MMM")
                  : "Custom"}
              </Button>
            </PopoverTrigger>
            <PopoverContent 
              className="w-auto p-0" 
              align="start" 
              onOpenAutoFocus={(e) => e.preventDefault()}
              onInteractOutside={(e) => e.preventDefault()}
              onPointerDownOutside={(e) => e.preventDefault()}
              onFocusOutside={(e) => e.preventDefault()}
              onEscapeKeyDown={() => setIsDatePickerOpen(false)}
            >
              <CalendarComponent
                mode="range"
                selected={customDateRange}
                onSelect={(range) => {
                  // Mark that we've started selecting
                  if (!hasFirstSelection.current && range?.from) {
                    hasFirstSelection.current = true;
                  }
                  
                  datePickerClickCount.current++;
                  setCustomDateRange({ from: range?.from, to: range?.to });
                  setDatePreset("custom");
                  
                  // Close after second click (range complete or same date clicked twice)
                  if (hasFirstSelection.current && datePickerClickCount.current >= 2) {
                    if (range?.from && !range?.to) {
                      // Same date clicked - single day
                      setCustomDateRange({ from: range.from, to: range.from });
                    }
                    setTimeout(() => setIsDatePickerOpen(false), 100);
                  }
                }}
                numberOfMonths={1}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {checklists.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No checklists"
          description="There are no checklists for this date range."
        />
      ) : (
        <>
          {pendingChecklists.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-medium text-muted-foreground mb-2">
                Pending ({pendingChecklists.length})
              </h2>
              <div className="space-y-2">
                {pendingChecklists.map((checklist: any) => (
                  <ChecklistCard 
                    key={checklist.displayId} 
                    checklist={checklist} 
                    onStart={startChecklistMutation} 
                  />
                ))}
              </div>
            </div>
          )}

          {completedChecklists.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-2">
                Completed ({completedChecklists.length})
              </h2>
              <div className="space-y-2">
                {completedChecklists.map((checklist: any) => (
                  <ChecklistCard 
                    key={checklist.displayId} 
                    checklist={checklist} 
                    onStart={startChecklistMutation} 
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
