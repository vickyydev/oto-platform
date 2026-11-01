import type { Tone } from '@/components/Status';
import { logTime } from '../booth/todayStaff';
import type {
  NannyAppState,
  NannyDutyLogLine,
  NannyShiftView,
  NannySource,
  NannyUnmatched,
} from './nannyApi';

export { initialOf, logTime } from '../booth/todayStaff';

/**
 * The words of the "Today's nannies" card (SCRUM-699), kept apart from the
 * card so they can be read, and tested, without rendering anything. The
 * booth's "Today's staff" words are the model (`../booth/todayStaff.ts`).
 */

/** The chip beside each nanny: where they came from. */
export const NANNY_SOURCE: Record<NannySource, { label: string; tone: Tone }> = {
  seed: { label: 'Demo roster', tone: 'idle' },
  app_schedule: { label: 'From the rota', tone: 'ok' },
  manual: { label: 'Added by hand', tone: 'idle' },
};

/** A source as a log line ends: "· rota sync". */
const SOURCE_TAIL: Record<NannySource, string> = {
  seed: 'demo roster',
  app_schedule: 'rota sync',
  manual: 'added by hand',
};

/** What the last sync found about the OTO App, when it is not simply "read". */
export const APP_STATE_NOTE: Record<NannyAppState, string | null> = {
  ok: null,
  app_not_installed:
    'The OTO App is not on this deployment, so there is no rota to read. Add today’s nannies by hand.',
  no_app_branch:
    'This branch has no counterpart in the OTO App yet, so its rota cannot be read. Map it under Branches, or add today’s nannies by hand.',
  ambiguous_app_branch:
    'Two branches in the OTO App carry this branch’s name, so neither was read. Map it under Branches, or add today’s nannies by hand.',
};

/** Why a nanny shift on the rota did not become a nanny the till can pick. */
export const UNMATCHED_REASON: Record<NannyUnmatched['reason'], string> = {
  no_employee_row: 'the OTO App has no employee record for this shift',
  no_name: 'their OTO App record has no name',
  casual_worker: 'a casual worker, not an employee, so not added as a nanny',
};

/** One unmatched entry as a sentence; a nameless one is still said, never dropped. */
export function unmatchedLine(entry: NannyUnmatched): string {
  return `${entry.name ?? 'Somebody on the rota'} — ${UNMATCHED_REASON[entry.reason] ?? entry.reason}`;
}

/** "10:00–18:00" in the park's own time. A shift past midnight reads "22:00–02:00". */
export function shiftHours(
  startsAt: string,
  endsAt: string,
  timezone: string | null | undefined,
): string {
  return `${logTime(startsAt, timezone)}–${logTime(endsAt, timezone)}`;
}

/** The shift has ended at `asOf`: it stays on the record and cannot be removed. */
export function shiftOver(shift: Pick<NannyShiftView, 'endsAt'>, asOf: string): boolean {
  const end = Date.parse(shift.endsAt);
  const now = Date.parse(asOf);
  return Number.isFinite(end) && Number.isFinite(now) && end <= now;
}

/** The load beside a nanny: "1 child", "2 children". */
export function loadText(load: number): string {
  return load === 1 ? '1 child' : `${load} children`;
}

/** "พี่เลี้ยง also matches", under the match-text field. */
export function alsoMatchesLine(words: readonly string[]): string | null {
  return words.length === 0
    ? null
    : `${words.join(', ')} also ${words.length === 1 ? 'matches' : 'match'}`;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One audit row as a person reads it, in the card's quiet log:
 * "Fah on today’s nannies, 10:00–19:00 · rota sync". The hours are said only
 * when the park's time zone is given.
 */
export function logLineText(line: NannyDutyLogLine, timezone?: string | null): string {
  const d = line.detail ?? {};
  const who = str(d.name) ?? 'Somebody';
  const source = str(d.source) as NannySource | null;
  const tail = source ? ` · ${SOURCE_TAIL[source] ?? source}` : '';
  const startsAt = str(d.startsAt);
  const endsAt = str(d.endsAt);
  const hours = timezone && startsAt && endsAt ? `, ${shiftHours(startsAt, endsAt, timezone)}` : '';
  switch (line.action) {
    case 'nanny_duty.assign':
      return `${who} on today’s nannies${hours}${tail}`;
    case 'nanny_duty.unassign':
      return d.cutShort === true
        ? `${who}’s shift cut short${timezone && endsAt ? ` at ${logTime(endsAt, timezone)}` : ''}${tail}`
        : `${who}’s shift taken off today’s nannies${hours}${tail}`;
    case 'nanny_duty.reshift':
      return `${who}: hours updated from the rota${hours}`;
    case 'nanny_duty.rename':
      return `${who}: name updated from the rota`;
    case 'nanny_duty.sync': {
      const state = str(d.appState) as NannyAppState | null;
      if (state && state !== 'ok') return 'Sync ran, but the rota could not be read';
      const unmatched = Array.isArray(d.unmatched) ? d.unmatched.length : 0;
      const parts = [`${num(d.added)} added`, `${num(d.removed)} removed`];
      if (num(d.reshifted) > 0) parts.push(`${num(d.reshifted)} with new hours`);
      if (num(d.renamed) > 0) parts.push(`${num(d.renamed)} renamed`);
      if (unmatched > 0) parts.push(`${unmatched} not matched`);
      return `Synced from the OTO App · ${parts.join(', ')}`;
    }
    case 'nanny_duty.rule':
      return 'How nannies are found on the rota was changed';
    default:
      return line.action;
  }
}
