/**
 * THE BEO DEEP LINK (SCRUM-775).
 *
 * The platform inbox's Create BEO opens a birthday's BEO here, signed in as the
 * same person, through the suite hand-off: the hand-off lands on
 * `/studio/events/kanban?beo=<event id>` (`withHandoffTarget`, the launcher's
 * rule), and the Events page opens that event's BEO editor exactly as a click
 * on its card does. These helpers are the page's whole reading of it, pure so
 * the check can hold them.
 */

/** The query parameter that names the event whose BEO to open. */
export const BEO_PARAM = "beo";

/**
 * SCRUM-660: the inbox's Create BEO adds `fill=inbox`, asking the form to run
 * its AI Fill on the conversation's confirmation message as it opens. The
 * message is read server-side; the address only asks.
 */
export const BEO_FILL_PARAM = "fill";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The event id the address asks to open, or null: anything but one uuid is ignored. */
export function beoEventIdFrom(search: string): string | null {
  const values = new URLSearchParams(search).getAll(BEO_PARAM);
  if (values.length !== 1) return null;
  const id = values[0]!.trim();
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** "inbox" when the address asks, exactly once, for the inbox AI Fill; else null. */
export function beoFillFrom(search: string): "inbox" | null {
  const values = new URLSearchParams(search).getAll(BEO_FILL_PARAM);
  return values.length === 1 && values[0] === "inbox" ? "inbox" : null;
}

/** The same address without the parameters, so closing the editor does not open (or fill) it again on a reload. */
export function withoutBeoParam(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(BEO_PARAM);
  params.delete(BEO_FILL_PARAM);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
