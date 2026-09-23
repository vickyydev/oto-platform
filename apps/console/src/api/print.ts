/**
 * Printing, as the Console asks for it.
 *
 * **WHY THE BOX DRAWER'S TEST PRINT COMES THROUGH HERE RATHER THAN THROUGH
 * `POST /boxes/:id/commands` (SCRUM-364).**
 *
 * A test print is two rows, not one: the `edge.box_command` the box collects,
 * and the `edge.print_job` its outcome is reported against. The bare command
 * route writes only the first — `queueCommand` in `apps/api/src/services/
 * fleet.ts` checks that the payload names a device on this box and then queues
 * the command and nothing else — so the box printed, reported its outcome to
 * `POST /box/v1/print-jobs/:id/result` against an id no row carried, and the
 * platform answered `404 PRINT_JOB_NOT_FOUND`. Paper came out, the command read
 * `succeeded`, and the drawer's Printing panel never listed the job.
 *
 * `requestTestPrint` (`apps/api/src/services/print.ts`) is the one place that
 * writes BOTH — the job first, then the command carrying that job's id in its
 * payload — and this route is its door. So there is one path that mints print
 * jobs rather than a second copy of the row's shape, its template link, its
 * audit action and its skipped case living beside the command queue.
 *
 * **It is reachable from here.** The route takes an ordinary staff session and
 * asks for `admin:box:command` at the station's branch — the same permission
 * the command route asks for, which is what the drawer's Controls section is
 * already gated on. There is no station credential in it, so nothing the
 * Console cannot present.
 *
 * **The station and the role are the whole address.** A queued test print is
 * routed ON THE BOX by the job a printer does at a station (`routeTo` in
 * `packages/box-agent/src/printing/queue.ts` matches `role` against that
 * station's assignments), and `station_device_role_unique` makes (station,
 * role) name exactly one device — which is the pair the drawer's two pickers
 * already choose. The cloud resolves the same pair onto the job row, so the
 * Printing panel can say which printer it went to while it is still queued.
 */
import { api } from './client';

/** One `edge.print_job` row, as the test-print routes answer with it. */
export interface PrintJobRow {
  id: string;
  branchId: string;
  boxId: string;
  stationId: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  role: string | null;
  kind: string;
  status: 'queued' | 'printed' | 'failed' | 'skipped' | string;
  copies: number;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  actionId: string | null;
  queuedAt: string;
  finishedAt: string | null;
}

export interface TestPrintResult {
  printJob: PrintJobRow;
  /** Empty when no printer took it: there was nothing to queue for the box. */
  commandId: string;
  actionId: string;
}

export const printApi = {
  /**
   * Print one of the nine printouts at a station, on the printer that does
   * `role` there.
   *
   * No idempotency key, deliberately: two presses of Test print mean two pieces
   * of paper, which is what somebody pressing it twice is asking for. The
   * Console's other writes do carry one (`fleetApi.sendCommand` mints a fresh
   * key per press), and so does the till's own test print — each press its own
   * key, so the effect is the same; this call simply sends none.
   */
  stationTestPrint: (
    stationId: string,
    body: { kind?: string; role?: string; copies?: number },
  ) =>
    api.post<TestPrintResult>(
      `/stations/${encodeURIComponent(stationId)}/test-print`,
      body,
    ),
};
