import { and, desc, eq, isNull } from 'drizzle-orm';
import { channelAccount, contact, conversation, member, team } from '@oto/db';
import {
  newId,
  normalizePhone,
  type InboxContactCreated,
  type InboxContactView,
  type Permission,
} from '@oto/shared';
import { audit } from '../audit';
import { hasPermission, type EffectivePermission } from '../permissions';
import { PermissionDeniedError } from '../../plugins/session';
import { errors } from '../../lib/errors';
import type { Exec, Tx } from '../tx';
import { loadVisibleConversation, visibleConversationsSql, type InboxViewer } from './read-visibility';

/**
 * A CONTACT MADE BY STAFF, A NAME SET BY STAFF (SCRUM-860; the owner, 8 and 12
 * November 2026: "Allow users to create contacts and edit contact names from
 * the unified inbox").
 *
 * HOW A CONTACT CAME TO EXIST UNTIL NOW: only from an incoming message
 * (`ingest.ts`), a till notice (`mirror.ts`) or the simulator; its name was
 * the channel's profile name, filled once and never changed; the only
 * contact action was erasure.
 *
 * THE NAME. `contact.display_name` stays THE name every reader looks at —
 * the thread list and its search, the header, the simulator panel, the
 * assistant's bookings — so a name staff set reaches all of them with no
 * reader changing. What changes is who may write it:
 *   - the ingest and the mirror fill `display_name` only while it is null
 *     (as they always did) and keep the channel's own name, latest seen, in
 *     `profile_name` (`0117_inbox_contact_name`), so a later message's
 *     profile name NEVER overwrites a name staff set and nothing is lost;
 *   - `renameContact` sets `display_name` and marks it staff-set
 *     (`name_set_by_account_id`, `name_set_at`); clearing puts the profile
 *     name back and drops the mark. An erased contact cannot be named again.
 *
 * THE PERMISSION is the inbox's own: `inbox:conversation:reply`, the
 * permission every inbox role carries for writing in a thread, checked AT
 * THE CONVERSATION for a rename (its branch, its team's department, the
 * operator, or the record — exactly as the actions check theirs), and held
 * anywhere in the operator for a create. No new permission and no new role:
 * role permissions are laid once and never re-synced, so a new one would
 * reach no existing operator.
 *
 * A CREATE writes the contact AND its thread on the chosen channel account,
 * because the inbox lists conversations, not contacts: the thread is how the
 * contact appears in the list and the search. The thread is laid exactly as
 * a mirrored check-in notice thread is (`mirror.ts` `upsertConversation`):
 * the account's default category, its park's reception desk, no owner and
 * no routing — it is routed like a new thread the first time the customer
 * writes (`ingest.ts`, "A thread nobody has routed yet"). Nothing is sent to
 * the customer and no assistant turn starts: both happen only on an inbound
 * message. A later message from the same identity lands on this contact and
 * this thread through the ingest's own `(operator, channel, handle)` lookup.
 */

export const INBOX_CONTACT_PERMISSION: Permission = 'inbox:conversation:reply';

export const INBOX_CONTACT_MESSAGES = {
  erased: 'This contact was erased and cannot be named again.',
  channelNotFound: 'Channel not found',
  channelCannotCarry: 'This channel only carries notices; a contact cannot be made on it.',
  invalidPhone: 'Enter a phone number the inbox can reach, such as 081 234 5678 or +66 81 234 5678.',
  exists: (name: string, channel: string) => `${name} is already a contact on ${channel}.`,
} as const;

const CHANNEL_WORD: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  line: 'LINE',
  telegram: 'Telegram',
  webform: 'the web form',
};

export interface ContactCtx {
  viewer: InboxViewer;
  effective: EffectivePermission[];
  requestId: string | null;
  now: Date;
}

type ContactRow = typeof contact.$inferSelect;
type ConversationRow = typeof conversation.$inferSelect;

export function contactView(c: ContactRow): InboxContactView {
  return {
    id: c.id,
    channel: c.channel,
    handle: c.externalHandle,
    displayName: c.displayName,
    phone: c.phone,
    language: c.language,
    erased: c.erasedAt !== null,
    profileName: c.profileName,
    nameSetByStaff: c.nameSetByAccountId !== null,
    nameSetAt: c.nameSetAt?.toISOString() ?? null,
  };
}

async function contactOf(db: Exec, operatorId: string, contactId: string): Promise<ContactRow> {
  const [row] = await db
    .select()
    .from(contact)
    .where(and(eq(contact.operatorId, operatorId), eq(contact.id, contactId)))
    .limit(1);
  if (!row) throw errors.notFound('Contact not found');
  return row;
}

