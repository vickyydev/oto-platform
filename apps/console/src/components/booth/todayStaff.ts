import type { Tone } from '@/components/Status';
import type {
  BoothDutyAppState,
  BoothDutyLogLine,
  BoothDutySource,
  BoothDutyUnmatched,
} from './boothApi';

/**
 * The words of the "Today's staff" card (SCRUM-473), kept apart from the card
 * so they can be read — and tested — without rendering anything.
 */

/** The chip beside each person: where they came from. */
export const DUTY_SOURCE: Record<BoothDutySource, { label: string; tone: Tone }> = {
  app_schedule: { label: 'From the rota', tone: 'ok' },
  app_duty_block: { label: 'Duty block', tone: 'ok' },
  manual: { label: 'Added by hand', tone: 'idle' },
  self_assigned: { label: 'Stand-in', tone: 'warn' },
};

/** A source as the log line ends: "· rota sync". */
const SOURCE_TAIL: Record<BoothDutySource, string> = {
  app_schedule: 'rota sync',
  app_duty_block: 'duty block',
  manual: 'added by hand',
  self_assigned: 'signed in at the booth',
};

/** What the last sync found about the OTO App, when it is not simply "read". */
export const APP_STATE_NOTE: Record<BoothDutyAppState, string | null> = {
  ok: null,
  app_not_installed:
    'The OTO App is not on this deployment, so there is no rota to read. Add today’s staff by hand.',
  no_app_branch:
    'This branch has no counterpart in the OTO App yet, so its rota cannot be read. Map it under Branches, or add today’s staff by hand.',
  ambiguous_app_branch:
    'Two branches in the OTO App carry this branch’s name, so neither was read. Map it under Branches.',
};

export const UNMATCHED_REASON: Record<BoothDutyUnmatched['reason'], string> = {
  no_app_user: 'has no OTO App login',
  no_platform_account: 'their OTO App login is not linked to a platform account',
};

/** The sentence under the roster: what every voucher prints today. */
export function labelLine(label: string | null): string {
  return label
    ? `On every voucher today: ${label}`
    : 'Nobody is on today’s roster: a voucher prints whoever is signed in, or “unattributed”.';
}

/** "Initials" for the round badge: the first letter of the name. */
export function initialOf(name: string): string {
  const first = name.trim().charAt(0);
  return first === '' ? '?' : first.toUpperCase();
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One audit row as a person reads it, in the card's quiet log:
 * "Tom assigned to today’s booth duty · rota sync".
 */
export function logLineText(line: BoothDutyLogLine): string {
  const d = line.detail ?? {};
  const who = str(d.displayName) ?? 'Somebody';
  const source = str(d.source) as BoothDutySource | null;
  switch (line.action) {
    case 'booth_duty.assign':
      return `${who} assigned to today’s booth duty${source ? ` · ${SOURCE_TAIL[source] ?? source}` : ''}`;
    case 'booth_duty.unassign':
      return `${who} taken off today’s booth duty`;
    case 'booth_duty.rename':
      return `${who}: name updated from the rota`;
    case 'booth_duty.sync': {
      const state = str(d.appState) as BoothDutyAppState | null;
      if (state && state !== 'ok') return 'Sync ran, but the rota could not be read';
      const unmatched = Array.isArray(d.unmatched) ? d.unmatched.length : 0;
      const parts = [`${num(d.added)} added`, `${num(d.removed)} removed`];
      if (unmatched > 0) parts.push(`${unmatched} not matched`);
      return `Synced from the OTO App · ${parts.join(', ')}`;
    }
    case 'booth_duty.rule':
      return 'How this booth’s staff are found was changed';
    default:
      return line.action;
  }
}

/** "07:02" in the branch's own time, for the log's mono column. */
export function logTime(iso: string, timezone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}
