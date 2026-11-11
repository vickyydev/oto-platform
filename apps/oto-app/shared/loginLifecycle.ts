/**
 * SCRUM-852 — what the employee's Access & Login panel says when the platform
 * refused a login's switch-off (or a leaver's move to pay only) and the queue
 * parked it.
 *
 * The app tells the platform about both through a durable queue
 * (`login_lifecycle_events`, delivered by `server/lib/platformLifecycle.ts`).
 * An outage never parks an event: it is tried again until it is delivered.
 * Only the platform's own refusal, six times, parks it — and then the app
 * shows the login off (or in pay only) while the person still holds their
 * roles on the platform. That is the one state an administrator has to see
 * and act on, so it gets one plain line and a "Send again" button.
 *
 * Pure: the server reads the events (`GET /api/admin/login-lifecycle`) and
 * marks the one that may be sent again (`parked`); this turns them into words.
 */

/** One event as `GET /api/admin/login-lifecycle` answers it. */
export interface LoginLifecycleEventRead {
  id: string;
  kind: "deactivate" | "restrict";
  state: "pending" | "delivered" | "superseded";
  lastErrorCode: string | null;
  /** True for a parked event that still stands: the one "Send again" accepts. */
  parked: boolean;
}

export interface ParkedLifecycleNotice {
  eventId: string;
  kind: "deactivate" | "restrict";
  /** The whole line, as shown. */
  line: string;
}

/** The platform's refusal, in plain words. Every reason is a full clause ending in a stop. */
export function lifecycleRefusalWords(lastErrorCode: string | null): string {
  const code = (lastErrorCode ?? "").replace(/^RETRY_LIMIT:/, "");
  switch (code) {
    case "LAST_OPERATOR_ADMIN":
      return "this person is the only administrator who can hand out access there. Give somebody else an administrator role on the platform first.";
    case "NOT_FOUND":
      return "the platform could not match this login to an account of this park.";
    default:
      // The platform's codes are upper-case words; anything else is not shown.
      return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) && code !== "RETRY_LIMIT_REACHED"
        ? `the platform refused it (${code}).`
        : "the platform refused it.";
  }
}

const NOT_TOLD = {
  deactivate: "The platform was not told to switch this login off",
  restrict: "The platform was not told to limit this login to My pay",
} as const;

/**
 * The lines to show: at most one per kind, for the event the server marked as
 * parked. The server answers newest first and marks only the newest of a kind.
 */
export function parkedLifecycleNotices(events: readonly LoginLifecycleEventRead[]): ParkedLifecycleNotice[] {
  const notices: ParkedLifecycleNotice[] = [];
  for (const kind of ["deactivate", "restrict"] as const) {
    const event = events.find((e) => e.kind === kind && e.parked === true && e.state === "pending");
    if (event) notices.push({ eventId: event.id, kind, line: `${NOT_TOLD[kind]}: ${lifecycleRefusalWords(event.lastErrorCode)}` });
  }
  return notices;
}
