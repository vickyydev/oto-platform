import { useState, useMemo } from "react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, Clock, Calendar, User, Building2, Briefcase, Users, AlertCircle, Siren, MapPin } from "lucide-react";
import { format, parseISO, isToday, isBefore, startOfDay } from "date-fns";

export interface BoardTask {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  dueDate?: string | null;
  dueTime?: string | null;
  dueAt?: string | null;
  startAt?: string | null;
  startDate?: string | null;
  scheduledMode?: boolean;
  progressPercent?: number;
  statusManualOverride?: boolean;
  blockedReason?: string | null;
  completedAt?: string | null;
  archivedAt?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  requiresPhotoEvidence?: boolean;
  assignedTo?: string | null;
  assignedRoleId?: string | null;
  assignedDepartmentId?: string | null;
  assignedUserName?: string | null;
  taskLevel?: string | null;
  escalated?: boolean;
  isStagnant?: boolean;
  isOverdue?: boolean;
  isArchived?: boolean;
  lastMovementAt?: string | null;
  ownerUserId?: string | null;
}

interface TaskBoardProps {
  tasks: BoardTask[];
  isLoading?: boolean;
  onTaskClick?: (task: BoardTask) => void;
  onStatusChange?: (taskId: string, newStatus: string) => Promise<void>;
  roles?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
  groupBy?: "status" | "branch";
  branches?: { id: string; name: string }[];
  showStagnantHighlight?: boolean;
}

// Simplified 3-column status model
const STATUS_COLUMNS = [
  { id: "pending", label: "To Do", color: "bg-slate-100 dark:bg-slate-900" },
  { id: "in_progress", label: "In Progress", color: "bg-blue-50 dark:bg-blue-950" },
  { id: "completed", label: "Done", color: "bg-green-50 dark:bg-green-950" },
];

