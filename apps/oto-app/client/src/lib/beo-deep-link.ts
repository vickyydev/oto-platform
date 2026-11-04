/**
 * THE BEO DEEP LINK (SCRUM-775).
 *
 * The platform inbox's Create BEO opens a birthday's BEO here, signed in as the
 * same person, through the suite hand-off: the hand-off lands on
 * `/studio/events/kanban?beo=<event id>` (`withHandoffTarget`, the launcher's
 * rule), and the Events page opens that event's BEO editor exactly as a click
 * on its card does. These two helpers are the page's whole reading of it, pure
 * so the check can hold them.
 */

/** The query parameter that names the event whose BEO to open. */
export const BEO_PARAM = "beo";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The event id the address asks to open, or null: anything but one uuid is ignored. */
export function beoEventIdFrom(search: string): string | null {
  const values = new URLSearchParams(search).getAll(BEO_PARAM);
  if (values.length !== 1) return null;
  const id = values[0]!.trim();
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** The same address without the parameter, so closing the editor does not open it again on a reload. */
export function withoutBeoParam(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(BEO_PARAM);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
