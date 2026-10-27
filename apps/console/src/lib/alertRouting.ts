/**
 * SCRUM-644 (planner ruling Q25) — the words and rules the Activity export and
 * the Failures mute and recipient controls share. Pure, so the node runner
 * can test them; the API enforces every one of these again.
 */

/** A mute lasts at most a day; a longer silence is decided again each day. */
export const MUTE_MAX_MINUTES = 24 * 60;
export const MUTE_DEFAULT_MINUTES = 60;

/** The durations the mute form offers. None is longer than 24 hours. */
export const MUTE_DURATIONS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 4 * 60, label: '4 hours' },
  { minutes: 8 * 60, label: '8 hours' },
  { minutes: MUTE_MAX_MINUTES, label: '24 hours (the most)' },
];

/** Why the mute form cannot be sent yet, or null when it can. */
export function muteFormProblem(form: { reason: string; minutes: number }, max = MUTE_MAX_MINUTES): string | null {
  if (!form.reason.trim()) return 'Say why this is being muted. The reason is recorded with the mute.';
  if (!Number.isInteger(form.minutes) || form.minutes < 1) return 'Choose how long to mute it for.';
  if (form.minutes > Math.min(max, MUTE_MAX_MINUTES)) {
    return 'A mute lasts at most 24 hours. A longer silence is decided again each day.';
  }
  return null;
}

/** The longest duration on offer is never past the server's own maximum. */
export function muteDurations(max = MUTE_MAX_MINUTES) {
  const cap = Math.min(max, MUTE_MAX_MINUTES);
  return MUTE_DURATIONS.filter((d) => d.minutes <= cap);
}

/** What the screen says about where a recipient row points — the variable's name, never an address. */
export function recipientAddressWords(r: { channel: string; addressRef: string | null; addressConfigured: boolean | null }): string {
  if (r.channel === 'console' || r.addressRef === null) return 'The console log — no address needed';
  const state = r.addressConfigured === true ? 'set on this deployment' : 'not set on this deployment';
  return `Reads ${r.addressRef} (${state})`;
}

/** An environment variable name the API accepts as an address reference. */
export const ADDRESS_REF_PATTERN = /^ALERT_[A-Z0-9_]{2,58}$/;

/** Why the recipient form cannot be sent yet, or null when it can. */
export function recipientFormProblem(form: { category: string; channel: string; addressRef: string }): string | null {
  if (!/^(\*|[a-z][a-z0-9_]*(\.[a-z0-9_]+)*)$/.test(form.category.trim())) {
    return 'Name an alert family such as ops.failing, or * for every family.';
  }
  if (form.channel === 'console') return form.addressRef.trim() ? 'The console takes no address.' : null;
  const ref = form.addressRef.trim();
  if (ref.includes('@') || ref.includes('://')) {
    return 'Enter the NAME of the environment variable that holds the address, never the address itself.';
  }
  if (!ADDRESS_REF_PATTERN.test(ref)) return 'Use an environment variable name starting ALERT_, for example ALERT_ONCALL_EMAIL.';
  return null;
}

/**
 * Whether the export control is offered: the export is an operator-wide
 * grant, so a branch-scoped one would only ever be refused.
 */
export function canExportActivity(permissions: ReadonlyArray<{ permission: string; scopeType?: string | null }>): boolean {
  return permissions.some((p) => p.permission === 'console:activity:export' && (p.scopeType ?? 'operator') === 'operator');
}
