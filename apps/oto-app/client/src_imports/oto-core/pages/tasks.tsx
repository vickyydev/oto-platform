import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { 
  Clock, 
  Calendar,
  CheckCircle,
  Circle,
  Camera,
  MessageSquare,
  ChevronRight,
  Cake
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Link } from "wouter";
import { format, parseISO, isToday } from "date-fns";
import type { Task } from "@shared/schema";

type TabType = "today" | "upcoming" | "completed";

interface TaskWithCompletion extends Task {
  completion?: {
    id: string;
    completedById: string;
    completedAt: string;
  };
  completedByName?: string;
}

interface GroupedTasks {
  today: TaskWithCompletion[];
  upcoming: TaskWithCompletion[];
  completedToday: TaskWithCompletion[];
}

function TaskCard({ task, isCompleted = false }: { task: TaskWithCompletion; isCompleted?: boolean }) {
  const taskDate = task.dueDate ? parseISO(task.dueDate) : new Date();
  const taskIsToday = isToday(taskDate);
  
  return (
    <Link href={`/tasks/${task.id}`}>
      <Card 
        className={`hover-elevate active-elevate-2 cursor-pointer overflow-visible ${isCompleted ? "opacity-60" : ""}`}
        data-testid={`card-task-${task.id}`}
      >
        <CardContent className="p-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 flex items-center justify-center shrink-0">
              {isCompleted ? (
                <CheckCircle className="h-5 w-5 text-green-600" />
              ) : (
                <Circle className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className={`font-medium text-sm ${isCompleted ? "line-through" : ""}`}>{task.title}</h4>
                {task.eventId && (
                  <Badge variant="secondary" className="text-xs bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300">
                    <Cake className="h-2.5 w-2.5 mr-0.5" />
                    Event
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                {!taskIsToday && (
                  <>
                    <Calendar className="h-3 w-3" />
                    <span>{format(taskDate, "MMM d")}</span>
                  </>
                )}
                <Clock className="h-3 w-3" />
                <span>{task.dueTime}</span>
                {task.requiresPhotoEvidence && (
                  <Badge variant="outline" className="text-xs">
                    <Camera className="h-2.5 w-2.5 mr-0.5" />
                    Photo
                  </Badge>
                )}
                {task.requiresResponses && (
                  <Badge variant="outline" className="text-xs">
                    <MessageSquare className="h-2.5 w-2.5 mr-0.5" />
                    Q&A
                  </Badge>
                )}
              </div>
              {isCompleted && task.completedByName && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  by {task.completedByName}
                </p>
              )}
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function TasksPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<TabType>("today");

  const { data: groupedTasks, isLoading } = useQuery<GroupedTasks>({
    queryKey: ["/api/tasks/grouped"],
    enabled: !!user,
  });

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const todayTasks = groupedTasks?.today?.filter(t => !t.completion) || [];
  const upcomingTasks = groupedTasks?.upcoming?.filter(t => !t.completion) || [];
  const completedTodayTasks = groupedTasks?.completedToday || [];

  const tabCounts = {
    today: todayTasks.length,
    upcoming: upcomingTasks.length,
    completed: completedTodayTasks.length,
  };

  const currentTasks = activeTab === "today" 
    ? todayTasks 
    : activeTab === "upcoming" 
    ? upcomingTasks 
    : completedTodayTasks;

  return (
    <AppLayout>
      <div className="p-4 max-w-2xl mx-auto">
        <div className="mb-4">
          <h1 className="text-2xl font-bold mb-1">Tasks</h1>
          <p className="text-sm text-muted-foreground">Manage your daily tasks</p>
        </div>

        <div className="flex gap-2 mb-4">
          <Button
            variant={activeTab === "today" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("today")}
            className="flex-1"
            data-testid="button-tab-today"
          >
            Today
            {tabCounts.today > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">{tabCounts.today}</Badge>
            )}
          </Button>
          <Button
            variant={activeTab === "upcoming" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("upcoming")}
            className="flex-1"
            data-testid="button-tab-upcoming"
          >
            Upcoming
            {tabCounts.upcoming > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">{tabCounts.upcoming}</Badge>
            )}
          </Button>
          <Button
            variant={activeTab === "completed" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("completed")}
            className="flex-1"
            data-testid="button-tab-completed"
          >
            Completed
            {tabCounts.completed > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">{tabCounts.completed}</Badge>
            )}
          </Button>
        </div>

        {currentTasks.length === 0 ? (
          <Card className="p-6">
            <p className="text-sm text-muted-foreground text-center">
              {activeTab === "today" && "No pending tasks for today"}
              {activeTab === "upcoming" && "No upcoming tasks"}
              {activeTab === "completed" && "No completed tasks today"}
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {currentTasks.map((task) => (
              <TaskCard 
                key={task.id} 
                task={task} 
                isCompleted={activeTab === "completed"} 
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
