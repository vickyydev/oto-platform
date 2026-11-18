import { and, eq, inArray, isNull } from 'drizzle-orm';
import { child, member, type Db } from '@oto/db';
import type { FamilyOnlineChild } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { familyPassMember, publicSavedChildrenOf, type PublicSavedChild } from './member-code';
import { BOOKING_SITE_SOURCE, archiveChild, childCacheView, memberCacheView } from './members';
import { recordChange } from './sync';
import { withTx, type OpContext, type Tx } from './tx';

/**
 * SCRUM-1011 — A RETURNING FAMILY'S OWN CHANGES REACH THEIR RECORD.
 *
 * The owner's ruling (18 November: "Save it to the family record"; 19
 * November: "Plain: saved and logged", "When the parent confirms online, paid
 * or not", "Remove from saved" online, and the contact app "Also saved to the
 * family record"). The approved design did all four
 * (`imports/oto-pos/artifacts/oto-till/src/pages/Book.tsx`: "Still correct?"
 * wrote the saved child, "Remove from saved" removed it, every supervised
 * child was updated or added at the end of the children's details, and the
 * contact app went onto the member). Until now the booking site wrote nothing
 * to a member: the open route could only read (SCRUM-357, S2-09b).
 *
 * WHO MAY. Only whoever holds the family pass a passed code check answered
 * (`services/member-code.ts`), for the member whose phone it was sent to: the
 * phone picks the live member, and the pass must be that member's. Without it
 * nothing is written, so a person who only knows the phone changes nothing.
 *
 * WHAT. For a child on the record (`savedChildId`, which must be one of this
 * member's live children): its name, date of birth or age, allergies and food
 * restrictions, where they changed. For a child the family adds
 * (`newChildId`, minted by the booking site): a new child on the record. For
 * "Remove from saved": the child is archived, never deleted
 * (`archiveChild`). The contact app picked becomes the member's
 * `preferred_channel`, as the counter's choice does. The photo, the food
 * choice and the nanny's time stay on the booking.
 *
 * LOGGED. Every change is its own audit row with before and after, source
 * `booking_site`, origin `booking_site` and no staff actor; and every child
 * and member change is published to the boxes in the same transaction, as the
 * counter's edits are (an allergy changed tonight reaches the box that warns
 * the kitchen). Nothing is flagged for reception: the owner chose the plain
 * version (decision 8 A).
 *
 * ONCE. A second send of the same confirmation writes nothing: a saved child
 * whose values already match is not touched, a new child's id is the booking
 * site's own (a second send finds it on this family and treats it as the same
 * child), a removed child is already archived, and an unchanged contact app is
 * not written. Every check refuses the whole send before anything is written:
 * a child id of another family is refused, not skipped.
 */

/** One family save: the children confirmed, the children removed, the contact app picked. */
export interface FamilyOnlineSaveInput {
  operatorId: string;
  branchId: string;
  /** E.164, already normalised by the caller. */
  phone: string;
  pass: string;
  children: FamilyOnlineChild[];
  remove: string[];
  contactChannel?: 'whatsapp' | 'telegram' | 'line';
}

export interface FamilyOnlineSaveResult {
  /** The family's saved children after the save, as the code check answers them. */
  children: PublicSavedChild[];
}

/** The refusal for a missing, expired or other family's pass — the same words for each. */
export const FAMILY_CHECK_EXPIRED = 'FAMILY_CHECK_EXPIRED';

export function familyCheckRefusal(): AppError {
  return new AppError(
    403,
    FAMILY_CHECK_EXPIRED,
    "Your family check has run out, or is not for this phone, so nothing was saved to your family's record. Ask for a new code to save changes; the details still go on this booking.",
  );
}

/** The refusal for a child the family's record does not hold — never says whose it is. */
export function notThisFamilysChild(): AppError {
  return errors.badRequest(
    "A child on this booking is not on your family's saved record, so nothing was saved. Go back and choose again.",
  );
}

const blank = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

type ChildRow = typeof child.$inferSelect;

/**
 * What changes on a saved child, field by field, from what the family
 * confirmed. The booking site shows one food-restrictions field, read as
 * `food_restrictions`, then `dietary` (the till's own reading); a change to it
 * writes `food_restrictions`, and clearing it clears `dietary` too, so what the
 * family cleared stays cleared. A date of birth the family set (the picker
 * always gives one) carries its age; a record kept by age alone takes a new
 * age. An allergy line follows the till's rule for the medical alert
 * (`PATCH /members/children/:childId`).
 */
