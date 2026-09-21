import { useState } from 'react';
import { Loader2, ScanLine, Zap } from 'lucide-react';
import type { PrinterFault, SimulatorAction } from '@oto/shared';
import { isMissingRoute, type BoxRow, type DeviceRow } from '@/api/fleet';
import { simulatorApi } from '@/components/devices/simulatorApi';
import { Button } from '@/components/ui/button';
import { EmptyState, Loading, RouteUnavailable, StaleNote, Unreadable } from '@/components/Panel';
import { Field, Select, TextInput } from '@/components/Form';
import { StatusPill } from '@/components/Status';
import type { BoxDeviceList } from '@/lib/deviceList';
import { deviceKindWord, toneForPaper, toneForReachability } from '@/lib/fleetWords';

/**
 * Making a box's devices misbehave on purpose.
 *
 * WHAT THIS IS FOR. Every fault the park will actually meet — a receipt roll
 * that ran out mid-queue, a printer somebody unplugged, a cover left open
 * after a paper change — has to be rehearsed before it happens on a Saturday,
 * and it cannot be rehearsed by breaking real hardware in Phuket from here.
 * These buttons put a simulated device into exactly the state the real one
 * reports, so the till's red indicator, the queued job and the alert can be
 * watched from end to end.
 *
 * SIMULATED DEVICES ONLY, and that is not a limitation to work around: asking
 * a real Xprinter to pretend it is out of paper is not a thing a printer can
 * do. A box's simulated devices are the ones declared with the `simulated`
 * transport.
 *
 * HOW IT TRAVELS. One queued `box_command` per press, like every other control
 * on this drawer, so a box that is asleep or offline collects its instructions
 * when it wakes — and so every press is already in the command history with
 * its action id beside it.
 */

/**
 * The faults a printer can be put into, in the order somebody reaches for
 * them. Typed as a `Record` over the union in `@oto/shared` rather than a
 * list, so a fault added or renamed there fails this file at the keyboard
 * instead of quietly dropping a button.
 */
const PRINTER_FAULTS: Record<PrinterFault, { label: string; detail: string }> = {
  paper_out: {
    label: 'Paper out',
    detail: 'The printer answers and reports no paper. Jobs queue rather than fail.',
  },
  paper_low: {
    label: 'Paper low',
    detail: 'Reported, and the job still prints. The warning is the whole event.',
  },
  cover_open: {
    label: 'Cover open',
    detail: 'What a paper change leaves behind when nobody closes the lid.',
  },
  cutter_error: {
    label: 'Cutter jammed',
    detail: 'Reported, and feeding paper does not clear it — somebody has to open the machine.',
  },
  unreachable: {
    label: 'Unreachable',
    detail: 'Nothing answers on its port. Different from a printer that answers and refuses.',
  },
};

/**
 * The same test the agent applies when it decides which devices get a
 * simulator (`packages/box-agent/src/printing/index.ts`, `printerDevices`):
 * a kind that ends in `printer`. Written the same way rather than as a list of
 * the four kinds there are today, so a fifth printer kind appears here and on
 * the box together instead of in one of them.
 */
const isPrinter = (kind: string): boolean => kind.endsWith('printer');

/**
 * What the counter's USB button sends, when nobody has said otherwise.
 *
 * This is what THIS PANEL sends, not a reading of the device's configured
 * key: the Console's device rows do not carry `settings` today. It is here so
 * a button press can be told apart from a scanner's Enter, which is the point
 * of the key being configurable at all — and `Enter` itself is refused below
 * for the same reason.
 */
const DEFAULT_BUTTON_KEY = 'F9';

