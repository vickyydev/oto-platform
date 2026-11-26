import { z } from 'zod';
import { GateMessagesReadSchema, GateMessagesWriteSchema } from '@oto/shared';
import type { App } from '../app';
import { assertBranchInOperator, readGateMessages, saveGateMessages } from '../services/gate-messages';
import { opCtx, withTx } from '../services/tx';

const BranchParams = z.object({ branchId: z.string().uuid() });

/**
 * SCRUM-1078 — the Console's "Gate messages": what the gate readers at one
 * park say for each case and language. Administrators only, by the
 * permissions themselves (`admin:gate_message:*` are in no staff bundle).
 * The texts reach the park's gate box in its config bundle (`configBundle`
 * in `services/box.ts`) on its next refresh.
 */
export async function gateMessageRoutes(app: App): Promise<void> {
  app.get(
    '/branches/:branchId/gate-messages',
    {
      config: { permission: 'admin:gate_message:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'What the gate readers at this park show for each case and language: the built-in wording with the park’s changes over it, the built-in wording itself, and the ordered languages shown.',
        params: BranchParams,
        response: { 200: GateMessagesReadSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await assertBranchInOperator(app.db, auth.operatorId, req.params.branchId);
      return readGateMessages(app.db, req.params.branchId);
    },
  );

  app.put(
    '/branches/:branchId/gate-messages',
    {
      config: { permission: 'admin:gate_message:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Make this park’s gate wording what the body says. Texts are cleaned (control characters other than line breaks removed) and limited to 200 characters, labels to 40; an entry equal to the built-in wording is not stored, so sending the default back resets it. Wording only: nothing here changes whether a gate opens. Audited as gate_message.update.',
        params: BranchParams,
        body: GateMessagesWriteSchema,
        response: { 200: GateMessagesReadSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await assertBranchInOperator(app.db, auth.operatorId, req.params.branchId);
      return withTx(app.db, opCtx(req), 'gate_message.update', (tx) =>
        saveGateMessages(tx, {
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          accountId: auth.accountId,
          requestId: req.id,
          body: req.body,
        }),
      );
    },
  );
}