function childPatch(row: ChildRow, sent: FamilyOnlineChild): { patch: Partial<ChildRow>; before: Record<string, unknown> } {
  const patch: Partial<ChildRow> = {};
  const before: Record<string, unknown> = {};
  const name = sent.name.trim();
  if (name !== row.name) {
    patch.name = name;
    before.name = row.name;
  }
  const dob = sent.dateOfBirth ?? null;
  if (dob && dob !== row.dateOfBirth) {
    patch.dateOfBirth = dob;
    before.dateOfBirth = row.dateOfBirth;
    if (sent.ageYears !== row.ageYears) {
      patch.ageYears = sent.ageYears;
      before.ageYears = row.ageYears;
    }
  } else if (!dob && !row.dateOfBirth && sent.ageYears !== row.ageYears) {
    patch.ageYears = sent.ageYears;
    before.ageYears = row.ageYears;
  }
  const allergies = blank(sent.allergies);
  if (allergies !== row.allergies) {
    patch.allergies = allergies;
    before.allergies = row.allergies;
    const alert = Boolean(allergies);
    if (alert !== row.medicalAlert) {
      patch.medicalAlert = alert;
      before.medicalAlert = row.medicalAlert;
    }
  }
  const food = blank(sent.foodRestrictions);
  if (food !== (row.foodRestrictions ?? row.dietary)) {
    patch.foodRestrictions = food;
    before.foodRestrictions = row.foodRestrictions;
    if (food === null && row.dietary !== null) {
      patch.dietary = null;
      before.dietary = row.dietary;
    }
  }
  return { patch, before };
}

/**
 * Save a family's confirmed children, removals and contact app to its record.
 * Throws `FAMILY_CHECK_EXPIRED` (403) for a pass that is missing, expired or
 * another family's, and a 400 for a child that is not this family's —
 * before anything is written, either way.
 */
export async function saveFamilyOnline(
  db: Db,
  ctx: OpContext,
  input: FamilyOnlineSaveInput,
): Promise<FamilyOnlineSaveResult> {
  const holder = input.pass ? await familyPassMember(db, input) : null;
  if (!holder) throw familyCheckRefusal();
  const memberId = holder.memberId;

  const savedIds = input.children.flatMap((c) => (c.savedChildId ? [c.savedChildId] : []));
  const newIds = input.children.flatMap((c) => (c.newChildId ? [c.newChildId] : []));
  const allIds = [...savedIds, ...newIds, ...input.remove];
  if (new Set(allIds).size !== allIds.length) {
    throw errors.badRequest('A child is named twice in this save, so nothing was saved.');
  }

  return withTx(
    db,
    { ...ctx, actorAccountId: null, operatorId: input.operatorId, branchId: input.branchId },
    'member.family_online_save',
    async (tx) => {
      const [m] = await tx
        .select()
        .from(member)
        .where(and(eq(member.id, memberId), eq(member.operatorId, input.operatorId), isNull(member.archivedAt)))
        .for('update')
        .limit(1);
      if (!m) throw familyCheckRefusal();

      // Every id this save names, read once and locked: the checks below all
      // run before the first write, so a refusal writes nothing.
      const rows = allIds.length > 0
        ? await tx.select().from(child).where(inArray(child.id, allIds)).for('update')
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of savedIds) {
        const row = byId.get(id);
        if (!row || row.memberId !== memberId || row.archivedAt) throw notThisFamilysChild();
      }
      for (const id of newIds) {
        const row = byId.get(id);
        // The booking site's own id, sent again: the same child, if it is this
        // family's and still saved. Anyone else's id is refused in the same
        // words as a child that is not this family's.
        if (row && (row.memberId !== memberId || row.archivedAt)) throw notThisFamilysChild();
      }
      for (const id of input.remove) {
        const row = byId.get(id);
        if (!row || row.memberId !== memberId) throw notThisFamilysChild();
      }

      const now = new Date();
      for (const sent of input.children) {
        const id = (sent.savedChildId ?? sent.newChildId)!;
        const row = byId.get(id);
        if (!row) {
          const allergies = blank(sent.allergies);
          const details = {
            name: sent.name.trim(),
            dateOfBirth: sent.dateOfBirth ?? null,
            ageYears: sent.ageYears,
            allergies,
            medicalAlert: Boolean(allergies),
            foodRestrictions: blank(sent.foodRestrictions),
          };
          const [created] = await tx
            .insert(child)
            .values({ id, memberId, ...details, consentRecordedAt: now })
            .returning();
          await recordChange(tx, { operatorId: input.operatorId, branchId: null }, {
            scope: 'members',
            entityType: 'child',
            entityId: id,
            payload: childCacheView(created!),
          });
          await audit.record(tx, {
            actorAccountId: null,
            operatorId: input.operatorId,
            branchId: input.branchId,
            action: 'child.create',
            entityType: 'child',
            entityId: id,
            after: { memberId, ...details, source: BOOKING_SITE_SOURCE },
            requestId: ctx.requestId,
            origin: BOOKING_SITE_SOURCE,
          });
          continue;
        }
        const { patch, before } = childPatch(row, sent);
        if (Object.keys(patch).length === 0) continue;
        const [after] = await tx
          .update(child)
          .set({ ...patch, updatedAt: now })
          .where(eq(child.id, id))
          .returning();
        await recordChange(tx, { operatorId: input.operatorId, branchId: null }, {
          scope: 'members',
          entityType: 'child',
          entityId: id,
          payload: childCacheView(after!),
        });
        await audit.record(tx, {
          actorAccountId: null,
          operatorId: input.operatorId,
          branchId: input.branchId,
          action: 'child.update',
          entityType: 'child',
          entityId: id,
          before,
          after: { ...patch, source: BOOKING_SITE_SOURCE },
          requestId: ctx.requestId,
          origin: BOOKING_SITE_SOURCE,
        });
      }

      for (const id of input.remove) {
        await archiveChild(
          tx,
          {
            accountId: null,
            operatorId: input.operatorId,
            branchId: input.branchId,
            ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
            fromBookingSite: true,
          },
          id,
        );
      }

      if (input.contactChannel && input.contactChannel !== m.preferredChannel) {
        await saveContactChannel(tx, ctx, input, m, now);
      }

      return { children: await publicSavedChildrenOf(tx, memberId) };
    },
  );
}

