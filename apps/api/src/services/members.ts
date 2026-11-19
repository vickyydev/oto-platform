import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { account, child, employee, member, memberTierVerification, type Db } from '@oto/db';
import { errors } from '../lib/errors';
import { audit } from './audit';
import {
  childAuditView,
  childGuardedInOperator,
  familyChildrenOfMembers,
  familyProfilesMode,
  type FamilyProfilesMode,
} from './family';
import { isTierRevocation } from './member-tier';
import { recordChange } from './sync';
import type { Tx } from './tx';

/**
 * The member register — browsing the list, which is not the same act as
 * identifying the visitor standing at the counter (SCRUM-246).
 *
 * It lives in its own service, and not beside the single-member view in
 * `routes/members.ts`, for one reason: the leak it closes came from the list
 * reusing that view. `GET /members` called `memberWithChildren` per row, so
 * one request with no search term answered with every member the park has and
 * every child's allergies and medical notes — on `pos:member:read`, which
 * every till session holds all day.
 *
 * The queries below select columns by name and never name a medical one, so a
 * register row cannot carry child health data even if somebody later widens
 * the row shape by habit. What a child's allergies are stays on the
 * single-member read, which reception reaches by phone, one visitor at a time.
 */

/** Matches the page size the register list answered with before paging. */
export const REGISTER_PAGE_DEFAULT = 50;
export const REGISTER_PAGE_MAX = 200;

/**
 * What a box holds a copy of (S2-05).
 *
 * A member edited at reception has to reach the boxes that cache members, and
 * the delta is written in the SAME transaction as the edit — so a member who
 * exists and a feed that says so commit together. What travels is only what a
 * till reads at the identify step: never the staff notes, never the email,
 * never the tier evidence. See the cache bundle in `services/sync.ts` for the
 * full account of what a box is and is not given.
 *
 * Here rather than in `routes/members.ts` since SCRUM-1011: the family's own
 * changes from the booking site publish the same two shapes.
 */
export function memberCacheView(row: typeof member.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    phone: row.phone,
    nickname: row.nickname,
    name: row.name,
    tierCode: row.tierCode,
    preferredChannel: row.preferredChannel,
  };
}

export function childCacheView(row: typeof child.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    memberId: row.memberId,
    name: row.name,
    dateOfBirth: row.dateOfBirth,
    ageYears: row.ageYears,
    allergies: row.allergies,
    medicalNotes: row.medicalNotes,
    medicalAlert: row.medicalAlert,
    dietary: row.dietary,
    foodRestrictions: row.foodRestrictions,
  };
}

/** The document stays valid through the whole expiry DAY it names. */
export function isEvidenceExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt.getTime() + 24 * 60 * 60 * 1000;
}

export interface ChildArchiveActor {
  /** Null only for the family's own press on the booking site (`fromBookingSite`), where nobody is signed in. */
  accountId: string | null;
  operatorId: string;
  branchId: string | null;
  requestId?: string;
  /** SCRUM-1024 — `crm.family_profiles` as the caller's request read it once: how the owner is checked. */
  familyMode: FamilyProfilesMode;
  /**
   * SCRUM-1014 — the family pressed "Remove from saved" on the customer
   * display of this station: the till carries it out under its own session,
   * and the audit row says where it came from.
   */
  fromDisplay?: { stationId: string };
  /**
   * SCRUM-1011 — the family pressed "Remove from saved" on the booking site,
   * holding the family pass of a code sent to their phone. No staff actor.
   */
  fromBookingSite?: boolean;
}

/** SCRUM-1014 — how an audit row names a change the family made on a station's customer display. */
export const CUSTOMER_DISPLAY_SOURCE = 'customer_display';

/**
 * SCRUM-1020 — A SAVED CHILD'S CARE NOTES, CHANGED BY THE FAMILY ON THE
 * CUSTOMER DISPLAY (the owner's answer of 19 November: the parent sees a saved
 * child's allergy and medical notes on the display and may update them there).
 *
 * The till carries the change out under its own session when it writes the
 * drop-off form, as it does a new child the family named there (SCRUM-1014),
 * and says so with `source=customer_display`. What such a change may be:
 *
 *   - it names the family identified at that till (`memberId`), and the child
 *     must be one of theirs: a child of any other family is the same 404 as a
 *     child that does not exist;
 *   - it changes the care notes and nothing else: the display shows the
 *     family nothing else of the record to change;
 *   - an empty note never replaces one that had text unless the family said
 *     plainly that there is none (`confirmedNone`): a box emptied by accident
 *     never takes an allergy off a child left in the park's care.
 *
 * Null when the change may be made; otherwise the refusal, and nothing is
 * written.
 */
