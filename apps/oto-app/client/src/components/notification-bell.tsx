import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bell,
  CheckCheck,
  MessageSquare,
  UserPlus,
  RefreshCw,
  CircleCheck,
  AlertTriangle,
  Paperclip,
  ListChecks,
  AtSign,
  BellOff,
  ArrowRight,
  Check,
  CalendarClock,
  Flag,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  referenceType: string | null;
  referenceId: string | null;
  actorName: string | null;
  isRead: boolean;
  createdAt: string;
}

const notificationMeta: Record<string, { icon: typeof Bell; label: string; color: string }> = {
  task_comment: { icon: MessageSquare, label: "Comment", color: "text-blue-500 dark:text-blue-400" },
  task_assigned: { icon: UserPlus, label: "Assigned", color: "text-violet-500 dark:text-violet-400" },
  task_status_changed: { icon: RefreshCw, label: "Status", color: "text-amber-500 dark:text-amber-400" },
  task_completed: { icon: CircleCheck, label: "Completed", color: "text-emerald-500 dark:text-emerald-400" },
  task_escalated: { icon: AlertTriangle, label: "Escalated", color: "text-red-500 dark:text-red-400" },
  task_attachment: { icon: Paperclip, label: "Attachment", color: "text-cyan-500 dark:text-cyan-400" },
  task_checklist_update: { icon: ListChecks, label: "Checklist", color: "text-teal-500 dark:text-teal-400" },
  task_mentioned: { icon: AtSign, label: "Mention", color: "text-pink-500 dark:text-pink-400" },
  task_due_date_changed: { icon: CalendarClock, label: "Due Date", color: "text-orange-500 dark:text-orange-400" },
  task_priority_changed: { icon: Flag, label: "Priority", color: "text-rose-500 dark:text-rose-400" },
};

function getMeta(type: string) {
  return notificationMeta[type] || { icon: Bell, label: "Notification", color: "text-muted-foreground" };
}

export function useNotificationCount() {
  const { data } = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    refetchInterval: 30000,
  });
  return data?.count || 0;
}

export function NotificationPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: notificationsList, isLoading } = useQuery<NotificationItem[]>({
    queryKey: ["/api/notifications"],
    enabled: open,
  });

  const unreadCount = useNotificationCount();

  const markReadMutation = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/notifications/mark-all-read"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });

  async function handleNotificationClick(notification: NotificationItem) {
    if (!notification.isRead) {
      try {
        await apiRequest("PATCH", `/api/notifications/${notification.id}/read`);
        queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
        queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      } catch {}
    }
    onOpenChange(false);
    if (notification.referenceType === "task" && notification.referenceId) {
      window.location.href = `/ops?taskId=${notification.referenceId}`;
    }
  }

  function handleMarkRead(e: React.MouseEvent, notification: NotificationItem) {
    e.stopPropagation();
    if (!notification.isRead) {
      markReadMutation.mutate(notification.id);
    }
  }

  const unread = notificationsList?.filter((n) => !n.isRead) || [];
  const read = notificationsList?.filter((n) => n.isRead) || [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col gap-0">
        <SheetHeader className="px-5 pr-12 pt-5 pb-3 flex-shrink-0 border-b">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <SheetTitle className="text-lg font-semibold">Notifications</SheetTitle>
              {unreadCount > 0 && (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 min-h-0 h-5">
                  {unreadCount}
                </Badge>
              )}
            </div>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                data-testid="button-mark-all-read"
              >
                <CheckCheck className="h-3.5 w-3.5 mr-1.5" />
                Mark all read
              </Button>
            )}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="p-8 flex flex-col items-center gap-3">
              <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <p className="text-sm text-muted-foreground">Loading notifications...</p>
            </div>
          ) : !notificationsList || notificationsList.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-center">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
                <BellOff className="h-7 w-7 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">All caught up</p>
              <p className="text-xs text-muted-foreground/70">No notifications to show right now</p>
            </div>
          ) : (
            <div className="py-1">
              {unread.length > 0 && (
                <div>
                  <div className="px-5 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      New
                    </span>
                  </div>
                  {unread.map((n) => (
                    <NotificationRow
                      key={n.id}
                      notification={n}
                      onClick={() => handleNotificationClick(n)}
                      onMarkRead={(e) => handleMarkRead(e, n)}
                    />
                  ))}
                </div>
              )}
              {read.length > 0 && (
                <div>
                  {unread.length > 0 && (
                    <div className="px-5 py-2 mt-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Earlier
                      </span>
                    </div>
                  )}
                  {read.map((n) => (
                    <NotificationRow
                      key={n.id}
                      notification={n}
                      onClick={() => handleNotificationClick(n)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function NotificationRow({
  notification,
  onClick,
  onMarkRead,
}: {
  notification: NotificationItem;
  onClick: () => void;
  onMarkRead?: (e: React.MouseEvent) => void;
}) {
  const meta = getMeta(notification.type);
  const Icon = meta.icon;
  const isUnread = !notification.isRead;

  return (
    <div
      className={`flex items-start gap-3 px-5 py-3.5 cursor-pointer relative hover-elevate ${
        isUnread ? "bg-primary/[0.04] dark:bg-primary/[0.08]" : ""
      }`}
      onClick={onClick}
      data-testid={`notification-item-${notification.id}`}
    >
      {isUnread && (
        <div className="absolute left-1.5 top-1/2 -translate-y-1/2">
          <div className="h-1.5 w-1.5 rounded-full bg-primary" />
        </div>
      )}

      <div className={`flex-shrink-0 mt-0.5 h-9 w-9 rounded-full flex items-center justify-center ${
        isUnread ? "bg-primary/10 dark:bg-primary/20" : "bg-muted"
      }`}>
        <Icon className={`h-4 w-4 ${isUnread ? meta.color : "text-muted-foreground"}`} />
      </div>

      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-snug ${isUnread ? "font-medium" : "text-muted-foreground"}`}>
          {notification.title}
        </p>
        <p className={`text-xs mt-0.5 leading-relaxed truncate ${isUnread ? "text-muted-foreground" : "text-muted-foreground/70"}`}>
          {notification.body}
        </p>
        <div className="flex items-center gap-2 mt-1.5">
          <span className={`text-[10px] ${isUnread ? "text-muted-foreground" : "text-muted-foreground/60"}`}>
            {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
          </span>
          {notification.referenceType === "task" && notification.referenceId && (
            <span className="text-[10px] text-primary/70 flex items-center gap-0.5">
              Open task <ArrowRight className="h-2.5 w-2.5" />
            </span>
          )}
        </div>
      </div>

      {isUnread && onMarkRead && (
        <div className="flex-shrink-0 mt-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onMarkRead}
            data-testid={`mark-read-${notification.id}`}
          >
            <Check className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      )}
    </div>
  );
}
