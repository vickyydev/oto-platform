export interface PresenceDelivery {
  requestKey: string;
  status: "Pending" | "Delivered" | "Failed";
  failureMessage: string | null;
  updatedAt?: string;
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