export const DISPLAY_CARE_FIELDS = ['allergies', 'medicalNotes'] as const;
export type DisplayCareField = (typeof DISPLAY_CARE_FIELDS)[number];

export interface DisplayCareRefusal {
  status: 400 | 404;
  code: 'BAD_REQUEST' | 'NOT_FOUND' | 'DISPLAY_CARE_ONLY' | 'CARE_NOTE_CLEAR_UNCONFIRMED';
  message: string;
}

export function displayCareRefusal(input: {
  before: { memberId: string } & Partial<Record<DisplayCareField, string | null>>;
  /** The family the till identified, as the request names it. */
  memberId: string | undefined;
  /** Every child field the request sets. */
  fields: readonly string[];
  patch: Partial<Record<DisplayCareField, string | null | undefined>>;
  confirmedNone: boolean;
  /**
   * SCRUM-1024 — given only when `crm.family_profiles` reads through the
   * family: whether the family named is a live guardian of this child's
   * family. Absent at `off`, where `before.memberId` decides, as before.
   */
  heldByFamily?: boolean;
}): DisplayCareRefusal | null {
  if (!input.memberId) {
    return { status: 400, code: 'BAD_REQUEST', message: 'A change from the customer display names the family identified at this till' };
  }
  // SCRUM-1024 (step F3) — the caller answers `heldByFamily` when the switch
  // reads through the family; at `off` the child's own member decides.
  const theirs = input.heldByFamily ?? input.before.memberId === input.memberId;
  if (!theirs) return { status: 404, code: 'NOT_FOUND', message: 'Child not found' };
  const careFields: readonly string[] = DISPLAY_CARE_FIELDS;
  if (input.fields.length === 0 || input.fields.some((field) => !careFields.includes(field))) {
    return { status: 400, code: 'DISPLAY_CARE_ONLY', message: 'Only the allergy and medical notes are changed from the customer display' };
  }
  const cleared = DISPLAY_CARE_FIELDS.some((field) =>
    input.patch[field] !== undefined && !(input.patch[field] ?? '').trim() && !!(input.before[field] ?? '').trim());
  if (cleared && !input.confirmedNone) {
    return {
      status: 400,
      code: 'CARE_NOTE_CLEAR_UNCONFIRMED',
      message: 'The family has not confirmed that this child has no allergies or medical needs: the note is kept',
    };
  }
  return null;
}

/** SCRUM-1011 — how an audit row names a change the family made to its record on the booking site. */
export const BOOKING_SITE_SOURCE = 'booking_site';

export interface ChildArchiveResult {
  ok: true;
  /** True when the row was already archived, so this call wrote nothing. */
  alreadyArchived: boolean;
}

/**
 * SCRUM-337 — take a child off the member's saved list.
 *
 * Archived, never deleted. `child.archived_at` is the soft deletion every
 * business record here uses (CLAUDE.md §3), and the reason it has to be one
 * for a child in particular: `visit_child` rows name this child, and each of
 * those is the record that this child WAS at the park on that day. Removing
 * them from the saved list is a statement about the list, not about the past,
 * so the child row stays where the visits point at it and stops appearing on
 * the reads that answer "who is saved against this member" —
 * `memberWithChildren` (the counter's lookup and the member detail) and
 * `listRegister` above, both of which have filtered on `archived_at` since
 * they were written.
 *
 * Idempotent, and this is the whole reason the result says which it was: a
 * second press at the counter, or a retry through a dropped connection whose
 * first attempt landed, finds the row archived and answers the same success
 * with nothing written and no second audit row. A conflict here would be a
 * refusal staff could do nothing about — the child is already off the list,
 * which is what they asked for.
 *
 * The caller has already answered 404 for a child outside its operator; the
 * same predicate is held again here, on the row the write actually touches.
 */
