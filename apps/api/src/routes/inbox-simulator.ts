import { z } from 'zod';
import { INBOX_CATEGORIES } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { scheduleOf } from '../services/inbox/ai-runtime';
import {
  playDemoScenario,
  simulateInbound,
  simulateStatus,
  simulatorAccount,
  type SimulatorDeps,
} from '../services/inbox/simulator';

/**
 * THE INBOX SIMULATOR'S DRIVE ROUTES (S2-19 I2d, SCRUM-583; plan §3.3).
 *
 *   POST /inbox/simulator/inbound    one pretend customer message
 *   POST /inbox/simulator/status     push receipts for outbound messages
 *   POST /inbox/simulator/scenario   play the demo conversations
 *
 * They exist only to make the webhook above fire, with a real signature,
 * through the real handler — the 2C2P simulator's pattern (`routes/
 * webhooks.ts`). Each press SIGNS a WhatsApp-shaped delivery with
 * `INBOX_SIMULATOR_SECRET` in this process and hands it to `ingestDelivery`;
 * nothing here writes a message itself, and the secret never reaches a
 * browser.
 *
 * GUARDED TWICE: `inbox:channel:manage` (the Inbox's settings permission —
 * the simulator panel is a channel-settings page), checked again at the
 * branch of the account pressed; and `INBOX_SIMULATOR=on`, which production
 * refuses to boot with. With the simulator off every press answers
 * `409 CHANNEL_NOT_CONNECTED`. Another operator's account answers 404.
 */

const ingestAnswer = z.object({
  outcome: z.string(),
  receiptId: z.string().nullable(),
  messages: z.number().int(),
  duplicates: z.number().int(),
  statuses: z.number().int(),
  conversationsCreated: z.number().int(),
  reopened: z.number().int(),
  outOfHours: z.array(z.string()),
  conversationIds: z.array(z.string()),
});

/** SCRUM-824: the largest voice note the simulator plays (1 MB: a few minutes of a phone's voice recording). */
export const SIMULATOR_VOICE_MAX_BYTES = 1024 * 1024;
const SIMULATOR_VOICE_BASE64_MAX = Math.ceil(SIMULATOR_VOICE_MAX_BYTES / 3) * 4;
const SIMULATOR_BODY_LIMIT = SIMULATOR_VOICE_BASE64_MAX + 64 * 1024;

