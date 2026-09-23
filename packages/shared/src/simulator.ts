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

/**
 * The six answers a card terminal can be made to give (S2-10a).
 *
 * The words are the ticket's own, and each names a branch of the acceptance:
 * `partial` is an approval for less than was asked (GHL response `10`; Digio
 * has no partial code, so its simulator answers `100` with an amount tag below
 * the request, which drives the same refuse-and-void branch), `no_response`
 * writes nothing back at all, and `inquiry_unavailable` also refuses the
 * follow-up QUERY — which is a NEXGO card sale's permanent state, not a fault.
 */
export const TERMINAL_OUTCOMES = [
  'approved',
  'declined',
  'partial',
  'no_response',
  'inquiry_unavailable',
  'timeout',
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * The five buttons on the gateway simulator panel (S2-10a).
 *
 * `late_paid` is a payment that arrives after the attempt expired or was
 * cancelled — 2C2P's `5017` — and it is here because it is the case the park
 * will actually meet: a guest who pays the QR after reception gave up and took
 * cash. `suppress_webhook` is the absence of a notification, so that the
 * inquiry poller is demonstrated rather than assumed.
 *
 * DIFFERENT FROM THE TICKET'S OWN SKETCH, which named five actions —
 * `gateway.paid`, `gateway.decline`, `gateway.expire`, `gateway.late_paid`,
 * `gateway.suppress_webhook`. They are one action with this enum instead,
 * because all five take the same two arguments (which attempt, and what
 * happens to it) and a discriminated union of five members that differ only in
 * their literal is five schemas, five branches in the handler and five entries
 * in every list of action names. The panel still draws five buttons. Anything
 * reading for a `gateway.*` action name will not find one: read
 * `action === 'gateway.event'` and switch on `event`.
 */
export const GATEWAY_EVENTS = [
  'paid',
  'decline',
  'expire',
  'late_paid',
  'suppress_webhook',
] as const;
export type GatewayEvent = (typeof GATEWAY_EVENTS)[number];

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
  /**
   * What the card terminal does with the NEXT sale sent to it (S2-10a).
   *
   * Six outcomes, and every one of them is an acceptance criterion rather than
   * a convenience: approved and declined are the two the till already draws,
   * `partial` is the one that must be refused and voided, `no_response` is what
   * makes the till block and the inquiry rule run, `inquiry_unavailable` is the
   * permanent state of a NEXGO card sale (the dialect has no card QUERY) and is
   * what puts the audited staff-confirmation dialog on the screen, and
   * `timeout` is Digio's `401`.
   *
   * It sets a state on the simulated terminal rather than answering a live
   * sale: the outcome has to be chosen BEFORE the tender is sent, because a
   * simulator that answered a question it was asked after the fact could not
   * reproduce "no final response" at all.
   */
  z.object({
    action: z.literal('terminal.outcome'),
    deviceId: z.string().uuid(),
    outcome: z.enum(TERMINAL_OUTCOMES),
    /** For `partial`: what the terminal approves instead of what was asked. */
    approvedSatang: z.number().int().min(0).optional(),
    /**
     * The approval code the terminal prints. Optional — the simulator mints one
     * when it is not given — and it is why this action is on
     * `SIMULATOR_ACTIONS_WITH_SECRETS`.
     */
    approvalCode: z.string().min(1).max(12).optional(),
    ...WithAction,
  }),
  /**
   * Move the simulated terminal's own clock, which is what makes the void
   * windows real: a GHL card void is refused after settlement and a wallet void
   * after 23:00 (vendor PDF p.15), and Digio answers `205` "already settled".
   * None of those can be demonstrated without a clock somebody can push.
   */
  z.object({
    action: z.literal('terminal.advance_clock'),
    deviceId: z.string().uuid(),
    minutes: z.number().int().min(1).max(60 * 24 * 7),
    ...WithAction,
  }),
  /**
   * What the QR GATEWAY does next (S2-10a, Slice D).
   *
   * Not a device action: it has no `deviceId` because there is no box in the
   * path — a 2C2P QR is minted by the api and paid in somebody's banking app.
   * Each of these posts a synthetic notification, signed with the configured
   * secret, to the real webhook route, so the production path is what the demo
   * exercises. `suppress_webhook` sends nothing at all, which is how the
   * inquiry poller — the safety net that must work when 2C2P's callback does
   * not arrive — is shown to work.
   */
  z.object({
    action: z.literal('gateway.event'),
    /** The attempt to act on. The panel offers the ones still awaiting payment. */
    attemptId: z.string().uuid(),
    event: z.enum(GATEWAY_EVENTS),
    ...WithAction,
  }),
]);
export type SimulatorAction = z.infer<typeof SimulatorActionSchema>;

/**
 * Which actions carry a secret in their payload.
 *
 * `edge.box_command.payload` is a stored jsonb column that the Console's
 * command history renders, so a badge value or a PIN written into it straight
 * would sit in the database and on a web page. These actions must be
 * delivered on the station channel rather than through the command queue, or
 * have their value stripped before the row is written. The list is here so the
 * decision is made once, by name, instead of being remembered at each call
 * site.
 *
 * `terminal.outcome` joins them for S2-10a: it can carry the approval code the
 * simulated terminal will print, and an approval code in a stored command
 * payload is the same mistake as a PIN there. `services/fleet.ts:1605-1611`
 * refuses every action on this list at the command queue, which is what makes
 * the station channel the only way it can travel.
 */
export const SIMULATOR_ACTIONS_WITH_SECRETS: readonly SimulatorAction['action'][] = [
  'badge.present',
  'pin.enter',
  'terminal.outcome',
];

/** The `payload` of an `edge.box_command` with `kind = 'simulate'`. */
export const SimulateCommandPayloadSchema = z.object({
  action: SimulatorActionSchema,
});
export type SimulateCommandPayload = z.infer<typeof SimulateCommandPayloadSchema>;