export async function archiveChild(
  tx: Tx,
  actor: ChildArchiveActor,
  childId: string,
): Promise<ChildArchiveResult> {
  const [before] = await tx.select().from(child).where(eq(child.id, childId)).for('update').limit(1);
  if (!before) throw errors.notFound('Child not found');
  // A child id carries no operator of its own, so the guardian is what proves
  // the caller may touch this record. SCRUM-1024 (step F3): the child's own
  // member at `off`; otherwise a live guardian row on its family, inside the
  // operator (the member's own state not asked, as it was not before).
  const [owner] = actor.familyMode === 'off'
    ? await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.id, before.memberId), eq(member.operatorId, actor.operatorId)))
      .limit(1)
    : await tx
      .select({ id: child.id })
      .from(child)
      .where(and(eq(child.id, before.id), childGuardedInOperator({ operatorId: actor.operatorId, memberLive: false })))
      .limit(1);
  if (!owner) throw errors.notFound('Child not found');

  if (before.archivedAt) return { ok: true, alreadyArchived: true };

  const [after] = await tx
    .update(child)
    .set({ archivedAt: new Date() })
    .where(eq(child.id, childId))
    .returning();
  // The same shape the member archive publishes: a box holding this child is
  // told the row is gone, rather than being left with a copy of a profile the
  // guardian has asked to be taken off the list.
  await recordChange(
    tx,
    { operatorId: actor.operatorId, branchId: null },
    { scope: 'members', op: 'delete', entityType: 'child', entityId: childId },
  );
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'child.archive',
    entityType: 'child',
    entityId: childId,
    before: childAuditView(before),
    after: actor.fromDisplay
      ? { ...childAuditView(after), source: CUSTOMER_DISPLAY_SOURCE, stationId: actor.fromDisplay.stationId }
      : actor.fromBookingSite
        ? { ...childAuditView(after), source: BOOKING_SITE_SOURCE }
        : childAuditView(after),
    requestId: actor.requestId,
    ...(actor.fromDisplay
      ? { origin: CUSTOMER_DISPLAY_SOURCE }
      : actor.fromBookingSite
        ? { origin: BOOKING_SITE_SOURCE }
        : {}),
  });
  return { ok: true, alreadyArchived: false };
}

/**
 * A child on a register row: who they are, not how they are.
 *
 * Enough to see that a member has three children aged 4, 6 and 9 — which is
 * what a register is for — and nothing a first-aider would need, which is what
 * the single-member read is for.
 */
export interface RegisterChild {
  id: string;
  name: string;
  dateOfBirth: string | null;
  ageYears: number | null;
}

export interface RegisterRow {
  id: string;
  phone: string;
  nickname: string;
  name: string | null;
  email: string | null;
  tierCode: string;
  preferredChannel: string | null;
  notes: string | null;
  tierVerification: {
    tier: string;
    proofType: string;
    /** What staff typed for an Other document (SCRUM-697); null otherwise. */
    note: string | null;
    verifiedAt: string;
    verifiedBy: string | null;
    expiresAt: string | null;
    /** A recorded document expiry has passed: staff re-check it. The rate holds. */
    reverifyDue: boolean;
  } | null;
  childCount: number;
  children: RegisterChild[];
}

export interface RegisterPage {
  members: RegisterRow[];
  /** Rows matching the filter, not rows on this page. */
  total: number;
  limit: number;
  offset: number;
}

/**
 * `%` and `_` are ILIKE wildcards, so an unescaped search term is a way to
 * ask for everything while looking like a search: `q=%` matched every member.
 * Backslash is Postgres's default ILIKE escape character.
 */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The register page's children through the family: each pair of member and
 * child the read rule gives (`familyChildrenOfMembers`, live members only, as
 * the register lists), then the children themselves by id, live, by name.
 */
async function registerChildrenThroughFamilies(db: Db, operatorId: string, memberIds: string[]) {
  const pairs = await familyChildrenOfMembers(db, { operatorId, memberIds, memberLive: true });
  if (pairs.length === 0) return [];
  const rows = await db
    .select({ id: child.id, name: child.name, dateOfBirth: child.dateOfBirth, ageYears: child.ageYears })
    .from(child)
    .where(and(inArray(child.id, [...new Set(pairs.map((p) => p.childId))]), isNull(child.archivedAt)))
    .orderBy(asc(child.name));
  const seenBy = new Map<string, string[]>();
  for (const p of pairs) seenBy.set(p.childId, [...(seenBy.get(p.childId) ?? []), p.memberId]);
  return rows.flatMap((r) => (seenBy.get(r.id) ?? []).map((memberId) => ({ ...r, memberId })));
}

