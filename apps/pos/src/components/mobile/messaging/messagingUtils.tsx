/**
 * Shared utilities for the mobile WhatsApp Messaging surface.
 * Resolving templates, formatting, status ticks, and contact derivation
 * are kept here so MobileMessaging.tsx stays pure UI.
 *
 * resolveTemplate mirrors the logic in MessagingPanel.tsx (same placeholder
 * contract: {parentName}, {childName}, {time}). It is kept here rather than
 * imported from MessagingPanel because MessagingPanel is an iPad-only component
 * that cannot be edited or depended on from the mobile surface.
 */

import { useMemo } from 'react';
import { Check, CheckCheck } from 'lucide-react';
import { ContactChannel, WaMessage } from '@/types';
import {
  getCheckIns,
  getPartiesForDate,
  getActiveBranch,
  getThread,
} from '@/mockApi';
import { CHANNEL_COLOR, normalizeChannel } from '@/lib/contactChannel';

// ---------------------------------------------------------------------------
// Contact type — name + phone + optional child context
// ---------------------------------------------------------------------------
export interface Contact {
  phone: string;
  name: string;
  childName?: string;
  channel: ContactChannel;
}

// ---------------------------------------------------------------------------
// Contact derivation — builds a deduplicated list of contactable parents
// (WhatsApp / Telegram / LINE) from operational mock data (drop-off check-ins
// + today's parties). This is the authoritative source for the conversation
// list; no hardcoded array.
// ---------------------------------------------------------------------------
// Uses the canonical normalizePhone from lib/phoneUtils — single implementation
// shared by mockApi, messagingUtils, and PhoneInput.
import { normalizePhone as normalisePhone } from '@/lib/phoneUtils';

export function deriveContacts(): Contact[] {
  const seen = new Set<string>();
  const contacts: Contact[] = [];

  // Parties today in the current branch (parentName + phone + childName).
  // Party.whatsapp is a legacy field name for "party contact number" — parties
  // don't yet carry a channel preference, so default to whatsapp.
  const today = new Date().toISOString().slice(0, 10);
  const branchId = getActiveBranch().id;
  for (const party of getPartiesForDate(today, branchId)) {
    if (!party.whatsapp) continue;
    const key = normalisePhone(party.whatsapp);
    if (key && !seen.has(key)) {
      seen.add(key);
      contacts.push({
        phone: party.whatsapp,
        name: party.parentName,
        childName: party.childName,
        channel: 'whatsapp',
      });
    }
  }

  // Drop-off check-ins across all statuses (phone + parentName + childName),
  // any contact channel (WhatsApp / Telegram / LINE).
  for (const ci of getCheckIns()) {
    const key = normalisePhone(ci.phone);
    if (key && !seen.has(key)) {
      seen.add(key);
      contacts.push({
        phone: ci.phone,
        name: ci.parentName,
        childName: ci.childName,
        channel: normalizeChannel(ci.contactMethod),
      });
    }
  }

  return contacts;
}

// ---------------------------------------------------------------------------
// Template placeholder resolution — matches MessagingPanel.tsx contract.
// Unknown tokens are left as-is so staff can see them before sending.
// ---------------------------------------------------------------------------
export function resolveTemplate(body: string, contact: Contact, time = ''): string {
  return body
    .replaceAll('{parentName}', contact.name || '')
    .replaceAll('{childName}', contact.childName || '')
    .replaceAll('{time}', time);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
export const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const fmtRelative = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export const initials = (name: string): string =>
  name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

// ---------------------------------------------------------------------------
// Outbound status ticks — mirrors MessagingPanel.tsx StatusTicks component
// ---------------------------------------------------------------------------
export function StatusTicks({ status }: { status: WaMessage['status'] }) {
  if (status === 'sending') return <span className="text-[10px] opacity-70">Sending…</span>;
  if (status === 'failed') return <span className="text-[10px] text-red-300">Failed</span>;
  if (status === 'sent') return <Check className="w-3.5 h-3.5 opacity-70" />;
  if (status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 opacity-70" />;
  // read
  return <CheckCheck className="w-3.5 h-3.5 text-sky-300" />;
}

// ---------------------------------------------------------------------------
// Unread maths — "unread" = inbound messages that arrived after the last
// outbound reply (i.e. parent messages staff haven't responded to yet). Shared
// by the conversation list, the mobile nav tab, and the iPad nav button so the
// badge count is computed in exactly one place.
// ---------------------------------------------------------------------------
export function unreadForThread(thread: WaMessage[]): number {
  const lastOutboundIdx = [...thread]
    .reverse()
    .findIndex((m) => m.direction === 'outbound');
  if (lastOutboundIdx === -1) {
    return thread.filter((m) => m.direction === 'inbound').length;
  }
  return thread
    .slice(thread.length - lastOutboundIdx)
    .filter((m) => m.direction === 'inbound').length;
}

// Total unread across every WhatsApp-contactable parent derived from today's
// operational data. Recomputed on each render of the nav chrome; navigation
// between surfaces naturally refreshes the badge.
export function getTotalUnreadCount(): number {
  return deriveContacts().reduce(
    (sum, c) => sum + unreadForThread(getThread(c.phone)),
    0,
  );
}

// ---------------------------------------------------------------------------
// Red notification badge for nav buttons (mobile tab + iPad menu). Positioned
// absolutely, so the parent element must be `relative`.
// ---------------------------------------------------------------------------
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none ring-2 ring-background">
      {count > 99 ? '99+' : count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Conversation list row — avatar, name, last-message preview, relative time and
// a per-conversation unread count. Shared between the mobile Messages surface
// and the iPad Messages inbox so the row UI lives in one place.
// ---------------------------------------------------------------------------
export function ConversationRow({
  contact,
  onSelect,
}: {
  contact: Contact;
  onSelect: () => void;
}) {
  const thread = getThread(contact.phone);
  const last = thread.at(-1);
  const unreadCount = useMemo(() => unreadForThread(thread), [thread]);
  const colors = CHANNEL_COLOR[normalizeChannel(contact.channel)];

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/30 active:bg-muted/50 transition-colors border-b border-border/50"
    >
      <span className={`w-11 h-11 rounded-full ${colors.bg} ${colors.text} flex items-center justify-center shrink-0 text-sm font-bold`}>
        {initials(contact.name)}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sm truncate">{contact.name}</span>
          {last && (
            <span className="text-[11px] text-muted-foreground shrink-0">
              {fmtRelative(last.at)}
            </span>
          )}
        </div>
        {last ? (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {last.direction === 'outbound' && (
              <span className="mr-1 opacity-60">You:</span>
            )}
            {last.body}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground italic mt-0.5">No messages yet</p>
        )}
      </div>

      {unreadCount > 0 && (
        <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

// Sort contacts by most-recent thread message (newest first); contacts with no
// thread fall to the end, sorted by name. Shared by both inbox surfaces.
export function sortContactsByRecency(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => {
    const aLast = getThread(a.phone).at(-1)?.at ?? '';
    const bLast = getThread(b.phone).at(-1)?.at ?? '';
    if (aLast && bLast) return bLast.localeCompare(aLast);
    if (aLast) return -1;
    if (bLast) return 1;
    return a.name.localeCompare(b.name);
  });
}