/** The contact app the family picked becomes the member's, as the counter's choice does. */
async function saveContactChannel(
  tx: Tx,
  ctx: OpContext,
  input: FamilyOnlineSaveInput,
  m: typeof member.$inferSelect,
  now: Date,
): Promise<void> {
  const [after] = await tx
    .update(member)
    .set({ preferredChannel: input.contactChannel, updatedAt: now })
    .where(eq(member.id, m.id))
    .returning();
  await recordChange(tx, { operatorId: input.operatorId, branchId: null }, {
    scope: 'members',
    entityType: 'member',
    entityId: m.id,
    payload: memberCacheView(after!),
  });
  await audit.record(tx, {
    actorAccountId: null,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'member.update',
    entityType: 'member',
    entityId: m.id,
    before: { preferredChannel: m.preferredChannel },
    after: { preferredChannel: input.contactChannel, source: BOOKING_SITE_SOURCE },
    requestId: ctx.requestId,
    origin: BOOKING_SITE_SOURCE,
  });
}

/**
 * SCRUM-1011 — the booking says which saved child each supervised child is.
 *
 * Called by `createPublicBooking` before it writes: when any supervised line
 * names a `savedChildId`, the family pass must be live for the live member
 * holding the booking's phone, and every id must be one of that member's live
 * children; otherwise the booking is refused, and nothing is written. Answers
 * the member the pass proves ("family checked"), or null when no live pass
 * came with the booking and no child is linked.
 */
export async function checkBookingFamilyLinks(
  exec: Db,
  input: { operatorId: string; phone: string | null; pass?: string; savedChildIds: string[] },
): Promise<{ checkedMemberId: string | null }> {
  const holder = input.pass && input.phone
    ? await familyPassMember(exec, { operatorId: input.operatorId, phone: input.phone, pass: input.pass })
    : null;
  if (input.savedChildIds.length === 0) return { checkedMemberId: holder?.memberId ?? null };
  if (!holder) throw familyCheckRefusal();
  const ids = [...new Set(input.savedChildIds)];
  const rows = await exec
    .select({ id: child.id })
    .from(child)
    .where(and(inArray(child.id, ids), eq(child.memberId, holder.memberId), isNull(child.archivedAt)));
  if (rows.length !== ids.length) throw notThisFamilysChild();
  return { checkedMemberId: holder.memberId };
}
