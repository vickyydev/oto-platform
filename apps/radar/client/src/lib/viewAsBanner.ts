/**
 * SCRUM-648 (S2-23) — Radar's view-as banner, the parts that are not
 * React. `/api/me` carries `viewAs` when the session is a support
 * administrator's audited "view as" window; the banner names both people and
 * the time left for the whole window and cannot be dismissed. While it shows,
 * `html.view-as-active` starts the page below it (`index.css`).
 */

export interface ViewAs {
  id: string;
  actorName: string | null;
  subjectName: string | null;
  mode: "read_only" | "write_allowed";
  expiresAt: string;
}

/** The window out of an `/api/me` answer, or null on any ordinary session. */
export function viewAsOf(me: unknown): ViewAs | null {
  const v = (me as { viewAs?: unknown } | null | undefined)?.viewAs as Partial<ViewAs> | null | undefined;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || typeof v.expiresAt !== "string") return null;
  if (v.mode !== "read_only" && v.mode !== "write_allowed") return null;
  return { id: v.id, actorName: v.actorName ?? null, subjectName: v.subjectName ?? null, mode: v.mode, expiresAt: v.expiresAt };
}

export function viewAsLine(v: ViewAs): string {
  const actor = v.actorName ?? "A support administrator";
  const subject = v.subjectName ?? "a staff account";
  const mode = v.mode === "read_only" ? "read-only, nothing can be changed" : "changes allowed";
  return `${actor} is viewing Radar as ${subject} \u2014 ${mode}`;
}

export function timeLeft(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
}

export const VIEW_AS_ACTIVE = "view-as-active";
export function markViewAsOffset(root: { classList: { toggle(token: string, force?: boolean): unknown } }, on: boolean): void {
  root.classList.toggle(VIEW_AS_ACTIVE, on);
}