export function inboxSimulatorRoutes(app: App): Promise<void> {
  const deps = (log: SimulatorDeps['log']): SimulatorDeps => ({
    db: app.db,
    channels: app.inboxChannels,
    log,
    ai: scheduleOf(app.inboxAi),
    // SCRUM-824: a played voice note's audio is stored, and the note filed
    // pending or off, as the real webhook stores and files it.
    storage: app.fileStorage,
    transcribe: app.inboxTranscription.adapter !== null,
  });

  app.post(
    '/inbox/simulator/inbound',
    {
      config: { permission: 'inbox:channel:manage' },
      // SCRUM-824: room for a short voice note, base64 in the JSON.
      bodyLimit: SIMULATOR_BODY_LIMIT,
      schema: {
        description:
          "Play one pretend customer message into a simulator channel account: signed with this deployment's simulator secret and sent through the real inbox webhook handler (verify, receipt, dedupe, contact, thread, routing, out-of-hours). With `voice` (SCRUM-824) the message is a WhatsApp voice note carrying the uploaded audio (base64, at most 1 MB), stored and transcribed as a real one is; `text` may then be left out. Simulator only (INBOX_SIMULATOR=on).",
        body: z
          .object({
            channelAccountId: z.string().uuid(),
            /** A WhatsApp id: the phone's digits, country code first. */
            from: z.string().regex(/^\d{6,15}$/),
            name: z.string().trim().min(1).max(80).optional(),
            /** The words; required unless the press carries a voice note. */
            text: z.string().min(1).max(4096).optional(),
            /** A voice note the tester uploaded (SCRUM-824): its audio type and its bytes, base64. */
            voice: z
              .object({
                contentType: z.string().regex(/^audio\/[A-Za-z0-9.+-]+(;[ -~]{0,80})?$/, 'an audio content type'),
                dataBase64: z.string().min(4).max(SIMULATOR_VOICE_BASE64_MAX),
              })
              .optional(),
            /** The classification the router takes in place of the AI. */
            hint: z
              .object({
                category: z.enum(INBOX_CATEGORIES).optional(),
                intent: z.string().max(120).optional(),
                language: z.string().min(2).max(8).optional(),
                branchId: z.string().uuid().optional(),
              })
              .optional(),
          })
          .refine((b) => b.text !== undefined || b.voice !== undefined, { message: 'a message carries words or a voice note' }),
        response: { 200: ingestAnswer.extend({ externalMessageId: z.string() }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const ctx = { operatorId: auth.operatorId, actorAccountId: auth.accountId, requestId: req.id };
      const d = deps(req.log);
      // At the BRANCH of the account pressed, once it is found in the caller's operator.
      const { account } = await simulatorAccount(d, auth.operatorId, req.body.channelAccountId);
      await req.requirePermission('inbox:channel:manage', account.branchId ? { branchId: account.branchId } : {});
      const voice = req.body.voice ? Buffer.from(req.body.voice.dataBase64, 'base64') : null;
      if (voice && (voice.length === 0 || voice.length > SIMULATOR_VOICE_MAX_BYTES)) {
        throw errors.badRequest(`A simulated voice note is 1 to ${SIMULATOR_VOICE_MAX_BYTES} bytes`);
      }
      const { externalMessageId, result } = await simulateInbound(d, ctx, account.id, {
        from: req.body.from,
        text: req.body.text ?? '',
        ...(voice && req.body.voice ? { voice: { bytes: new Uint8Array(voice), contentType: req.body.voice.contentType } } : {}),
        ...(req.body.name ? { name: req.body.name } : {}),
        ...(req.body.hint ? { hint: req.body.hint } : {}),
      });
      return { ...result, externalMessageId };
    },
  );

  app.post(
    '/inbox/simulator/status',
    {
      config: { permission: 'inbox:channel:manage' },
      schema: {
        description:
          'Push delivery receipts through the real inbox webhook for a simulator channel account: one named status for one outbound message, or, with none named, every delivered and read receipt the simulator scheduled for the replies it accepted. Simulator only.',
        body: z
          .object({
            channelAccountId: z.string().uuid(),
            externalMessageId: z.string().min(1).max(200).optional(),
            status: z.enum(['sent', 'delivered', 'read', 'failed']).optional(),
          })
          .refine((b) => (b.externalMessageId === undefined) === (b.status === undefined), {
            message: 'name both a message and a status, or neither',
          }),
        response: { 200: z.object({ deliveries: z.array(ingestAnswer) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const ctx = { operatorId: auth.operatorId, actorAccountId: auth.accountId, requestId: req.id };
      const d = deps(req.log);
      const { account } = await simulatorAccount(d, auth.operatorId, req.body.channelAccountId);
      await req.requirePermission('inbox:channel:manage', account.branchId ? { branchId: account.branchId } : {});
      const named =
        req.body.externalMessageId && req.body.status
          ? { externalMessageId: req.body.externalMessageId, status: req.body.status }
          : null;
      return { deliveries: await simulateStatus(d, ctx, account.id, named) };
    },
  );

  app.post(
    '/inbox/simulator/scenario',
    {
      config: { permission: 'inbox:channel:manage' },
      schema: {
        description:
          "Play the inbox demo conversations into the caller's operator: ten fictional threads whose customer lines go through the simulator and the real webhook handler (so routing assigns them), the staff side laid around them, six demo staff and the four simulator channel accounts. Idempotent: a second play writes nothing. Simulator only, and refused on production.",
        body: z.object({ scenario: z.literal('demo') }),
        response: {
          200: z.object({
            staffCreated: z.number().int(),
            rulesNamed: z.number().int(),
            channelAccountsCreated: z.number().int(),
            conversationsCreated: z.number().int(),
            conversationsAlreadyThere: z.number().int(),
            messages: z.number().int(),
            assignments: z.number().int(),
            events: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // Operator-wide: the demo writes staff, rules and accounts across the operator.
      await req.requirePermission('inbox:channel:manage', { operatorId: auth.operatorId, branchId: undefined });
      return playDemoScenario(deps(req.log), {
        operatorId: auth.operatorId,
        actorAccountId: auth.accountId,
        requestId: req.id,
      });
    },
  );

  return Promise.resolve();
}
