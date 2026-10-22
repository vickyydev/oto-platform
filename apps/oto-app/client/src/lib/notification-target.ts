/**
 * Where tapping an in-app notification goes. No imports on purpose: the
 * server-side checks read this file as the client has it.
 */
export interface NotificationLink {
  type: string;
  referenceType: string | null;
  referenceId: string | null;
}

export function notificationTarget(notification: NotificationLink): string | null {
  if (notification.type === "timekeeping_ping" || !notification.referenceId) return null;
  if (notification.referenceType === "task") return `/ops?taskId=${notification.referenceId}`;
  // SCRUM-656: an urgent Fix report opens on the Fix Board.
  if (notification.referenceType === "fix_report") {
    return `/core/fix-board?reportId=${encodeURIComponent(notification.referenceId)}`;
  }
  return null;
}