export async function listRegister(
  db: Db,
  input: { operatorId: string; q?: string | undefined; limit: number; offset: number },
): Promise<RegisterPage> {
  const clauses: SQL[] = [eq(member.operatorId, input.operatorId), isNull(member.archivedAt)];
  const term = input.q?.trim();
  if (term) {
    const pattern = likeTerm(term);
    const match = or(
      ilike(member.nickname, pattern),
      ilike(member.phone, pattern),
      ilike(member.name, pattern),
    );
    if (match) clauses.push(match);
  }
  const where = and(...clauses);

  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(member)
    .where(where);
  const total = counted?.n ?? 0;

  const rows = await db
    .select({
      id: member.id,
      phone: member.phone,
      nickname: member.nickname,
      name: member.name,
      email: member.email,
      tierCode: member.tierCode,
      preferredChannel: member.preferredChannel,
      notes: member.notes,
    })
    .from(member)
    .where(where)
    // Ordered by something stable, because a page is only meaningful against a
    // fixed order: nickname to read by, id to break the ties nicknames leave.
    .orderBy(asc(member.nickname), asc(member.id))
    .limit(input.limit)
    .offset(input.offset);

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    return { members: [], total, limit: input.limit, offset: input.offset };
  }

  // Identity only. The medical columns are not in this select and must not be:
  // see the note at the top of the file.
  //
  // SCRUM-1024 (step F3) — by the switch, read once for this page: at `off`
  // the children saved under each member, as before; otherwise each member's
  // family children (a child of two members' family is on both rows), read by
  // id in the same order with the same columns.
  const familyMode = await familyProfilesMode(db, input.operatorId);
  const children = familyMode === 'off'
    ? await db
      .select({
        id: child.id,
        memberId: child.memberId,
        name: child.name,
        dateOfBirth: child.dateOfBirth,
        ageYears: child.ageYears,
      })
      .from(child)
      .where(and(inArray(child.memberId, ids), isNull(child.archivedAt)))
      .orderBy(asc(child.name))
    : await registerChildrenThroughFamilies(db, input.operatorId, ids);

  const verifications = await db
    .select({
      memberId: memberTierVerification.memberId,
      toTier: memberTierVerification.toTier,
      evidenceType: memberTierVerification.evidenceType,
      evidenceExpiresAt: memberTierVerification.evidenceExpiresAt,
      note: memberTierVerification.note,
      createdAt: memberTierVerification.createdAt,
      staffPhone: account.phone,
      staffName: employee.name,
    })
    .from(memberTierVerification)
    .leftJoin(account, eq(memberTierVerification.verifiedByAccountId, account.id))
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(inArray(memberTierVerification.memberId, ids))
    .orderBy(desc(memberTierVerification.createdAt));

  const childrenByMember = new Map<string, RegisterChild[]>();
  for (const c of children) {
    const list = childrenByMember.get(c.memberId) ?? [];
    list.push({ id: c.id, name: c.name, dateOfBirth: c.dateOfBirth, ageYears: c.ageYears });
    childrenByMember.set(c.memberId, list);
  }

  // Newest first, so the first row seen for a member is its current document.
  const latest = new Map<string, (typeof verifications)[number]>();
  for (const v of verifications) if (!latest.has(v.memberId)) latest.set(v.memberId, v);

  return {
    members: rows.map((r) => {
      const kids = childrenByMember.get(r.id) ?? [];
      const v = latest.get(r.id);
      // A verification holds until it is revoked, exactly as the single-member
      // read answers it: a recorded document expiry that has passed keeps the
      // rate and raises `reverifyDue`.
      //
      // A revocation entitles nothing (SCRUM-317). A revoked member's latest evidence
      // row is the record of an entitlement ENDING, and handing it back as a
      // verification — `{tier: 'tourist', proofType: 'revoked'}` — described
      // the member as holding proof of the rate that needs no proof at all.
      // `memberWithChildren`, which the counter's lookup reads, has filtered
      // those out since SCRUM-241; a register row now answers the same null,
      // so a reader cannot get two different stories about one member from
      // two routes.
      const active = v && !isTierRevocation(v) ? v : null;
      return {
        ...r,
        tierVerification: active
          ? {
              tier: active.toTier,
              proofType: active.evidenceType,
              note: active.note ?? null,
              verifiedAt: active.createdAt.toISOString(),
              verifiedBy: active.staffName ?? active.staffPhone ?? null,
              expiresAt: active.evidenceExpiresAt?.toISOString().slice(0, 10) ?? null,
              reverifyDue: isEvidenceExpired(active.evidenceExpiresAt),
            }
          : null,
        childCount: kids.length,
        children: kids,
      };
    }),
    total,
    limit: input.limit,
    offset: input.offset,
  };
}
