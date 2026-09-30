import { useState } from 'react';
import { Clock, CreditCard, Loader2 } from 'lucide-react';
import { TERMINAL_OUTCOMES, type TerminalOutcome } from '@oto/shared';
import { isMissingRoute, type DeviceRow } from '@/api/fleet';
import { simulatorApi } from '@/components/devices/simulatorApi';
import { Button } from '@/components/ui/button';
import { RouteUnavailable } from '@/components/Panel';
import { CardShell } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Field, NumberInput, Select } from '@/components/Form';
import { StatusPill } from '@/components/Status';

/**
 * WHAT THE CARD TERMINAL DOES NEXT (S2-10a, SCRUM-206).
 *
 * WHAT IT IS FOR. Every one of these is an acceptance criterion of the tender
 * ticket rather than a convenience, and not one of them can be rehearsed by
 * doing something to a real EDC in Phuket from here: a host that declines, a
 * host that approves less than was asked, a terminal that says nothing at all
 * and leaves a till blocked while a guest stands there. Each button puts a
 * SIMULATED terminal into exactly the state a real one reports, so the
 * platform's answer to it — a void, an inquiry, the audited confirmation
 * dialog — can be watched end to end.
 *
 * ONE PRESS, ONE ACTION, and the state is set BEFORE the tender is sent. A
 * simulator that was asked after the fact what it had done could not reproduce
 * "no final response" at all, which is the one outcome the whole inquiry rule
 * exists for. So the setting sticks until it is changed, and the panel says so.
 *
 * SIMULATED DEVICES ONLY, and that is not a limitation to work around: a real
 * NEXGO cannot be asked to pretend its host timed out. A terminal is simulated
 * when its device row carries the `simulated` transport, which is what both of
 * the park's seeded EDCs carry today.
 *
 * WHY IT DOES NOT RIDE THE COMMAND QUEUE like the printer faults beside it.
 * `terminal.outcome` can carry the approval code the terminal will print, and
 * a command payload is a stored jsonb column rendered as history on this page
 * — the same reason a badge and a PIN have no buttons on the Simulators panel.
 * `@oto/shared` names it in `SIMULATOR_ACTIONS_WITH_SECRETS` and the platform
 * refuses it at the queue; this posts to `/payments/terminal-simulator`, which
 * carries the value to the agent and keeps none of it. The consequence, said
 * plainly below rather than hidden: it only reaches terminals on a box the api
 * is running itself.
 */

/**
 * The six answers, in the order somebody reaches for them, with what each one
 * is for. Typed as a `Record` over the union in `@oto/shared` rather than a
 * list, so an outcome added or renamed there fails this file at the keyboard
 * instead of quietly dropping a button.
 */
const OUTCOMES: Record<TerminalOutcome, { label: string; detail: string }> = {
  approved: {
    label: 'Approve',
    detail: 'The host approves the full amount. The tender settles and the till can close the sale.',
  },
  declined: {
    label: 'Decline',
    detail:
      'The host says no — `05 Do not honor` on a card. Nothing is taken and the till offers the methods again.',
  },
  partial: {
    label: 'Approve less',
    detail:
      'The terminal approves less than was asked. The platform cannot take the difference, so the sale is refused and the tender is voided on a fresh reference.',
  },
  no_response: {
    label: 'Say nothing',
    detail:
      'No answer at all inside the two-minute budget. Whether the money moved is unknown: the till blocks and the inquiry rule runs — and on a NEXGO card there is no inquiry, so it goes to a person.',
  },
  inquiry_unavailable: {
    label: 'Refuse the inquiry',
    detail:
      'No answer, and no answer to the follow-up either. The tender ends awaiting a staff confirmation, which is what a person reading the terminal’s own screen then settles.',
  },
  timeout: {
    label: 'Host timeout',
    detail:
      'The terminal answers, and what it says is that its own host did not answer IT (Digio `401`). Unknown, but a known unknown — the terminal is alive and can be asked.',
  },
};

/** The order the buttons are drawn in, which is not the order of the union. */
const ORDER: TerminalOutcome[] = [
  'approved',
  'declined',
  'partial',
  'no_response',
  'inquiry_unavailable',
  'timeout',
];

/** How the two dialects are spelled on a device row, and what to call them. */
const DIALECT: Record<string, string> = {
  ghl_linkpos: 'GHL LinkPOS',
  digio_tlv: 'Digio',
};

export function isTerminal(row: DeviceRow): boolean {
  return row.protocol === 'ghl_linkpos' || row.protocol === 'digio_tlv';
}