export function SimulatorPanel({
  box,
  deviceList,
  onRetryDevices,
  canCommand,
  onSent,
}: {
  box: BoxRow;
  /**
   * The box's devices and what they are worth. "Nothing on this box is
   * simulated" is a statement about the box; it may only be made from a device
   * list that was actually read.
   */
  deviceList: BoxDeviceList;
  onRetryDevices: () => void;
  canCommand: boolean;
  onSent: (actionId?: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const simulated = deviceList.devices.filter((d) => !d.archived && d.transport === 'simulated');
  const printers = simulated.filter((d) => isPrinter(d.kind));
  const scanners = simulated.filter((d) => d.kind === 'scanner');

  const send = async (key: string, action: SimulatorAction, said: string) => {
    setBusy(key);
    setNote(null);
    setFailed(null);
    try {
      const result = await simulatorApi.send(box.id, action);
      setNote(`${said} The box takes it on its next poll.`);
      onSent(result.actionId);
    } catch (err) {
      if (isMissingRoute(err)) {
        setMissing(true);
      } else {
        setFailed(err instanceof Error ? err.message : 'That could not be queued');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h3 className="text-sm font-bold mb-2">Simulator</h3>

      {/* Which devices are simulated is a question about the device list, so
          the panel cannot answer it before the list arrives, and must not
          answer it at all when the read failed. */}
      {deviceList.state === 'stale' && deviceList.readAt !== null && (
        <StaleNote
          readAt={deviceList.readAt}
          message={deviceList.error}
          onRetry={deviceList.refreshing ? undefined : onRetryDevices}
        />
      )}

      {missing ? (
        <RouteUnavailable
          what="The simulator"
          detail="This deployment's API has no box command route yet."
        />
      ) : deviceList.state === 'unread' ? (
        <Loading what="this box's devices" />
      ) : deviceList.state === 'failed' ? (
        <Unreadable
          what="This box's devices"
          message={deviceList.error}
          onRetry={deviceList.refreshing ? undefined : onRetryDevices}
        />
      ) : simulated.length === 0 ? (
        <EmptyState
          title="Nothing on this box is simulated"
          detail="Simulation applies to devices declared with the simulated transport. A real printer cannot be asked to pretend it is out of paper."
        />
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            Each press is queued as a command, so it appears in the history above with an action id
            and the box's own log lines carry the same id — including its result, which is where to
            look when nothing seems to have happened. Faults stay set until they are cleared. A
            printer no station is using has no simulator standing on the box, and the box says so
            rather than pretending.
          </p>

          {printers.length === 0 ? (
            <EmptyState
              title="No simulated printer on this box"
              detail="Printer faults need one. The scanner below does not."
            />
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border">
              {printers.map((printer) => (
                <PrinterRow
                  key={printer.id}
                  printer={printer}
                  busy={busy}
                  disabled={!canCommand}
                  onFault={(fault) =>
                    void send(
                      `${printer.id}:${fault}`,
                      { action: 'printer.fault', deviceId: printer.id, fault },
                      `${PRINTER_FAULTS[fault].label} queued for ${printer.label}.`,
                    )
                  }
                  onClear={() =>
                    void send(
                      `${printer.id}:clear`,
                      { action: 'printer.clear', deviceId: printer.id },
                      `Clearing every fault on ${printer.label} queued.`,
                    )
                  }
                />
              ))}
            </ul>
          )}

          <ScannerControls
            scanners={scanners}
            busy={busy}
            disabled={!canCommand}
            onScan={(deviceId, code) =>
              void send(
                'scan',
                {
                  action: 'scanner.scan',
                  ...(deviceId ? { deviceId } : {}),
                  input: { code, source: 'simulator', scannedAt: new Date().toISOString() },
                },
                'Scan queued.',
              )
            }
            onButton={(deviceId, key) =>
              void send(
                'button',
                { action: 'button.press', ...(deviceId ? { deviceId } : {}), press: { key } },
                `Button “${key}” queued.`,
              )
            }
          />

          <BadgeAndPin />

          {!canCommand && (
            <p className="mt-3 text-sm text-muted-foreground">
              Sending any of these needs <span className="font-mono text-xs">admin:box:command</span>
              , which this account does not hold at this branch.
            </p>
          )}
          {note && <p className="mt-2 text-sm text-muted-foreground">{note}</p>}
          {failed && <p className="mt-2 text-sm text-destructive break-words">{failed}</p>}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function PrinterRow({
  printer,
  busy,
  disabled,
  onFault,
  onClear,
}: {
  printer: DeviceRow;
  busy: string | null;
  disabled: boolean;
  onFault: (fault: PrinterFault) => void;
  onClear: () => void;
}) {
  const faults = Object.keys(PRINTER_FAULTS) as PrinterFault[];
  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="font-semibold text-sm">{printer.label}</span>
        <span className="text-xs text-muted-foreground">{deviceKindWord(printer.kind)}</span>
        <StatusPill tone={toneForReachability(printer.reachability)}>
          {printer.reachability ?? 'unknown'}
        </StatusPill>
        <StatusPill tone={toneForPaper(printer.paperStatus)}>
          paper {printer.paperStatus ?? 'unknown'}
        </StatusPill>
      </div>
      <div className="flex flex-wrap gap-2">
        {faults.map((fault) => (
          <Button
            key={fault}
            variant="outline"
            size="sm"
            title={PRINTER_FAULTS[fault].detail}
            disabled={disabled || busy !== null}
            onClick={() => onFault(fault)}
          >
            {busy === `${printer.id}:${fault}` ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : null}
            {PRINTER_FAULTS[fault].label}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          title="Removes every fault at once — clearing a jam is one gesture at the machine, not a list to untick."
          disabled={disabled || busy !== null}
          onClick={onClear}
        >
          {busy === `${printer.id}:clear` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Clear faults
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------

function ScannerControls({
  scanners,
  busy,
  disabled,
  onScan,
  onButton,
}: {
  scanners: DeviceRow[];
  busy: string | null;
  disabled: boolean;
  onScan: (deviceId: string | null, code: string) => void;
  onButton: (deviceId: string | null, key: string) => void;
}) {
  const [deviceId, setDeviceId] = useState(scanners[0]?.id ?? '');
  const [code, setCode] = useState('');
  const [buttonKey, setButtonKey] = useState(DEFAULT_BUTTON_KEY);

  const trimmedCode = code.trim();
  const trimmedKey = buttonKey.trim();
  // The one rule about the counter button: it may be any key except the one a
  // keyboard-wedge scanner ends every code with, or a press and a scan arrive
  // indistinguishable on the same HID device.
  const keyIsEnter = /^enter$/i.test(trimmedKey) || trimmedKey === '\n';

  return (
    <div className="mt-4 rounded-xl border p-3">
      <p className="text-sm font-semibold">Scanner and counter button</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        A code typed here reaches the box's scanning service exactly as one read off a band would,
        marked as coming from the simulator. The button beside the counter is not a scan and is sent
        as its own key. Both are queued the same way as the printer faults; an agent that has no
        scanning simulator yet answers <span className="font-mono">SIMULATOR_NOT_BUILT</span> in the
        history above rather than reporting a success to nobody.
      </p>

      <div className="mt-3 flex flex-col gap-3">
        {scanners.length > 1 && (
          <Field label="Which scanner">
            <Select
              value={deviceId}
              onChange={setDeviceId}
              options={scanners.map((s) => ({ value: s.id, label: s.label }))}
            />
          </Field>
        )}

        <Field label="Code to scan">
          <TextInput value={code} onChange={setCode} placeholder="T1-0000-0000-0000" />
        </Field>
        <div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={disabled || busy !== null || trimmedCode === ''}
            onClick={() => onScan(deviceId || null, trimmedCode)}
          >
            {busy === 'scan' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ScanLine className="w-3.5 h-3.5" />
            )}
            Scan
          </Button>
        </div>

        <Field
          label="Button key"
          hint={
            keyIsEnter
              ? 'Enter is what a keyboard-wedge scanner sends at the end of every code, so the button may not use it.'
              : undefined
          }
        >
          <TextInput value={buttonKey} onChange={setButtonKey} placeholder={DEFAULT_BUTTON_KEY} />
        </Field>
        <div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={disabled || busy !== null || trimmedKey === '' || keyIsEnter}
            onClick={() => onButton(deviceId || null, trimmedKey)}
          >
            {busy === 'button' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5" />
            )}
            Press the button
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The two simulator actions this panel deliberately cannot send.
 *
 * A badge value and a PIN are credentials. Every other action here travels as
 * `edge.box_command.payload`, which is a stored jsonb column that the command
 * history a few sections up renders on this very page — so sending a PIN that
 * way would put it in the database and on a screen. `@oto/shared` names the
 * two actions in `SIMULATOR_ACTIONS_WITH_SECRETS` for exactly this reason.
 *
 * They need a path that does not store what it carries. Saying so is more
 * useful than a second route invented here.
 */
function BadgeAndPin() {
  return (
    <div className="mt-4 rounded-xl border border-dashed p-3">
      <p className="text-sm font-semibold">Staff badge and PIN</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Not sent from here. Everything above rides the command queue, whose payload is stored and
        rendered in the history on this page — and a badge number or a PIN is a credential, not a
        test input. These two need a path that carries a value without keeping it, which is still to
        be built.
      </p>
    </div>
  );
}
