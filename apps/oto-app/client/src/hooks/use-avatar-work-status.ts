import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type AvatarWorkStatus = "CLOCKED_IN" | "SCHEDULED_TO_WORK" | "SCHEDULED_OFF" | "NOT_SCHEDULED";

export interface AvatarStatusResult {
  status: AvatarWorkStatus;
  color: string;
  tooltip: string;
}

export type AvatarStatusMap = Record<string, AvatarStatusResult>;

const workStatusColors: Record<AvatarWorkStatus, string> = {
  CLOCKED_IN: "bg-green-500",
  SCHEDULED_TO_WORK: "bg-blue-500",
  SCHEDULED_OFF: "bg-gray-400",
  NOT_SCHEDULED: "bg-red-500",
};

const workStatusTooltips: Record<AvatarWorkStatus, string> = {
  CLOCKED_IN: "Clocked in",
  SCHEDULED_TO_WORK: "Scheduled (not clocked in)",
  SCHEDULED_OFF: "Scheduled off",
  NOT_SCHEDULED: "Not scheduled",
};

export function getWorkStatusColor(status: AvatarWorkStatus): string {
  return workStatusColors[status] || "bg-gray-400";
}

export function getWorkStatusTooltip(status: AvatarWorkStatus): string {
  return workStatusTooltips[status] || "";
}

export function useAvatarWorkStatus(
  employeeIds: string[],
  options?: {
    date?: string;
    branchId?: string;
    scope?: "BRANCH" | "GLOBAL";
    enabled?: boolean;
  }
) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const date = options?.date || today;
  const branchId = options?.branchId;
  const scope = options?.scope || (branchId ? "BRANCH" : "GLOBAL");
  const enabled = options?.enabled !== false && employeeIds.length > 0;

  const sortedIds = [...employeeIds].sort().join(",");

  return useQuery<AvatarStatusMap>({
    queryKey: ["/api/avatar-status/batch", date, branchId || "all", scope, sortedIds],
    queryFn: async () => {
      const resp = await apiRequest("POST", "/api/avatar-status/batch", {
        date,
        branchId,
        scope,
        employeeIds,
      });
      return resp.json();
    },
    enabled,
    staleTime: 15000,
    refetchInterval: 30000,
  });
}