export function TerminalSimulatorPanel({
  devices,
  canCommand,
}: {
  /** Every device on this branch's boxes. Filtered here, so the page need not know what a terminal is. */
  devices: DeviceRow[];
  canCommand: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  /** What each terminal was last told to do, so the panel can say it is still set. */
  const [set, setSet] = useState<Record<string, TerminalOutcome>>({});

  const terminals = devices.filter((d) => !d.archived && isTerminal(d) && d.transport === 'simulated');

  const send = async (
    key: string,
    action: Parameters<typeof simulatorApi.terminal>[0],
    said: string,
  ) => {
    setBusy(key);
    setNote(null);
    setFailed(null);
    try {
      await simulatorApi.terminal(action);
      setNote(said);
      if (action.action === 'terminal.outcome') {
        setSet((held) => ({ ...held, [action.deviceId]: action.outcome }));
      }
    } catch (err) {
      if (isMissingRoute(err)) setMissing(true);
      else setFailed(err instanceof Error ? err.message : 'That could not be sent');
    } finally {
      setBusy(null);
    }
  };

  return (
    <CardShell
      span={12}
      icon={CreditCard}
      title="Card terminals"
      note="what a simulated EDC does with the next tender sent to it"
    >
      {missing ? (
        <RouteUnavailable
          what="The terminal simulator"
          detail="This deployment's API has no tender surface yet."
        />
      ) : terminals.length === 0 ? (
        <EmptyNote
          className="py-3"
          title="No simulated card terminal on this branch"
          detail="A terminal is simulated when its device row carries the simulated transport. A real EDC cannot be asked to pretend its host timed out."
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            The setting is chosen <span className="font-semibold">before</span> a tender is sent and
            stays until it is changed — a terminal asked after the fact what it had done could not
            reproduce “no answer at all”, which is the case the whole inquiry rule exists for. These
            do not ride the command queue: an approval code is a value to carry, not one to store in
            a command payload this page renders, so they reach the box this api is running and no
            other.
          </p>

          <ul className="flex flex-col divide-y divide-card-border rounded-[14px] border border-card-border">
            {terminals.map((terminal) => (
              <TerminalRow
                key={terminal.id}
                terminal={terminal}
                chosen={set[terminal.id] ?? null}
                busy={busy}
                disabled={!canCommand}
                onOutcome={(outcome, approvedSatang) =>
                  void send(
                    `${terminal.id}:${outcome}`,
                    {
                      action: 'terminal.outcome',
                      deviceId: terminal.id,
                      outcome,
                      ...(outcome === 'partial' && approvedSatang !== null
                        ? { approvedSatang }
                        : {}),
                    },
                    `${terminal.label} will ${OUTCOMES[outcome].label.toLowerCase()} the next tender.`,
                  )
                }
                onAdvanceClock={(minutes) =>
                  void send(
                    `${terminal.id}:clock`,
                    { action: 'terminal.advance_clock', deviceId: terminal.id, minutes },
                    `${terminal.label}’s own clock moved on ${minutes} minutes.`,
                  )
                }
              />
            ))}
          </ul>

          {!canCommand && (
            <p className="text-sm text-muted-foreground">
              Sending any of these needs <span className="font-mono text-xs">admin:box:command</span>
              , which this account does not hold at this branch.
            </p>
          )}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
          {failed && <p className="text-sm text-destructive break-words">{failed}</p>}
        </>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------

function TerminalRow({
  terminal,
  chosen,
  busy,
  disabled,
  onOutcome,
  onAdvanceClock,
}: {
  terminal: DeviceRow;
  chosen: TerminalOutcome | null;
  busy: string | null;
  disabled: boolean;
  onOutcome: (outcome: TerminalOutcome, approvedSatang: number | null) => void;
  onAdvanceClock: (minutes: number) => void;
}) {
  /**
   * What "approve less" approves, in BAHT on the screen and satang on the wire.
   *
   * Empty means "a baht less than was asked", which the simulator works out
   * for itself — the common case, and the one the plant in
   * `payments-terminal.test.ts` uses.
   */
  const [approvedBaht, setApprovedBaht] = useState<number | null>(null);
  const [minutes, setMinutes] = useState('60');

  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="font-semibold text-sm">{terminal.label}</span>
        <span className="text-xs text-muted-foreground">
          {DIALECT[terminal.protocol ?? ''] ?? terminal.protocol}
          {terminal.model ? ` · ${terminal.model}` : ''}
        </span>
        {terminal.terminalId && (
          <span className="text-xs text-muted-foreground font-mono">TID {terminal.terminalId}</span>
        )}
        {chosen && <StatusPill tone="warn">next: {OUTCOMES[chosen].label}</StatusPill>}
      </div>

      <div className="flex flex-wrap gap-2">
        {ORDER.map((outcome) => (
          <Button
            key={outcome}
            variant="outline"
            size="sm"
            className="gap-1.5"
            title={OUTCOMES[outcome].detail}
            disabled={disabled || busy !== null}
            onClick={() =>
              onOutcome(outcome, approvedBaht === null ? null : Math.round(approvedBaht * 100))
            }
          >
            {busy === `${terminal.id}:${outcome}` ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CreditCard className="w-3.5 h-3.5" />
            )}
            {OUTCOMES[outcome].label}
          </Button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="Approve this much instead (฿)"
          hint="Used by “Approve less”. Left empty, the terminal approves a baht less than it was asked for."
        >
          <NumberInput value={approvedBaht} onChange={setApprovedBaht} min={0} />
        </Field>
        <Field
          label="Advance this terminal’s clock (minutes)"
          hint="A card must be voided before settlement and a wallet before 11PM. Pushing the clock past the terminal’s own day end is the only way to see either refusal."
        >
          <div className="flex gap-2">
            <Select
              value={minutes}
              onChange={setMinutes}
              options={[
                { value: '60', label: 'One hour' },
                { value: '720', label: 'Twelve hours' },
                { value: '1440', label: 'A day' },
              ]}
            />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 shrink-0"
              disabled={disabled || busy !== null}
              onClick={() => onAdvanceClock(Number(minutes))}
            >
              {busy === `${terminal.id}:clock` ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Clock className="w-3.5 h-3.5" />
              )}
              Advance
            </Button>
          </div>
        </Field>
      </div>
    </li>
  );
}

/** Every outcome the platform knows has a button, and nothing here invents one. */
export const TERMINAL_OUTCOME_COUNT = TERMINAL_OUTCOMES.length;
