import { z } from 'zod';
import { parsePublicOrigin } from '@oto/messaging';
import {
  InboxActionRefusalSchema,
  InboxStartOverSchema,
  InboxTestLineCreateBodySchema,
  InboxTestLineCreatedSchema,
} from '@oto/shared';
import type { App } from '../app';
import { PermissionDeniedError } from '../plugins/session';
import { opCtx, withTx } from '../services/tx';
import { holdsAnywhere, viewerScopeOf } from '../services/inbox/read-visibility';
import { setUpTestLine, startOver } from '../services/inbox/test-line';

/**
 * THE WHATSAPP TEST LINE'S ROUTES (SCRUM-908). The rules are in
 * `services/inbox/test-line.ts`.
 *
 *   POST /inbox/test-lines                       set up the line on Twilio's sandbox number
 *   POST /inbox/conversations/{id}/start-over    clear one of its conversations
 *
 * Both need `inbox:channel:manage` — the Inbox's channel settings, the
 * simulator panel's permission: setting the line up at operator scope (it is
 * an operator-wide number), Start over at the line. Each write runs in one
 * transaction with its audit row and takes an `Idempotency-Key`.
 */

const ConversationParams = z.object({ id: z.string().uuid() });

export async function inboxTestLineRoutes(app: App): Promise<void> {
  app.post(
    '/test-lines',
    {
      config: { permission: 'inbox:channel:manage', target: { operator: true } },
      schema: {
        description:
          "Set up the WhatsApp test line (SCRUM-908): the operator's channel account on Twilio's WhatsApp sandbox " +
          'number (provider twilio), found or created — operator-wide, default category general, the assistant off ' +
          'until a person switches the line to live in the Assistant settings. Answers the names of its three ' +
          'settings (never a value), the address to paste into Twilio’s Sandbox configuration for both "When a ' +
          'message comes in" and "Status callback URL", and whether the line is connected on this deployment and ' +
          'why not. A second call finds the same line and writes nothing. Audit row inbox.channel_account.create ' +
          'when it creates. Needs inbox:channel:manage at operator scope.',
        body: InboxTestLineCreateBodySchema,
        response: { 200: InboxTestLineCreatedSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return withTx(app.db, opCtx(req), 'inbox.channel_account.create', (tx) =>
        setUpTestLine(
          tx,
          { channels: app.inboxChannels, publicUrl: parsePublicOrigin(app.env.INBOX_TWILIO_PUBLIC_URL) },
          { operatorId: auth.operatorId, actorAccountId: auth.accountId, requestId: req.id, now: new Date() },
          req.body,
        ),
      );
    },
  );

  app.post(
    '/conversations/:id/start-over',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Start over on a conversation of the WhatsApp test line (SCRUM-908), so the tester can write again as a ' +
          'new customer. In one transaction: the assistant’s turns cancelled and every queued line of the thread ' +
          'withdrawn; the words removed by the PDPA erasure’s own steps, for this thread only (message text, ' +
          'translations, transcripts and media, the answers read into the assistant’s open questions, the ' +
          'unapproved examples copied from it, the word-bearing timeline keys, the raw deliveries on this line that ' +
          'name the number); waiting hand-over notices skipped; the thread archived — it leaves every inbox read and ' +
          'the thread key, so the number’s next message opens a new conversation; and the contact’s names and ' +
          'language reset, refilled from the next message. A conversation of any other number answers 409 ' +
          'NOT_A_TEST_LINE. A cleared one answers alreadyCleared: true and changes nothing. One ' +
          'inbox.conversation.start_over audit row (ids and counts). Needs inbox:channel:manage at the line; 404 ' +
          'when the conversation is not the caller’s to see.',
        params: ConversationParams,
        response: { 200: InboxStartOverSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      if (!holdsAnywhere(effective, 'inbox:channel:manage', auth.operatorId)) {
        throw new PermissionDeniedError('inbox:channel:manage');
      }
      return withTx(app.db, opCtx(req), 'inbox.conversation.start_over', (tx) =>
        startOver(tx, app.fileStorage, {
          viewer: {
            accountId: auth.accountId,
            operatorId: auth.operatorId,
            scope: viewerScopeOf(effective, auth.accountId, auth.operatorId),
          },
          effective,
          conversationId: req.params.id,
          requestId: req.id,
          now: new Date(),
        }),
      );
    },
  );
}