function TaskCardItem({ 
  task, 
  onTaskClick, 
  roles = [], 
  departments = [],
  showStagnantHighlight = false,
}: { 
  task: BoardTask; 
  onTaskClick?: (task: BoardTask) => void;
  roles?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
  showStagnantHighlight?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const taskDate = task.dueDate ? parseISO(task.dueDate) : task.dueAt ? parseISO(task.dueAt) : null;
  const startDate = task.startDate ? parseISO(task.startDate) : null;
  const isCompleted = task.status === "completed";
  const isBlocked = task.status === "blocked";
  const progressPercent = task.progressPercent ?? 0;
  const isMultiDay = task.scheduledMode && startDate && taskDate && task.startDate !== task.dueDate;

  const isOverdue = !isCompleted && taskDate && (() => {
    const now = new Date();
    const today = startOfDay(now);
    if (isBefore(taskDate, today)) return true;
    if (isToday(taskDate) && task.dueTime) {
      const [hours, minutes] = task.dueTime.split(':').map(Number);
      const dueDateTime = new Date();
      dueDateTime.setHours(hours, minutes, 0, 0);
      return now > dueDateTime;
    }
    return false;
  })();

  const getAssignmentInfo = () => {
    const assignments = (task as any).assignments as Array<{ assignmentType: string; label: string }> | undefined;
    if (assignments && assignments.length > 0) {
      const label = assignments.length === 1 ? assignments[0].label : assignments.map(x => x.label).join(", ");
      if (assignments.length === 1) {
        const t = assignments[0].assignmentType;
        if (t === "employee" || t === "advisor") return { icon: User, label, type: "employee" };
        if (t === "role") return { icon: Briefcase, label, type: "role" };
        if (t === "department") return { icon: Building2, label, type: "department" };
        if (t === "branch") return { icon: MapPin, label, type: "branch" };
      }
      return { icon: Users, label, type: "multiple" };
    }
    if (task.assignedTo || task.assignedUserName) {
      return { icon: User, label: task.assignedUserName || "Assigned", type: "employee" };
    }
    if (task.assignedRoleId) {
      const role = roles.find(r => r.id === task.assignedRoleId);
      return { icon: Briefcase, label: role?.name || "Role", type: "role" };
    }
    if (task.assignedDepartmentId) {
      const dept = departments.find(d => d.id === task.assignedDepartmentId);
      return { icon: Building2, label: dept?.name || "Department", type: "department" };
    }
    return { icon: Users, label: "Everyone", type: "everyone" };
  };

  const assignment = getAssignmentInfo();
  const AssignmentIcon = assignment.icon;

  // Simplified styling - signals shown as icon badges, not borders
  const hasSignals = isOverdue || task.isStagnant || task.escalated;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onTaskClick?.(task)}
      className="touch-none cursor-grab active:cursor-grabbing"
    >
      <Card 
        className={`hover-elevate overflow-visible ${isCompleted ? "opacity-60" : ""}`}
        data-testid={`board-card-task-${task.id}`}
      >
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h4 className={`font-medium text-sm line-clamp-2 ${isCompleted ? "line-through text-muted-foreground" : ""}`}>
              {task.title}
            </h4>
            {/* Signal badges - icons only */}
            {hasSignals && (
              <div className="flex items-center gap-1 shrink-0">
                {task.isStagnant && !isCompleted && (
                  <AlertTriangle className="h-4 w-4 text-amber-500" title="Stagnant - no activity for 3+ days" />
                )}
                {isOverdue && !isCompleted && (
                  <Clock className="h-4 w-4 text-red-500" title="Overdue" />
                )}
                {task.escalated && (
                  <Siren className="h-4 w-4 text-red-600" title="Escalated" />
                )}
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-1 flex-wrap">
            {!isMultiDay && progressPercent > 0 && progressPercent < 100 && (
              <Badge className="bg-blue-500 text-white text-xs">{progressPercent}%</Badge>
            )}
            {task.taskLevel && task.taskLevel !== "line" && (
              <Badge variant="secondary" className="text-xs capitalize">{task.taskLevel}</Badge>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
            {isMultiDay && startDate && taskDate ? (
              <span className={`flex items-center gap-1 ${isOverdue ? "text-red-500 font-medium" : ""}`}>
                <Calendar className="h-3 w-3" />
                {format(startDate, "d MMM")} → {format(taskDate, "d MMM")}
              </span>
            ) : taskDate ? (
              <span className={`flex items-center gap-1 ${isOverdue ? "text-red-500 font-medium" : ""}`}>
                <Calendar className="h-3 w-3" />
                {format(taskDate, "d MMM")}
                {task.dueTime && ` ${task.dueTime}`}
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <AssignmentIcon className="h-3 w-3" />
              <span className="truncate max-w-[100px]">{assignment.label}</span>
            </span>
          </div>

          {isMultiDay && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{progressPercent}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    progressPercent >= 100 ? "bg-green-500" : progressPercent > 0 ? "bg-blue-500" : "bg-muted-foreground/30"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                />
              </div>
            </div>
          )}

        </CardContent>
      </Card>
    </div>
  );
}

function StatusColumn({
  column,
  tasks,
  onTaskClick,
  roles,
  departments,
  showStagnantHighlight,
}: {
  column: { id: string; label: string; color: string };
  tasks: BoardTask[];
  onTaskClick?: (task: BoardTask) => void;
  roles?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
  showStagnantHighlight?: boolean;
}) {
  const taskIds = tasks.map(t => t.id);

  return (
    <div className={`flex flex-col min-w-[260px] sm:min-w-[280px] w-[260px] sm:w-[300px] shrink-0 rounded-lg snap-start ${column.color}`}>
      <div className="p-3 border-b sticky top-0 z-10 bg-inherit rounded-t-lg">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" className="text-xs">{tasks.length}</Badge>
        </div>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[calc(100vh-280px)] sm:max-h-[calc(100vh-240px)]">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCardItem
              key={task.id}
              task={task}
              onTaskClick={onTaskClick}
              roles={roles}
              departments={departments}
              showStagnantHighlight={showStagnantHighlight}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}

export default function TaskBoard({
  tasks,
  isLoading = false,
  onTaskClick,
  onStatusChange,
  roles = [],
  departments = [],
  groupBy = "status",
  branches = [],
  showStagnantHighlight = false,
}: TaskBoardProps) {
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 8,
      },
    }),
    useSensor(KeyboardSensor)
  );

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, BoardTask[]> = {};
    for (const col of STATUS_COLUMNS) {
      grouped[col.id] = [];
    }
    for (const task of tasks) {
      const status = task.status === "todo" ? "pending" : task.status;
      if (grouped[status]) {
        grouped[status].push(task);
      } else {
        grouped["pending"].push(task);
      }
    }
    return grouped;
  }, [tasks]);

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find(t => t.id === event.active.id);
    setActiveTask(task || null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over || !onStatusChange) return;

    const taskId = active.id as string;
    const targetColumn = STATUS_COLUMNS.find(col => 
      tasksByStatus[col.id]?.some(t => t.id === over.id) || col.id === over.id
    );
    
    if (targetColumn) {
      const currentTask = tasks.find(t => t.id === taskId);
      if (currentTask && currentTask.status !== targetColumn.id) {
        await onStatusChange(taskId, targetColumn.id);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 sm:gap-4 overflow-x-auto pb-4 px-1 -mx-1 snap-x snap-mandatory md:snap-none scroll-smooth">
        {STATUS_COLUMNS.map((column) => (
          <StatusColumn
            key={column.id}
            column={column}
            tasks={tasksByStatus[column.id] || []}
            onTaskClick={onTaskClick}
            roles={roles}
            departments={departments}
            showStagnantHighlight={showStagnantHighlight}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask ? (
          <Card className="w-[280px] shadow-lg rotate-2">
            <CardContent className="p-3">
              <h4 className="font-medium text-sm">{activeTask.title}</h4>
            </CardContent>
          </Card>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