/** The permission held at THIS conversation: operator-wide, its branch, its team's department, or the record. */
async function requireAtConversation(
  db: Exec,
  ctx: ContactCtx,
  permission: Permission,
  conv: ConversationRow,
): Promise<void> {
  let departmentId: string | undefined;
  if (conv.teamId) {
    const [t] = await db
      .select({ departmentId: team.departmentId })
      .from(team)
      .where(and(eq(team.operatorId, ctx.viewer.operatorId), eq(team.id, conv.teamId)))
      .limit(1);
    departmentId = t?.departmentId ?? undefined;
  }
  const held = hasPermission(ctx.effective, permission, {
    operatorId: ctx.viewer.operatorId,
    branchId: conv.branchId ?? undefined,
    departmentId,
    recordId: conv.id,
  });
  if (!held) throw new PermissionDeniedError(permission);
}

/** The contact behind a conversation the viewer can see, with its profile name. */
export async function contactOfConversation(
  db: Exec,
  viewer: InboxViewer,
  conversationId: string,
): Promise<InboxContactView> {
  const conv = await loadVisibleConversation(db, viewer, conversationId);
  return contactView(await contactOf(db, viewer.operatorId, conv.contactId));
}

/** A name as staff typed it: trimmed, inner runs of blanks folded; null when nothing is left. */
export function cleanName(name: string | null | undefined): string | null {
  const cleaned = (name ?? '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Set the shown name over the channel's (`displayName` given), or clear the
 * staff-set name and show the channel's profile name again (null or blank).
 * Writes nothing, and no audit row, when the name is already as asked.
 */
export async function renameContact(
  tx: Tx,
  ctx: ContactCtx,
  input: { conversationId: string; displayName: string | null },
): Promise<InboxContactView> {
  const { operatorId } = ctx.viewer;
  const conv = await loadVisibleConversation(tx, ctx.viewer, input.conversationId);
  await requireAtConversation(tx, ctx, INBOX_CONTACT_PERMISSION, conv);

  // Locked: two people renaming at once still leave one clear answer.
  const [locked] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.operatorId, operatorId), eq(contact.id, conv.contactId)))
    .limit(1)
    .for('update');
  if (!locked) throw errors.notFound('Contact not found');
  if (locked.erasedAt !== null) throw errors.conflict('CONTACT_ERASED', INBOX_CONTACT_MESSAGES.erased);

  const wanted = cleanName(input.displayName);
  const before = {
    displayName: locked.displayName,
    profileName: locked.profileName,
    nameSetByAccountId: locked.nameSetByAccountId,
    nameSetAt: locked.nameSetAt?.toISOString() ?? null,
    // The thread the rename was made from, on both sides, so the activity log
    // does not show it as a change.
    conversationId: conv.id,
  };

  let patch: Partial<typeof contact.$inferInsert>;
  if (wanted === null) {
    // Clear: nothing to clear when the shown name is already the channel's.
    if (locked.nameSetByAccountId === null) return contactView(locked);
    patch = { displayName: locked.profileName, nameSetByAccountId: null, nameSetAt: null };
  } else {
    if (locked.nameSetByAccountId !== null && locked.displayName === wanted) return contactView(locked);
    patch = {
      displayName: wanted,
      nameSetByAccountId: ctx.viewer.accountId,
      nameSetAt: ctx.now,
      // A row written before `profile_name` existed, and never backfilled or
      // seen since: until now its shown name WAS the channel's, so it is kept.
      ...(locked.nameSetByAccountId === null && locked.profileName === null && locked.displayName !== null
        ? { profileName: locked.displayName }
        : {}),
    };
  }
  const [after] = await tx
    .update(contact)
    .set({ ...patch, updatedAt: ctx.now })
    .where(and(eq(contact.operatorId, operatorId), eq(contact.id, locked.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.viewer.accountId,
    action: 'inbox.contact.rename',
    entityType: 'inbox.contact',
    entityId: locked.id,
    operatorId,
    branchId: conv.branchId,
    requestId: ctx.requestId,
    before,
    after: {
      displayName: after!.displayName,
      profileName: after!.profileName,
      nameSetByAccountId: after!.nameSetByAccountId,
      nameSetAt: after!.nameSetAt?.toISOString() ?? null,
      conversationId: conv.id,
    },
  });
  return contactView(after!);
}

/** The most useful thread of an existing contact for the caller: on this account if any, else the latest they can see. */
async function visibleThreadOf(
  db: Exec,
  viewer: InboxViewer,
  contactId: string,
  channelAccountId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: conversation.id, channelAccountId: conversation.channelAccountId })
    .from(conversation)
    .where(and(eq(conversation.contactId, contactId), visibleConversationsSql(viewer)))
    .orderBy(desc(conversation.createdAt));
  return rows.find((r) => r.channelAccountId === channelAccountId)?.id ?? rows[0]?.id ?? null;
}

/**
 * A new contact and its thread on one channel account. Refuses a duplicate
 * — the same channel and the same normalised identity in the operator —
 * with `409 CONTACT_EXISTS` naming the existing contact and, when the caller
 * can see one, its thread. An erased contact's handle is a hash, so the
 * same number again is a new contact, as it is when the number writes again.
 */
