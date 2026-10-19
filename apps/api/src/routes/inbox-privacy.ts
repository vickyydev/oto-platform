import { z } from 'zod';
import {
  INBOX_ERASE_CONFIRM_WORD,
  InboxEraseContactBodySchema,
  InboxEraseContactSchema,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { opCtx, withTx } from '../services/tx';
import { eraseContact, previewErasure } from '../services/inbox/privacy';

/**
 * THE INBOX'S PDPA ERASURE ROUTE (S2-19 I2g, SCRUM-586; plan §3.6).
 *
 *   POST /inbox/contacts/:id/erase
 *
 * IRREVERSIBLE, so guarded and confirmed beyond the usual:
 *   - `inbox:contact:erase` held at OPERATOR scope. It is in no inbox role;
 *     `operator_admin` and `platform_admin` carry it through the whole
 *     vocabulary, and any other holder is someone an administrator granted
 *     it to deliberately. A branch or department grant of it does not reach
 *     a person whose threads span the operator, so it is refused here.
 *   - TWO CONFIRMATIONS in the body: the contact id repeated
 *     (`confirmContactId`) and the word `ERASE` (`confirm`). Missing either,
 *     the answer is `409 ERASURE_UNCONFIRMED` carrying what WOULD be erased
 *     (counts, and the ids of the contacts reached through the same phone),
 *     and nothing is touched.
 *
 * A contact of another operator answers 404, as one that does not exist.
 */

const ContactParams = z.object({ id: z.string().uuid() });

export async function inboxPrivacyRoutes(app: App): Promise<void> {
  app.post(
    '/contacts/:id/erase',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'PDPA erasure of an Inbox contact — IRREVERSIBLE. Anonymises in place, in one transaction: the contact and ' +
          'every other live contact of the operator with the same phone become "Erased contact" with a hashed handle ' +
          'and no phone, member link or avatar; every message in their threads (customer lines, staff replies and the ' +
          'mirrored check-in and booking notices) loses its text, translation, transcript and media and is marked ' +
          'redacted; previews and AI summaries are cleared; inbox-owned files are deleted from storage; name- or ' +
          'text-bearing keys in timeline payloads are nulled; and the raw webhook payloads that carried them are ' +
          'purged. Threads keep their status, owners and timeline shape. Needs two confirmations in the body — ' +
          '`confirmContactId` equal to the path id and `confirm: "ERASE"` — or answers 409 ERASURE_UNCONFIRMED with ' +
          'the counts it would erase. Re-erasing answers `alreadyErased: true`. One `inbox.contact.erase` audit row ' +
          '(ids and counts only). Needs inbox:contact:erase at operator scope.',
        params: ContactParams,
        body: InboxEraseContactBodySchema,
        response: { 200: InboxEraseContactSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      const operatorWide = effective.some(
        (g) =>
          g.permission === 'inbox:contact:erase' &&
          g.scopeType === 'operator' &&
          (g.scopeId === null || g.scopeId === auth.operatorId),
      );
      if (!operatorWide) throw new PermissionDeniedError('inbox:contact:erase');

      // 404 before 409: the confirmation is never a way to learn that an id exists elsewhere.
      const preview = await previewErasure(app.db, auth.operatorId, req.params.id);
      const confirmed =
        req.body.confirmContactId === req.params.id && req.body.confirm === INBOX_ERASE_CONFIRM_WORD;
      if (!confirmed) {
        throw errors.conflict(
          'ERASURE_UNCONFIRMED',
          `Erasure is irreversible. Repeat the contact id as confirmContactId and send confirm: "${INBOX_ERASE_CONFIRM_WORD}".`,
          preview,
        );
      }

      return withTx(app.db, opCtx(req), 'inbox.contact.erase', (tx) =>
        eraseContact(tx, app.fileStorage, {
          operatorId: auth.operatorId,
          contactId: req.params.id,
          actorAccountId: auth.accountId,
          requestId: req.id,
          now: new Date(),
        }),
      );
    },
  );
}
