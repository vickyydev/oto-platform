import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { EffectivePermissions } from "@shared/permissions";
import { ApiError, apiRequest } from "@/lib/queryClient";
import { useAuth } from "./use-auth";

export interface ManagedTarget {
  managedInAdmin: boolean;
}

export type ManagementPermissions = EffectivePermissions & ManagedTarget;

const ACTOR_PATH = "/api/permissions/me";
const MANAGEMENT_LISTS = ["/api/users", "/api/permissions/bulk", "/api/admin/operators", "/api/branches"];

/** Read management authority separately for each signed-in identity. */
export function useAdminManagement() {
  const { user } = useAuth();
  const client = useQueryClient();
  const queryKey = [ACTOR_PATH, "admin-management", user?.id ?? null] as const;
  const query = useQuery<ManagementPermissions>({
    queryKey,
    enabled: !!user,
    queryFn: async () => (await apiRequest("GET", ACTOR_PATH)).json(),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const ready = !!user && query.isSuccess && !query.isFetching
    && typeof query.data?.managedInAdmin === "boolean";
  const scope = JSON.stringify([user?.id, user?.tenantId, user?.operatorId, user?.role]);
  const actorWritable = ready && query.data?.managedInAdmin === false;
  const current = useRef({ actorId: user?.id, queryKey, mounted: true, scope, actorWritable, generation: 0 });
  if (current.current.scope !== scope || (current.current.actorWritable && !actorWritable)) current.current.generation++;
  current.current.actorId = user?.id;
  current.current.queryKey = queryKey;
  current.current.scope = scope;
  current.current.actorWritable = actorWritable;
  useEffect(() => {
    current.current.mounted = true;
    return () => { current.current.mounted = false; };
  }, []);

  const actorManaged = ready ? query.data?.managedInAdmin : undefined;

  function canWrite(targetManaged: boolean | undefined) {
    return ready && actorManaged === false && targetManaged === false;
  }

  function readList<Row>(key: QueryKey): Row[] | undefined {
    const state = client.getQueryState<Row[]>(key);
    if (state?.status !== "success" || state.fetchStatus !== "idle" || !Array.isArray(state.data)) return undefined;
    return state.data;
  }

  function readTarget<Row>(
    key: QueryKey,
    match: (row: Row) => boolean,
    managed: (row: Row) => unknown,
  ): boolean | undefined {
    const row = readList<Row>(key)?.find(match);
    if (!row) return undefined;
    const value = managed(row);
    return typeof value === "boolean" ? value : undefined;
  }

  /** Old dialog callbacks consult current query state immediately before dispatch. */
  function assertWritable(readTargetManaged: () => boolean | undefined = () => false) {
    const live = current.current;
    const state = client.getQueryState<ManagementPermissions>(live.queryKey);
    if (!live.mounted || live.scope !== scope || !live.actorId || state?.status !== "success" || state.fetchStatus !== "idle"
      || state.data?.managedInAdmin !== false || readTargetManaged() !== false) {
      throw new ApiError("Management is unavailable here. Open Admin or refresh the management status.", 409, "managed_in_admin");
    }
  }

  /** A dispatched sequence never acquires another actor's later authority. */
  function beginWrite(readTargetManaged: () => boolean | undefined = () => false) {
    const generation = current.current.generation;
    const assertCurrent = () => {
      if (current.current.generation !== generation) {
        throw new ApiError("Management changed while this action was running. Refresh before continuing.", 409, "managed_in_admin");
      }
      assertWritable(readTargetManaged);
    };
    assertCurrent();
    return assertCurrent;
  }

  function retry() {
    void client.invalidateQueries({ queryKey: [ACTOR_PATH] });
    for (const path of MANAGEMENT_LISTS) void client.invalidateQueries({ queryKey: [path] });
  }

  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 409) retry();
  }

  return { actorManaged, ready, checking: query.isFetching, canWrite, assertWritable, beginWrite, readList, readTarget, retry, handleError };
}