export async function createContact(
  tx: Tx,
  ctx: ContactCtx,
  input: { channelAccountId: string; displayName: string; identity: string },
): Promise<InboxContactCreated> {
  const { operatorId } = ctx.viewer;
  const [account] = await tx
    .select()
    .from(channelAccount)
    .where(
      and(
        eq(channelAccount.operatorId, operatorId),
        eq(channelAccount.id, input.channelAccountId),
        isNull(channelAccount.archivedAt),
      ),
    )
    .limit(1);
  if (!account) throw errors.notFound(INBOX_CONTACT_MESSAGES.channelNotFound);
  if (!account.canReply) throw errors.conflict('CHANNEL_CANNOT_CARRY_CONTACT', INBOX_CONTACT_MESSAGES.channelCannotCarry);

  const name = cleanName(input.displayName);
  if (name === null) throw errors.badRequest('Enter a name.', { field: 'displayName' });

  // WhatsApp's handle IS the phone, E.164 (`ingest.ts`): the same shape the
  // webhook writes, so the customer's first message finds this contact.
  // Elsewhere the handle is the channel's own id for the person, as typed.
  let phone: string | null = null;
  let handle: string;
  if (account.channel === 'whatsapp') {
    phone = normalizePhone(input.identity);
    if (!phone) throw errors.badRequest(INBOX_CONTACT_MESSAGES.invalidPhone, { field: 'identity' });
    handle = phone;
  } else {
    handle = input.identity.trim();
  }

  const refuseExisting = async (existing: ContactRow): Promise<never> => {
    throw errors.conflict(
      'CONTACT_EXISTS',
      INBOX_CONTACT_MESSAGES.exists(existing.displayName ?? existing.externalHandle, CHANNEL_WORD[account.channel] ?? account.channel),
      {
        contactId: existing.id,
        displayName: existing.displayName,
        handle: existing.externalHandle,
        conversationId: await visibleThreadOf(tx, ctx.viewer, existing.id, account.id),
      },
    );
  };
  const [existing] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.operatorId, operatorId), eq(contact.channel, account.channel), eq(contact.externalHandle, handle)))
    .limit(1);
  if (existing) await refuseExisting(existing);

  let memberId: string | null = null;
  if (phone) {
    const [m] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.operatorId, operatorId), eq(member.phone, phone), isNull(member.archivedAt)))
      .limit(1);
    memberId = m?.id ?? null;
  }

  const [made] = await tx
    .insert(contact)
    .values({
      id: newId(),
      operatorId,
      channel: account.channel,
      externalHandle: handle,
      displayName: name,
      profileName: null,
      nameSetByAccountId: ctx.viewer.accountId,
      nameSetAt: ctx.now,
      phone,
      memberId,
      firstSeenAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: [contact.operatorId, contact.channel, contact.externalHandle] })
    .returning();
  if (!made) {
    // The race the pre-check cannot see: the number wrote in between.
    const [raced] = await tx
      .select()
      .from(contact)
      .where(and(eq(contact.operatorId, operatorId), eq(contact.channel, account.channel), eq(contact.externalHandle, handle)))
      .limit(1);
    if (!raced) throw new Error('the contact vanished between its insert and its read');
    await refuseExisting(raced);
  }

  // The thread, as a mirrored notice thread is laid: the account's park and
  // default category, its reception desk, no owner, no routing yet.
  const [reception] = account.branchId
    ? await tx
        .select({ id: team.id, name: team.name })
        .from(team)
        .where(and(eq(team.operatorId, operatorId), eq(team.key, 'reception'), eq(team.branchId, account.branchId)))
        .orderBy(desc(team.createdAt))
        .limit(1)
    : [];
  const [thread] = await tx
    .insert(conversation)
    .values({
      id: newId(),
      operatorId,
      contactId: made!.id,
      channelAccountId: account.id,
      teamId: reception?.id ?? null,
      branchId: account.branchId,
      category: account.defaultCategory,
      status: 'active',
      memberId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();

  await audit.record(tx, {
    actorAccountId: ctx.viewer.accountId,
    action: 'inbox.contact.create',
    entityType: 'inbox.contact',
    entityId: made!.id,
    operatorId,
    branchId: account.branchId,
    requestId: ctx.requestId,
    after: {
      channel: account.channel,
      channelAccountId: account.id,
      handle,
      phone,
      displayName: name,
      memberId,
      conversationId: thread!.id,
      createdBy: 'staff',
    },
  });
  await audit.record(tx, {
    actorAccountId: ctx.viewer.accountId,
    action: 'inbox.conversation.create',
    entityType: 'inbox.conversation',
    entityId: thread!.id,
    operatorId,
    branchId: account.branchId,
    requestId: ctx.requestId,
    after: {
      contactId: made!.id,
      channelAccountId: account.id,
      category: account.defaultCategory,
      categorySource: 'default',
      teamId: reception?.id ?? null,
      createdBy: 'staff',
    },
  });

  const [seen] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.id, thread!.id), visibleConversationsSql(ctx.viewer)))
    .limit(1);
  return {
    contact: contactView(made!),
    conversationId: thread!.id,
    visible: Boolean(seen),
    teamName: reception?.name ?? null,
  };
}
