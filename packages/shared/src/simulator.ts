import { z } from 'zod';
import { ButtonPressSchema, ScanInputSchema } from './scanning';

/**
 * The simulator control plane (S2-06): what the Console's Simulators panel can
 * ask a box to pretend.
 *
 * **It travels as one `edge.box_command` of kind `simulate`, not as eight
 * command kinds.** The command vocabulary is a CHECK constraint, so every new
 * kind is a migration; the simulator grows with every device ticket left in the
 * sprint — the gate, the terminals, the kiosk — and a vocabulary that needs a
 * migration per addition is a vocabulary people work around. The discrimination
 * lives in the payload, where it is a zod union that costs nothing to extend.
 * `edge.sync_event.type` was left un-CHECKed for the same reason.
 *
 * Every action carries an `actionId`, because the acceptance criterion is that
 * a simulator call shows up as a device log line WITH its action id and again
 * in the next heartbeat's aggregates — which is only possible if the id is
 * minted where the person pressed the button and carried the whole way.
 */

/** The faults a printer simulator can be put into, from the real status bytes. */
export const PRINTER_FAULTS = [
  /** `DLE EOT` reports no paper; the job queues and the header indicator turns red. */
  'paper_out',
  /** Paper low. The job still prints. */
  'paper_low',
  'cover_open',
  /** The cutter jammed — reported, and not cleared by feeding paper. */
  'cutter_error',
  /** Nothing answers on TCP 9100. Different from a printer that answers and refuses. */
  'unreachable',
] as const;
export type PrinterFault = (typeof PRINTER_FAULTS)[number];

const WithAction = { actionId: z.string().max(64).optional() };

/**
 * One simulator instruction.
 *
 * `printer.fault` sets a fault and `printer.clear` removes every fault from a
 * device — "clear the paper" is one gesture at the machine, not a list of
 * faults to untick.
 */
export const SimulatorActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('printer.fault'),
    deviceId: z.string().uuid(),
    fault: z.enum(PRINTER_FAULTS),
    ...WithAction,
  }),
  z.object({
    action: z.literal('printer.clear'),
    deviceId: z.string().uuid(),
    ...WithAction,
  }),
  /** Deliver a code to the scanning service exactly as a real scanner would. */
  z.object({
    action: z.literal('scanner.scan'),
    deviceId: z.string().uuid().optional(),
    input: ScanInputSchema,
    ...WithAction,
  }),
  /** Press the physical counter button. */
  z.object({
    action: z.literal('button.press'),
    deviceId: z.string().uuid().optional(),
    press: ButtonPressSchema,
    ...WithAction,
  }),
  /**
   * Present a staff badge or type a PIN at the station.
   *
   * The value is a credential on its way to an authentication path, so it is
   * carried and never stored: the box hands it straight to the handler, and
   * the tape gets the outcome. Nothing in this union may be written to
   * `edge.box_command.payload` as it stands — see the note below.
   */
  z.object({
    action: z.literal('badge.present'),
    stationId: z.string().uuid(),
    badge: z.string().min(1).max(256),
    ...WithAction,
  }),
  z.object({
    action: z.literal('pin.enter'),
    stationId: z.string().uuid(),
    pin: z.string().min(1).max(32),
    ...WithAction,
  }),
]);
export type SimulatorAction = z.infer<typeof SimulatorActionSchema>;

/**
 * Which actions carry a secret in their payload.
 *
 * `edge.box_command.payload` is a stored jsonb column that the Console's
 * command history renders, so a badge value or a PIN written into it straight
 * would sit in the database and on a web page. These two actions must be
 * delivered on the station channel rather than through the command queue, or
 * have their value stripped before the row is written. The list is here so the
 * decision is made once, by name, instead of being remembered at each call
 * site.
 */
export const SIMULATOR_ACTIONS_WITH_SECRETS: readonly SimulatorAction['action'][] = [
  'badge.present',
  'pin.enter',
];

/** The `payload` of an `edge.box_command` with `kind = 'simulate'`. */
export const SimulateCommandPayloadSchema = z.object({
  action: SimulatorActionSchema,
});
export type SimulateCommandPayload = z.infer<typeof SimulateCommandPayloadSchema>;
