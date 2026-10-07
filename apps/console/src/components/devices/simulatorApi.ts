import { api, idemKey } from '@/api/client';
import type { KioskSimulatorAnswer, KioskSimulatorControl, SimulatorAction } from '@oto/shared';

/**
 * Driving a box's device simulators from the Console.
 *
 * WHY IT IS NOT IN `src/api/fleet.ts`. The simulator rides the box command
 * queue rather than a route of its own — one `edge.box_command` of kind
 * `simulate`, with the discrimination in the payload, for the reasons
 * `packages/shared/src/simulator.ts` sets out. `fleet.ts`'s `BoxCommandKind`
 * union is the vocabulary the ordinary Controls buttons are typed against and
 * it is maintained alongside `packages/box-agent`; this keeps the simulator's
 * one extra kind here, where the panel that sends it lives, until those two
 * lists are brought together.
 *
 * THE ACTION ID IS MINTED BY THE API, not here. `POST /boxes/:id/commands`
 * answers with the `actionId` it stamped on the command row, and the agent
 * carries that id onto every log line the command produces — which is what
 * makes "show me only this test print" one press in the Box log. The optional
 * `actionId` inside `SimulatorAction` is therefore left unset: two ids for one
 * gesture is worse than one, and the id that reaches the log is the command's.
 */
export const simulatorApi = {
  /**
   * Queue one simulator instruction. Like every other control on the drawer it
   * is queued rather than sent — the box takes it on its next poll.
   */
  send: (boxId: string, action: SimulatorAction) =>
    api.post<{ commandId: string; actionId?: string | null }>(
      `/boxes/${encodeURIComponent(boxId)}/commands`,
      { kind: 'simulate', payload: { action } },
      { idempotencyKey: idemKey() },
    ),

  /**
   * The two CARD TERMINAL instructions, which cannot go through the door above
   * (S2-10a).
   *
   * `terminal.outcome` can carry the approval code the simulated terminal will
   * print, and `edge.box_command.payload` is a stored jsonb column that the
   * command history on this very page renders — so `@oto/shared` puts it on
   * `SIMULATOR_ACTIONS_WITH_SECRETS` and `services/fleet.ts` refuses it at the
   * queue. `POST /payments/terminal-simulator` is the path that carries the
   * value without keeping it, the same shape the badge and scan controls use.
   *
   * It is also NOT QUEUED: the state belongs to the simulator inside the agent,
   * so the answer is immediate and says whether it landed. A box the api does
   * not run in its own process answers `BOX_NOT_IN_THIS_PROCESS` rather than
   * reporting a success to nobody.
   */
  /**
   * S2-20 K2 — THE VIRTUAL KIOSK'S FAILURE SCREENS, at once. Its band printer
   * offline or out of paper, its box offline, or all of it cleared: applied
   * to the agent in this api's own process, like the terminal's, so a scan
   * made the next second meets the fault. Audited as `kiosk.simulate`.
   */
  kiosk: (stationId: string, control: KioskSimulatorControl) =>
    api.post<KioskSimulatorAnswer>(
      `/stations/${encodeURIComponent(stationId)}/kiosk/simulate`,
      { control },
      { idempotencyKey: idemKey() },
    ),

  terminal: (action: TerminalSimulatorAction) =>
    api.post<{ applied: boolean; deviceLabel: string; actionId: string }>(
      '/payments/terminal-simulator',
      action,
      { idempotencyKey: idemKey() },
    ),
};

/**
 * The two terminal actions, narrowed out of the shared union.
 *
 * Derived rather than restated, so an outcome added or renamed in
 * `@oto/shared` fails this file at the keyboard instead of quietly dropping a
 * button off the panel.
 */
export type TerminalSimulatorAction = Extract<
  SimulatorAction,
  { action: 'terminal.outcome' | 'terminal.advance_clock' }
>;
