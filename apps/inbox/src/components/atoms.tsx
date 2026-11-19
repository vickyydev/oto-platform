// The prototype's small UI atoms (WhatsAppDemo.tsx :727-1026, :1773-1868),
// their data moved onto the api's shapes: `Avatar`, `ChannelDot`,
// `EmptyState`; and the toggle pill as the rail's `FilterChip`, which took
// the place of the prototype's `FilterSelect` (SCRUM-220 playbook). The
// dashboard's `MetricCard` and `CategoryMixCard` gave way to the statistics
// row, and the chat header's `StatusBadge` and `CategoryBadge` to the chat's
// People and actions, where team and status are rows (SCRUM-1016).
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { InboxChannelKey } from '@oto/shared/inbox';
import { CHANNEL_LABEL, CHANNEL_TINT, TRANSLATION_PENDING } from '@/lib/view';

/**
 * The mark on a RU or TH template whose body is still the English source
 * (test night 2026-10-21, U1: English went to a Russian customer unknowingly).
 * The same words wherever a template is offered to a reply.
 */
export function TranslationNote() {
  return (
    <span className="rounded-full bg-needs px-1.5 text-caption font-medium text-needs-ink">
      {TRANSLATION_PENDING}
    </span>
  );
}

/**
 * A contact's face: their initials on their tint, a soft square (Main.dc.html,
 * a 32 % radius), so a face never reads as a person's round chip. Its size is
 * the scale's (SCRUM-1045): `face` in a row and on a sheet (44 px on a phone,
 * 36 to 38 px elsewhere), `face-sm` in the chat's header.
 */
const FACE = { face: 'size-face text-note', 'face-sm': 'size-face-sm text-meta' } as const;
export function Avatar({ initials, tint, size = 'face' }: { initials: string; tint: string; size?: keyof typeof FACE }) {
  return (
    <div aria-hidden className={`flex shrink-0 items-center justify-center rounded-[32%] font-bold ${FACE[size]} ${tint}`}>
      {initials}
    </div>
  );
}

/** The channel's dot on a face; `ring` is the ground the face stands on, so the dot is cut out of it. */
export function ChannelDot({ channel, ring = 'ring-card' }: { channel: InboxChannelKey; ring?: string }) {
  return (
    <span
      title={CHANNEL_LABEL[channel]}
      className={`absolute -bottom-[3px] -right-[3px] h-3 w-3 rounded-full ring-2 ${ring} ${CHANNEL_TINT[channel]}`}
    />
  );
}

/**
 * The toggle pill (Filters.dc.html): the archive's choices on the Handled
 * tab, the Unread quick filter and every choice in the Filters sheet. A card
 * with a 1 px field border when off; when on, the coral's light ground with
 * a 1 px coral edge (SCRUM-1045: a chosen state is a ground and a fine edge,
 * never a heavy fill or ring), the state in `aria-pressed` (SCRUM-652).
 * 44 px tall on a phone, the scale's `ctl` (32 to 34 px) on a tablet or a
 * desktop, and still a 44 px target on a touch screen (`hit`).
 */
export const PILL =
  'hit inline-flex min-h-ctl items-center rounded-full border px-3.5 text-ui font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral md:px-3';
export const PILL_ON = 'border-coral bg-needs text-needs-ink';
export const PILL_OFF = 'border-field bg-card text-ink hover:bg-wash';

/**
 * One choice of the Filters sheet: a press adds it, a second press removes
 * it. `dot` is a small mark in the thing's own colour — a topic's, a
 * channel's — so the GM queue reads amber on its choice as in the views
 * column. `chipKey` names the choice for the markup tests (`dim:value`).
 */
export function FilterChip({
  chipKey,
  label,
  pressed,
  onClick,
  dot,
  title,
}: {
  chipKey: string;
  label: string;
  pressed: boolean;
  onClick: () => void;
  dot?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      data-chip={chipKey}
      aria-pressed={pressed}
      onClick={onClick}
      title={title ?? label}
      className={`${PILL} ${pressed ? PILL_ON : PILL_OFF} min-w-0 max-w-full gap-2`}
    >
      {dot && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function EmptyState({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="flex size-ctl-lg items-center justify-center rounded-full bg-band text-ink-muted">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-ui font-semibold text-ink">{title}</div>
      <div className="max-w-xs text-note text-ink-muted">{subtitle}</div>
    </div>
  );
}

/** The eyebrow label: uppercase, letter-spaced, grey. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-caption font-semibold uppercase tracking-[0.16em] text-ink-muted ${className}`}>{children}</div>
  );
}
