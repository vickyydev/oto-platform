import { useEffect } from "react";
import { ApiError, queryClient } from "@/lib/queryClient";

/** The server's answer that this person cannot have the report: deleted, or out of their reach. */
const refusedByServer = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * For a screen showing one report, given its details read: true when it should
 * say the report is not available, because the read failed with nothing to show
 * or the server refused it. A read that only failed on a copy already here keeps
 * the copy, so a dropped connection does not take the screen from someone typing
 * an update.
 *
 * The lists then read again, so the report leaves the cards and the counts. Not
 * the details reads: this one has already answered, and asking it again from
 * here would never settle.
 */
export function useFixReportUnavailable(read: { isError: boolean; data: unknown; error: unknown }) {
  const unavailable = read.isError && (read.data === undefined || refusedByServer(read.error));
  useEffect(() => {
    if (!unavailable) return;
    void queryClient.invalidateQueries({
      queryKey: ["/api/fix-reports"],
      predicate: (query) => query.queryKey[2] !== "details",
    });
  }, [unavailable]);
  return unavailable;
}

/**
 * A write the server refused can mean the report went while it was open. Reading
 * it again then turns the screen to "not available" instead of leaving it
 * offering writes that cannot land; if the report is still there, nothing changes.
 */
export function recheckFixReportIfRefused(reportId: string | undefined, error: unknown) {
  if (refusedByServer(error)) {
    void queryClient.invalidateQueries({ queryKey: ["/api/fix-reports", reportId, "details"] });
  }
}
