import { api, idemKey } from '@/api/client';
import type { SimulatorAction } from '@oto/shared';

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
};
