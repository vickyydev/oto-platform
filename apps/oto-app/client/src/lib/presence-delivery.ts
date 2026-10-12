export interface PresenceDelivery {
  requestKey: string;
  status: "Pending" | "Delivered" | "Failed";
  failureMessage: string | null;
  updatedAt?: string;
  employeeId?: string;
  branchId?: string | null;
  shiftRowId?: string;
  shiftDate?: string;
}

export type LocalPresenceDelivery = PresenceDelivery & { unconfirmed?: true };

export function selectPresenceDelivery(server: PresenceDelivery | null | undefined, local: LocalPresenceDelivery | undefined) {
  if (!local) return server;
  if (server?.requestKey === local.requestKey && server.status === "Delivered") return server;
  // Browser time cannot decide whether the server has seen this request.
  // Retain its key until the response or a matching Delivered row confirms it.
  if (local.unconfirmed) return local;
  // Both timestamps below are server results, never a browser clock reading.
  if (server?.updatedAt && local.updatedAt && server.updatedAt >= local.updatedAt) return server;
  return local;
}

export interface PresenceTarget {
  employeeId: string;
  branchId: string | null;
  shiftRowId: string;
  shiftDate: string;
}

export function retryPresenceTarget(delivery: PresenceDelivery): PresenceTarget | undefined {
  if (delivery.status === "Delivered" || !delivery.employeeId || !delivery.shiftRowId || !delivery.shiftDate || !delivery.branchId) return;
  return { employeeId: delivery.employeeId, branchId: delivery.branchId, shiftRowId: delivery.shiftRowId, shiftDate: delivery.shiftDate };
}

/** A clock-in changes the row's tab, not the identity of an outstanding request. */
export function workingPresenceDeliveries(employeeId: string, branchId: string | null,
  server: PresenceDelivery[], local: LocalPresenceDelivery[], allowedBranchIds?: string[]) {
  const matches = (item: PresenceDelivery) => item.employeeId === employeeId && (branchId === null || item.branchId === branchId) &&
    (allowedBranchIds === undefined || (!!item.branchId && allowedBranchIds.includes(item.branchId)));
  const current = server.filter(matches);
  const result = new Map(current.map(item => [item.requestKey, item]));
  for (const item of local.filter(matches)) {
    const confirmed = current.find(row => row.requestKey === item.requestKey);
    const selected = selectPresenceDelivery(confirmed, item);
    // Completed local results are already represented by the refreshed server.
    if (selected && (confirmed || selected.status !== "Delivered")) result.set(item.requestKey, selected);
  }
  return [...result.values()];
}

/** Stored retry targets carry no employee names or inbox contents. */
export function restorePresenceRequests(storage: { readonly length: number; key(index: number): string | null; getItem(key: string): string | null }, actorId: string) {
  const restored: Record<string, LocalPresenceDelivery> = {};
  const prefix = `presence-ping-target:${actorId}:`;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const item: LocalPresenceDelivery = JSON.parse(storage.getItem(key) || "null");
      if (item && typeof item.requestKey === "string" && ["Pending", "Failed"].includes(item.status) &&
          typeof item.employeeId === "string" && typeof item.branchId === "string" &&
          typeof item.shiftRowId === "string" && typeof item.shiftDate === "string") {
        restored[key.slice("presence-ping-target:".length)] = { ...item, unconfirmed: true };
      }
    } catch { /* An incomplete browser record cannot replace the server result. */ }
  }
  return restored;
}
