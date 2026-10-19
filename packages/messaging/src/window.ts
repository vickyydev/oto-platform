import type { OutboundContent, SendRefusal } from './contract';

/**
 * THE FREE-TEXT WINDOW (plan §2.1, §3.3).
 *
 * WhatsApp lets a business send free text only within 24 hours of the
 * customer's last message; outside it only an approved template may be sent.
 * The rule lives here, once, so that the simulator enforces it before any Meta
 * account exists and the WhatsApp adapter refuses locally rather than spending
 * a request on a certain `131047`.
 *
 * A customer who has never written (`lastCustomerMessageAt` null) is outside
 * every window. The boundary is exclusive: at exactly 24 hours the window has
 * closed.
 */
export function insideFreeTextWindow(
  lastCustomerMessageAt: Date | null,
  now: Date,
  windowHours: number,
): boolean {
  if (!lastCustomerMessageAt) return false;
  return now.getTime() - lastCustomerMessageAt.getTime() < windowHours * 3_600_000;
}

/** Null when the content may be sent now; `TEMPLATE_REQUIRED` when it may not. */
export function windowRefusal(
  content: OutboundContent,
  lastCustomerMessageAt: Date | null,
  now: Date,
  windowHours: number | null,
): Extract<SendRefusal, 'TEMPLATE_REQUIRED'> | null {
  if (windowHours === null || content.kind === 'template') return null;
  return insideFreeTextWindow(lastCustomerMessageAt, now, windowHours) ? null : 'TEMPLATE_REQUIRED';
}
