import { useQuery } from "@tanstack/react-query";
import { ActivityLog } from "@shared/schema";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { formatDistanceToNow } from "date-fns";
import { Clock, History, Loader2 } from "lucide-react";

interface ActivityPreviewTooltipProps {
  employeeId?: string;
  contractInstanceId?: string;
  children: React.ReactNode;
}

const activityTypeLabels: Record<string, string> = {
  contract_created: "Contract Created",
  contract_finalized: "Contract Finalized",
  contract_sent: "Contract Sent",
  contract_signed: "Contract Signed",
  contract_archived: "Contract Archived",
  promotion: "Promotion",
  salary_change: "Salary Change",
  incentive_change: "Incentive Change",
  employment_ended: "Employment Ended",
  probation_completed: "Probation Completed",
  warning_issued: "Warning Issued",
  policy_acknowledged: "Policy Acknowledged",
};

export function ActivityPreviewTooltip({ 
  employeeId, 
  contractInstanceId, 
  children 
}: ActivityPreviewTooltipProps) {
  const { data, isLoading } = useQuery<{ logs: ActivityLog[]; totalCount: number }>({
    queryKey: ["/api/activity-logs", { employeeId, contractInstanceId, limit: 5 }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "5");
      if (employeeId) params.set("employeeId", employeeId);
      if (contractInstanceId) params.set("contractInstanceId", contractInstanceId);
      const res = await fetch(`/api/activity-logs?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch activity logs");
      return res.json();
    },
    enabled: !!(employeeId || contractInstanceId),
    staleTime: 60000,
  });

  const logs = data?.logs || [];

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent 
        className="w-80" 
        side="right" 
        align="start"
        data-testid="tooltip-activity-preview"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <History className="h-4 w-4" />
            Recent Activity
          </div>
          
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No activity recorded yet
            </p>
          ) : (
            <div className="space-y-2">
              {logs.map((log) => (
                <div 
                  key={log.id} 
                  className="flex items-start gap-2 text-sm"
                  data-testid={`activity-item-${log.id}`}
                >
                  <div className="mt-0.5 h-2 w-2 rounded-full bg-muted-foreground/50 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">
                      {activityTypeLabels[log.activityType] || log.activityType}
                    </p>
                    {log.summaryText && (
                      <p className="text-muted-foreground text-xs truncate">
                        {log.summaryText}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground/70 flex items-center gap-1 mt-0.5">
                      <Clock className="h-3 w-3" />
                      {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
