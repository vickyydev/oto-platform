import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Wrench, CheckCircle, Clock, ArrowRight, MessageSquare } from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

export interface FixActivityEntry {
  id: string;
  type: "comment" | "status_change" | "creation";
  message: string;
  createdAt: string;
  authorUserId?: string | null;
  author?: { id: string; fullName?: string | null; email: string } | null;
  authorType?: string;
  currentUserId?: string;
}

interface FixActivityFeedProps {
  entries: FixActivityEntry[];
  createdAt?: string;
  reportTitle?: string;
  currentUserId?: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  new: "Pending",
  acknowledged: "Acknowledged",
  in_progress: "In Progress",
  scheduled: "Scheduled",
  completed: "Completed",
  done: "Done",
  closed: "Closed",
  fixed: "Fixed",
};

function isStatusChangeMessage(message: string) {
  return message.startsWith("[status_change]");
}

function parseStatusChange(message: string): { from: string; to: string; label: string } | null {
  // Format: [status_change]from:pending|to:acknowledged
  const inner = message.replace("[status_change]", "");
  const fromMatch = inner.match(/from:([^|]+)/);
  const toMatch = inner.match(/to:([^|]+)/);
  if (!fromMatch || !toMatch) return null;
  const to = toMatch[1].trim();
  return {
    from: fromMatch[1].trim(),
    to,
    label: STATUS_LABELS[to] || to,
  };
}

function ActivityRow({
  entry,
  currentUserId,
}: {
  entry: FixActivityEntry;
  currentUserId?: string;
}) {
  const isMe = entry.authorUserId && entry.authorUserId === currentUserId;
  const name = entry.author?.fullName || entry.author?.email || "System";
  const initials = name === "System" ? "SY" : name.split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase();

  if (entry.type === "creation") {
    return (
      <div className="flex gap-3">
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Wrench className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0 pb-3 border-b border-muted last:border-0">
          <p className="text-sm font-medium">Report submitted</p>
          <p className="text-xs text-muted-foreground">
            {entry.createdAt ? formatDistanceToNow(parseISO(entry.createdAt), { addSuffix: true }) : ""}
          </p>
        </div>
      </div>
    );
  }

  if (entry.type === "status_change") {
    const parsed = parseStatusChange(entry.message);
    return (
      <div className="flex gap-3">
        <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
          <ArrowRight className="w-4 h-4 text-blue-500" />
        </div>
        <div className="flex-1 min-w-0 pb-3 border-b border-muted last:border-0">
          <div className="flex items-center gap-1 flex-wrap text-sm">
            <span className="font-medium">{isMe ? "You" : name}</span>
            <span className="text-muted-foreground">changed status to</span>
            <span className="font-semibold text-foreground">{parsed?.label || "updated"}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {formatDistanceToNow(parseISO(entry.createdAt), { addSuffix: true })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <Avatar className="w-8 h-8 shrink-0">
        <AvatarFallback className="text-xs bg-muted">{initials}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0 pb-3 border-b border-muted last:border-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium">{isMe ? "You" : name}</span>
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(parseISO(entry.createdAt), { addSuffix: true })}
          </span>
        </div>
        <p className="text-sm text-foreground/80 mt-0.5">{entry.message}</p>
      </div>
    </div>
  );
}

export function FixActivityFeed({
  entries,
  createdAt,
  reportTitle,
  currentUserId,
}: FixActivityFeedProps) {
  const allEntries: FixActivityEntry[] = [
    ...(createdAt
      ? [
          {
            id: "__creation__",
            type: "creation" as const,
            message: "Report submitted",
            createdAt,
          },
        ]
      : []),
    ...entries,
  ].sort((a, b) => {
    if (a.id === "__creation__") return -1;
    if (b.id === "__creation__") return 1;
    return parseISO(a.createdAt).getTime() - parseISO(b.createdAt).getTime();
  });

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">Activity</span>
      </div>
      {allEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-2">No activity yet</p>
      ) : (
        <div className="space-y-3">
          {allEntries.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} currentUserId={currentUserId} />
          ))}
        </div>
      )}
    </div>
  );
}

export function rawCommentToActivityEntry(comment: {
  id: string;
  message: string;
  createdAt: string;
  authorUserId?: string | null;
  author?: { id: string; fullName?: string | null; email: string } | null;
  authorType?: string;
}): FixActivityEntry {
  const isStatusChange = isStatusChangeMessage(comment.message);
  return {
    id: comment.id,
    type: isStatusChange ? "status_change" : "comment",
    message: comment.message,
    createdAt: comment.createdAt,
    authorUserId: comment.authorUserId,
    author: comment.author,
    authorType: comment.authorType,
  };
}
