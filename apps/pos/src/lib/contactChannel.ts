/**
 * Single source of truth for contact-channel labels, icons, and colours. Used
 * everywhere a channel (WhatsApp / Telegram / LINE) needs to be displayed or
 * picked, so the mapping never drifts between the phone-field selector, chips,
 * messaging surfaces, and admin toggles.
 *
 * BACKEND: which channel actually delivers a message is a backend concern
 * (WhatsApp Business API / Telegram Bot API / LINE Messaging API webhook). The
 * POS only stores the chosen channel and mocks the same send→pending→confirmed
 * loop for all three.
 *
 * LINE was removed from the prototype for a while and restored on client
 * request (Sept 2026) — these are the prototype's original LINE entries.
 */

import { MessageCircle, Send, MessageSquare, type LucideIcon } from 'lucide-react';
import type { ContactChannel } from '@/types';

export const CONTACT_CHANNELS: ContactChannel[] = ['whatsapp', 'telegram', 'line'];

export const CHANNEL_LABEL: Record<ContactChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  line: 'LINE',
};

export const CHANNEL_ICON: Record<ContactChannel, LucideIcon> = {
  whatsapp: MessageCircle,
  telegram: Send,
  line: MessageSquare,
};

// Tailwind text/bg color tokens per channel, for chips/badges/selected pills.
export const CHANNEL_COLOR: Record<ContactChannel, { text: string; bg: string; border: string }> = {
  whatsapp: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  telegram: { text: 'text-sky-400', bg: 'bg-sky-500/15', border: 'border-sky-500/30' },
  line: { text: 'text-lime-400', bg: 'bg-lime-500/15', border: 'border-lime-500/30' },
};

/**
 * Normalizes any legacy/undefined channel value to 'whatsapp'. Use this
 * whenever reading a possibly-legacy contactMethod/preferredChannel so old
 * mock records (and any code path that predates the channel selector) keep
 * behaving exactly as before.
 */
export function normalizeChannel(channel: ContactChannel | string | undefined | null): ContactChannel {
  return channel === 'telegram' || channel === 'line' ? channel : 'whatsapp';
}
