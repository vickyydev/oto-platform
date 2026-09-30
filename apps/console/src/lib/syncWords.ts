/**
 * The sync ledger's vocabulary, in the words somebody on call would use.
 *
 * Every row on the Quarantine tab is a fact from a till that the cloud refused
 * to file, and the person reading it at nine on a Saturday is deciding whether
 * the park has lost something. `signature_invalid` tells them nothing;
 * "it was not signed by the box it says it came from" tells them what to do
 * next. So each reason carries four things: what to call it, what happened,
 * what pressing Replay will do, and what pressing Discard will do — because
 * the consequence of the two buttons differs per reason and getting that wrong
 * is how a sale disappears.
 *
 * The keys are typed against `@oto/shared`'s unions, so a reason added to the
 * database CHECK and to that vocabulary fails this file's typecheck until
 * somebody writes the sentence a reader needs. A blank is not an option here:
 * an unexplained refusal reads as a platform fault when it is usually a park
 * fact waiting on a decision.
 */
import type { SyncAnomalyKind, SyncQuarantineReason } from '@oto/shared';
import type { Tone } from '@/components/Status';

function tidy(value: string): string {
  return value.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export interface QuarantineWords {
  /** What to call it in a list, in plain words rather than in the column's. */
  label: string;
  /** What happened, in one sentence. */
  what: string;
  /** What pressing Replay does, and whether it can work as things stand. */
  replay: string;
  /** What pressing Discard does, said as a consequence. */
  discard: string;
  /**
   * False when replaying cannot succeed until something ELSE changes — a
   * deploy, a rotated key, a decision about which of two facts is true. The
   * button stays there (the person on call may know something this page does
   * not), but it says so first rather than letting somebody press it eleven
   * times.
   */
  replayCanWork: boolean;
}

const REASONS: Record<SyncQuarantineReason, QuarantineWords> = {
  conflict: {
    label: 'Two facts, one id',
    what: 'The cloud already holds an event with this id and different contents, so it refused the second copy rather than choosing between them.',
    replay:
      'Tries to file it again. It will be refused the same way unless the stored event has changed since — so read both payloads first and decide which one is what actually happened at the counter.',
    discard:
      'Keeps what the cloud already has and marks this copy dealt with. Nothing on the box or the till changes.',
    replayCanWork: false,
  },
  poison: {
    label: 'Could not be read',
    what: 'The payload did not parse, or it failed validation before any business rule saw it.',
    replay:
      'Puts the same bytes through the same reader, so it fails the same way unless the fault was in something it pointed at.',
    discard:
      'Drops it. Whatever it recorded is then lost to the platform, so read the payload and check whether that sale or that person has to be entered again by hand.',
    replayCanWork: false,
  },
  epoch_regressed: {
    label: 'From a store that was reset',
    what: 'The box has been given a new journal epoch since this event was minted, so filing it would mix two lifetimes of one box.',
    replay:
      'Refused the same way: the epoch is part of the event and cannot be edited from here.',
    discard:
      'Correct when the reset was deliberate. Check with whoever reset the box that nothing from before the reset was still owed — the reset is refused while the outbox has anything in it, so this normally means an old batch arrived late.',
    replayCanWork: false,
  },
  sequence_gap: {
    label: 'An earlier event is missing',
    what: "This box's sequence jumped, so filing this event would put a later fact in front of one that has not arrived.",
    replay:
      'Works once the missing event lands. The box resends on its own, so the usual answer is to wait a minute and look again.',
    discard:
      'Marks it dealt with and leaves the gap. Only right when the missing event is known to be gone for good.',
    replayCanWork: true,
  },
  unknown_type: {
    label: 'A kind of event this cloud does not know',
    what: 'The box is running an agent that mints an event type this API has never heard of.',
    replay:
      'Works as soon as the API that understands it is deployed here. Leave it until then rather than pressing it now.',
    discard:
      'Throws away a fact this platform could file after the next deploy. Almost never the right button for this reason.',
    replayCanWork: true,
  },
  schema_too_new: {
    label: 'A newer shape than this cloud reads',
    what: 'The event carries a schema version above what this API supports, so it was kept whole rather than read with half the fields understood.',
    replay: 'Works after the API is upgraded. Same as above: leave it until then.',
    discard: 'Throws away a fact a later deploy could file. Rarely right.',
    replayCanWork: true,
  },
  actor_unknown: {
    label: 'The person or device on it is unknown here',
    what: 'The account, credential or station named on the event does not exist in the cloud — typically a box that has been away a long time, or a row archived while it was gone.',
    replay:
      'Works once that account, credential or station exists again. Restoring the archived row is usually the fix.',
    discard:
      'Loses what the event recorded. Worth checking who it names before pressing it — a member created by somebody who has since left is still a member.',
    replayCanWork: true,
  },
  signature_invalid: {
    label: 'Not signed by the box it claims',
    what: "The signature did not verify against that box's registered key. Either the box's key was rotated without the cloud being told, or the event did not come from that box.",
    replay:
      'Checked again on every attempt, so it is refused the same way until the key is right. A run of these is a security question, not a sync fault.',
    discard:
      'Marks it dealt with. Do not discard a run of these quietly — the pattern is the thing worth keeping.',
    replayCanWork: false,
  },
  apply_failed: {
    label: 'Read, but would not file',
    what: 'The event parsed and the rule that files it raised an error — a row it referred to was missing, or a constraint refused it.',
    replay:
      'Worth one attempt once whatever it referred to exists. The error below says what that was.',
    discard: 'Drops the fact. Read the error first: most of these are fixable.',
    replayCanWork: true,
  },
};

/**
 * The reasons as a filter offers them, in the plain words rather than the
 * column's. Derived from the table above so the filter cannot list a reason
 * the page has no sentence for.
 */
export const QUARANTINE_REASON_OPTIONS: Array<{ value: string; label: string }> = Object.entries(
  REASONS,
).map(([value, words]) => ({ value, label: words.label }));

export function quarantineWords(reason: string): QuarantineWords {
  return (
    REASONS[reason as SyncQuarantineReason] ?? {
      label: tidy(reason),
      what: 'This console has not been taught what this refusal means. The error and the payload below are the whole of what the ledger recorded.',
      replay: 'Puts the stored event back through the ledger as the box sent it.',
      discard: 'Marks it dealt with without filing it.',
      replayCanWork: true,
    }
  );
}

/**
 * An open refusal is red and a settled one is grey.
 *
 * Neither `replayed` nor `discarded` is amber: both are somebody's decision,
 * already taken, and painting a finished decision as "needs attention" teaches
 * a reader to skip the colour that means a fact from the park is still sitting
 * unfiled.
 */
export function toneForQuarantineStatus(status: string): Tone {
  switch (status) {
    case 'open':
      return 'down';
    case 'replayed':
      return 'ok';
    case 'discarded':
      return 'idle';
    default:
      return 'idle';
  }
}

export function quarantineStatusWord(status: string): string {
  switch (status) {
    case 'open':
      return 'Waiting on a decision';
    case 'replayed':
      return 'Filed on a replay';
    case 'discarded':
      return 'Discarded';
    default:
      return tidy(status);
  }
}

export interface AnomalyWords {
  label: string;
  what: string;
}

/**
 * Anomalies are things that WERE filed, with a caveat worth keeping. Every
 * sentence here says so, because the tab they share with the quarantine list
 * would otherwise read as a second pile of work.
 */
const ANOMALIES: Record<SyncAnomalyKind, AnomalyWords> = {
  clock_recomputed: {
    label: 'The trading day came from our clock',
    what: "The box's clock could not be trusted, so the day this was counted against was worked out from when it arrived rather than from when the box said it happened. Both dates are on the row.",
  },
  duplicate_replay: {
    label: 'A batch arrived twice',
    what: 'Every event in it was already filed, so nothing was written a second time. This is what a retry looks like from the cloud, and it is the proof the ledger is doing its job.',
  },
  sequence_gap: {
    label: 'A journal position that never arrived',
    what: 'This box sent an event from beyond a position nothing has ever reached us for, so the numbering skipped. Each skipped position is named once, on the push that first stepped over it — the pushes after it stand above the same hole and add nothing. The row carries what the cloud found and how far it looked; a position beyond that was never examined. Nothing catches up on a timer: if the missing events arrive the cursor moves over them on this box’s next push, a window at a time. While they do not, the cursor cannot move past the hole, and Health’s stalled-cursor warning is the standing sign of that.',
  },
  merge: {
    label: 'The same person entered at two tills',
    what: 'Two boxes each created the same phone number while they were offline. One person exists in the end, and both events are kept so it is clear where each detail came from.',
  },
  epoch_regressed: {
    label: 'An event from a store that had been reset',
    what: 'Recorded against the box so a reset that lost something is visible afterwards rather than only in the moment.',
  },
  late_arrival: {
    label: 'Filed long after it happened',
    what: 'A box that had been away for a while. The fact is filed against the day it actually happened, not the day it arrived — this row is why the two differ.',
  },
  receipt_collision: {
    label: 'A printed receipt number was already taken',
    what: 'A counter printed this number while it was offline, and by the time the sale arrived the number had been used in the station’s series. The sale is filed under the next free number; both numbers are on the row, because a guest is holding the first.',
  },
  revoked_actor: {
    label: 'Taken on a shift that had been ended',
    what: 'The shift token this sale was taken on had been revoked before the sale happened. The sale is filed, because it happened, and an alert asks somebody to look at who was at the counter.',
  },
};

export function anomalyWords(kind: string): AnomalyWords {
  return (
    ANOMALIES[kind as SyncAnomalyKind] ?? {
      label: tidy(kind),
      what: 'The event was filed. This console has not been taught what this caveat means; the detail below is what the ledger recorded.',
    }
  );
}

export interface AnomalyFact {
  label: string;
  value: string;
}

/** Enough to explain a row; past this it is a wall of text on one line. */
const MAX_FACTS = 6;

/** `survivingMemberId` → `Surviving member id`. */
function words(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * One value, if it is the kind of thing that belongs on a line of a list.
 *
 * Nested objects are skipped rather than stringified: an anomaly's detail is
 * ids, counts and dates by the API's own rule, so anything deeper is something
 * this was not written for, and a `[object Object]` on the page is worse than
 * the absence of it.
 */
function factValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  if (Array.isArray(value)) {
    const shown = value.filter((v) => typeof v === 'number' || typeof v === 'string').slice(0, 8);
    if (shown.length === 0) return null;
    const rest = value.length - shown.length;
    return shown.join(', ') + (rest > 0 ? ` +${rest} more` : '');
  }
  return null;
}

/**
 * What an anomaly's `detail` says, as short labelled pairs.
 *
 * The cloud records the thing that makes a row understandable months later —
 * the two candidate trading days behind a recomputed clock, the journal
 * positions that never arrived and how far it looked for them, the two member
 * ids a merge reconciled — and the panel used to fetch all of it and draw none
 * of it, so every row read as a category with no evidence under it. The
 * sentences above even promise otherwise: "Both dates are on the row."
 *
 * Nothing personal is in a detail: the API records names, counts and states and
 * never a value, and `GET /ops/anomalies` holds the same line on the way out.
 */
export function anomalyFacts(detail: Record<string, unknown> | null | undefined): AnomalyFact[] {
  if (!detail) return [];
  const facts: AnomalyFact[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (facts.length >= MAX_FACTS) break;
    const text = factValue(value);
    if (text === null) continue;
    facts.push({ label: words(key), value: text });
  }
  return facts;
}
