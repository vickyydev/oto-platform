import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { account, branch, child, employee, member, memberTierVerification, tier } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import {
  REGISTER_PAGE_DEFAULT,
  REGISTER_PAGE_MAX,
  isEvidenceExpired,
  listRegister,
} from '../services/members';
import { recordChange } from '../services/sync';
import { opCtx, withTx } from '../services/tx';

/**
 * What a box holds a copy of (S2-05).
 *
 * A member edited at reception has to reach the boxes that cache members, and
 * the delta is written in the SAME transaction as the edit — so a member who
 * exists and a feed that says so commit together. What travels is only what a
 * till reads at the identify step: never the staff notes, never the email,
 * never the tier evidence. See the cache bundle in `services/sync.ts` for the
 * full account of what a box is and is not given.
 */
function memberCacheView(row: typeof member.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    phone: row.phone,
    nickname: row.nickname,
    name: row.name,
    tierCode: row.tierCode,
    preferredChannel: row.preferredChannel,
  };
}

function childCacheView(row: typeof child.$inferSelect): Record<string, unknown> {
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

const ChildBody = z.object({
  name: z.string().min(1),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  ageYears: z.number().int().min(0).max(17).optional().nullable(),
  allergies: z.string().optional().nullable(),
  medicalNotes: z.string().optional().nullable(),
  medicalAlert: z.boolean().optional(),
  dietary: z.string().optional().nullable(),
  foodRestrictions: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

function serializeChild(c: typeof child.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    dateOfBirth: c.dateOfBirth,
    ageYears: c.ageYears,
    allergies: c.allergies,
    medicalNotes: c.medicalNotes,
    medicalAlert: c.medicalAlert,
    dietary: c.dietary,
    foodRestrictions: c.foodRestrictions,
    notes: c.notes,
    lastConfirmedAt: c.lastConfirmedAt?.toISOString() ?? null,
  };
}

/** Display name of the staff account that checked the document. */
async function staffName(app: App, accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  const [row] = await app.db
    .select({ phone: account.phone, name: employee.name })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(eq(account.id, accountId))
    .limit(1);
  return row ? (row.name ?? row.phone) : null;
}

/**
 * Always by member id AND operator (S2-01d, finding B4). A member id is not
 * proof of anything: it is copied into support requests, audit rows and URLs,
 * and this helper returns the member's phone, notes and every child's
 * allergies and medical notes. Taking the operator as a required argument
 * means a call site cannot forget the scope — it has to pass one, and the only
 * one it has is the caller's own session.
 */
async function memberWithChildren(app: App, memberId: string, operatorId: string) {
  const [m] = await app.db
    .select()
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.operatorId, operatorId)))
    .limit(1);
  if (!m) return null;
  const children = await app.db
    .select()
    .from(child)
    .where(and(eq(child.memberId, memberId), isNull(child.archivedAt)));
  const [verification] = await app.db
    .select()
    .from(memberTierVerification)
    .where(eq(memberTierVerification.memberId, memberId))
    .orderBy(desc(memberTierVerification.createdAt))
    .limit(1);
  // An expired document no longer entitles the discounted rate: the POS sees
  // no verification and asks for fresh proof (the row itself stays for audit).
  const active =
    verification && !isEvidenceExpired(verification.evidenceExpiresAt) ? verification : null;
  return {
    id: m.id,
    phone: m.phone,
    nickname: m.nickname,
    name: m.name,
    email: m.email,
    tierCode: m.tierCode,
    preferredChannel: m.preferredChannel,
    notes: m.notes,
    tierVerification: active
      ? {
          tier: active.toTier,
          proofType: active.evidenceType,
          verifiedAt: active.createdAt.toISOString(),
          verifiedBy: await staffName(app, active.verifiedByAccountId),
          expiresAt: active.evidenceExpiresAt?.toISOString().slice(0, 10) ?? null,
        }
      : null,
    children: children.map(serializeChild),
  };
}

export async function memberRoutes(app: App): Promise<void> {
  // SCRUM-30 — find a returning member by phone (any input format).
  app.get(
    '/lookup',
    {
      config: { permission: 'pos:member:read' },
      schema: {
        description: 'Look up a member by phone, with children and tier verification',
        querystring: z.object({ phone: z.string() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const phone = normalizePhone(req.query.phone);
      if (!phone) return { member: null };
      const [m] = await app.db
        .select()
        .from(member)
        .where(
          and(
            eq(member.operatorId, auth.operatorId),
            eq(member.phone, phone),
            isNull(member.archivedAt),
          ),
        )
        .limit(1);
      if (!m) return { member: null };
      return { member: await memberWithChildren(app, m.id, auth.operatorId) };
    },
  );

  /**
   * The register: browse or search every member (SCRUM-246).
   *
   * Guarded by `pos:member:list`, NOT by the `pos:member:read` that guards the
   * lookup above, because the two are different acts. Reception looking up the
   * visitor at the counter asks by phone and gets one member. This asks for
   * the list — the park's whole customer file — and until this ticket one
   * request with no search term answered with all of it, every child's
   * allergies and medical notes included, on a permission every till session
   * holds. A shared or phished till was the whole register.
   *
   * Why a distinct permission rather than "a search term of at least N
   * characters": the administrator's Members panel legitimately opens on the
   * whole list and would break under a mandatory term, and a term would not
   * stop an enumerator anyway — `a`, `b`, `c` walks the register in
   * twenty-six requests. Who may browse is the question worth answering, and
   * a permission is where that answer belongs. The term is escaped and paged
   * regardless.
   *
   * Rows carry each child's identity and never their health notes; those stay
   * on `GET /members/:id`, which is the read reception already does one
   * visitor at a time.
   */
  app.get(
    '/',
    {
      config: { permission: 'pos:member:list' },
      schema: {
        description:
          'Browse or search the member register (paged; no child medical fields in a row)',
        querystring: z.object({
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(REGISTER_PAGE_MAX).default(REGISTER_PAGE_DEFAULT),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listRegister(app.db, {
        operatorId: auth.operatorId,
        q: req.query.q,
        limit: req.query.limit,
        offset: req.query.offset,
      });
    },
  );

  // Soft delete (archive) — no hard deletes of business records (CLAUDE.md §3).
  app.delete(
    '/:id',
    {
      config: { permission: 'pos:member:update' },
      schema: { description: 'Archive a member', params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(member)
        .where(and(eq(member.id, req.params.id), eq(member.operatorId, auth.operatorId)))
        .limit(1);
      if (!before) throw errors.notFound('Member not found');
      return withTx(app.db, opCtx(req), 'member.archive', async (tx) => {
        await tx.update(member).set({ archivedAt: new Date() }).where(eq(member.id, req.params.id));
        // A box holding this member drops it on the next pull: an archived
        // member must not still be findable at a counter that is offline.
        await recordChange(tx, { operatorId: auth.operatorId, branchId: null }, {
          scope: 'members',
          op: 'delete',
          entityType: 'member',
          entityId: req.params.id,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'member.archive',
          entityType: 'member',
          entityId: req.params.id,
          before,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  app.get(
    '/:id',
    {
      config: { permission: 'pos:member:read' },
      schema: {
        description: 'Member detail with children',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // 404 rather than 403 when the member belongs to another operator: the
      // existence of another tenant's record is not ours to confirm.
      const m = await memberWithChildren(app, req.params.id, auth.operatorId);
      if (!m) throw errors.notFound('Member not found');
      return { member: m };
    },
  );

  // SCRUM-31 — create from phone + nickname only; duplicates rejected clearly.
  app.post(
    '/',
    {
      config: { permission: 'pos:member:create' },
      schema: {
        description: 'Create a member (phone + name only)',
        body: z.object({
          /**
           * Client-minted UUIDv7 (S2-01b). A till that mints the id can retry
           * a create through a dropped connection without risking a second
           * member: sending the same id again returns the row that exists.
           */
          id: z.string().uuid().optional(),
          phone: z.string(),
          nickname: z.string().min(1),
          preferredChannel: z.enum(['whatsapp', 'telegram', 'line']).optional(),
          createdVia: z.enum(['pos', 'booking', 'import']).default('pos'),
        }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const phone = normalizePhone(req.body.phone);
      if (!phone) throw errors.badRequest('Invalid phone number');

      if (req.body.id) {
        const [already] = await app.db
          .select()
          .from(member)
          .where(and(eq(member.id, req.body.id), eq(member.operatorId, auth.operatorId)))
          .limit(1);
        if (already) {
          reply.header('x-oto-replay', 'true');
          return { member: await memberWithChildren(app, already.id, auth.operatorId) };
        }
      }

      const [existing] = await app.db
        .select()
        .from(member)
        .where(and(eq(member.operatorId, auth.operatorId), eq(member.phone, phone)))
        .limit(1);
      if (existing) {
        // Same code the unique-violation mapper produces when two tills race
        // past this check (S2-01a) — one condition, one code, either path.
        throw errors.conflict('MEMBER_PHONE_EXISTS', 'A member with this phone already exists', {
          memberId: existing.id,
        });
      }
      const id = req.body.id ?? newId();
      await withTx(app.db, opCtx(req), 'member.create', async (tx) => {
        const [created] = await tx
          .insert(member)
          .values({
            id,
            operatorId: auth.operatorId,
            phone,
            nickname: req.body.nickname.trim(),
            preferredChannel: req.body.preferredChannel ?? null,
            createdVia: req.body.createdVia,
          })
          .returning();
        await recordChange(tx, { operatorId: auth.operatorId, branchId: null }, {
          scope: 'members',
          entityType: 'member',
          entityId: id,
          payload: memberCacheView(created!),
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'member.create',
          entityType: 'member',
          entityId: id,
          after: { phone, nickname: req.body.nickname.trim() },
          requestId: req.id,
        });
      });
      return { member: await memberWithChildren(app, id, auth.operatorId) };
    },
  );

  // SCRUM-31 — enrich.
  app.patch(
    '/:id',
    {
      config: { permission: 'pos:member:update' },
      schema: {
        description: 'Enrich a member',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            nickname: z.string().min(1).optional(),
            name: z.string().optional().nullable(),
            email: z.string().email().optional().nullable(),
            notes: z.string().optional().nullable(),
            preferredChannel: z.enum(['whatsapp', 'telegram', 'line']).optional().nullable(),
            phone: z.string().optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(member)
        .where(and(eq(member.id, req.params.id), eq(member.operatorId, auth.operatorId)))
        .limit(1);
      if (!before) throw errors.notFound('Member not found');
      const patch: Partial<typeof member.$inferInsert> = {};
      const b = req.body;
      if (b.nickname !== undefined) patch.nickname = b.nickname.trim();
      if (b.name !== undefined) patch.name = b.name;
      if (b.email !== undefined) patch.email = b.email;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.preferredChannel !== undefined) patch.preferredChannel = b.preferredChannel;
      if (b.phone !== undefined) {
        const p = normalizePhone(b.phone);
        if (!p) throw errors.badRequest('Invalid phone number');
        patch.phone = p;
      }
      await withTx(app.db, opCtx(req), 'member.update', async (tx) => {
        const [after] = await tx
          .update(member)
          .set(patch)
          .where(eq(member.id, req.params.id))
          .returning();
        await recordChange(tx, { operatorId: auth.operatorId, branchId: null }, {
          scope: 'members',
          entityType: 'member',
          entityId: req.params.id,
          payload: memberCacheView(after!),
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'member.update',
          entityType: 'member',
          entityId: req.params.id,
          before,
          after,
          requestId: req.id,
        });
      });
      return { member: await memberWithChildren(app, req.params.id, auth.operatorId) };
    },
  );

  // Tier verification (beyond the prototype): staff checked a discount-tier
  // proof document at the counter. WHO checked is stamped server-side from the
  // session — the caller cannot supply or spoof it — along with branch + time.
  app.post(
    '/:id/tier-verification',
    {
      config: { permission: 'pos:member:update' },
      schema: {
        description: 'Record a checked tier proof document (verifier stamped from the session)',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            toTier: z.string().min(1),
            evidenceType: z.string().min(1),
            evidenceExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            note: z.string().optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [m] = await app.db
        .select()
        .from(member)
        .where(
          and(
            eq(member.id, req.params.id),
            eq(member.operatorId, auth.operatorId),
            isNull(member.archivedAt),
          ),
        )
        .limit(1);
      if (!m) throw errors.notFound('Member not found');

      // Tiers are data (D2) — the target tier must exist for this operator.
      const [tierRow] = await app.db
        .select()
        .from(tier)
        .where(and(eq(tier.operatorId, auth.operatorId), eq(tier.code, req.body.toTier)))
        .limit(1);
      if (!tierRow) throw errors.badRequest(`Unknown tier "${req.body.toTier}"`);

      const expires = new Date(`${req.body.evidenceExpiresAt}T00:00:00Z`);
      if (isEvidenceExpired(expires)) {
        throw errors.badRequest(
          'The document has already expired — it cannot verify a discounted rate',
        );
      }

      const id = newId();
      // The evidence and the tier it grants are one act: a member must never
      // hold a discounted tier with no document behind it, or the reverse.
      await withTx(app.db, opCtx(req), 'member.tier_verify', async (tx) => {
        await tx.insert(memberTierVerification).values({
          id,
          memberId: m.id,
          fromTier: m.tierCode,
          toTier: req.body.toTier,
          evidenceType: req.body.evidenceType,
          evidenceExpiresAt: expires,
          verifiedByAccountId: auth.accountId,
          branchId: auth.branchId,
          note: req.body.note ?? null,
        });
        await tx.update(member).set({ tierCode: req.body.toTier }).where(eq(member.id, m.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'member.tier_verify',
          entityType: 'member_tier_verification',
          entityId: id,
          before: { tierCode: m.tierCode },
          after: {
            memberId: m.id,
            toTier: req.body.toTier,
            evidenceType: req.body.evidenceType,
            evidenceExpiresAt: req.body.evidenceExpiresAt,
          },
          requestId: req.id,
        });
      });
      return { member: await memberWithChildren(app, m.id, auth.operatorId) };
    },
  );

  /**
   * Admin record-checking: every tier upgrade with document, expiry, the staff
   * member who checked it, branch and timestamp (newest first).
   *
   * On `pos:member:list` with the register, and no longer on the counter's
   * `pos:member:read` (SCRUM-246). Two hundred rows of member nickname and
   * phone is a register by another name, so closing `GET /members` to a till
   * session while leaving this open would have moved the door rather than
   * shut it. The screen that reads it is an admin panel either way.
   */
  app.get(
    '/tier-verifications',
    {
      config: { permission: 'pos:member:list' },
      schema: { description: 'List tier verification records for record checking' },
    },
    async (req) => {
      const auth = req.requireAuth();
      const rows = await app.db
        .select({
          v: memberTierVerification,
          memberNickname: member.nickname,
          memberPhone: member.phone,
          staffPhone: account.phone,
          staffName: employee.name,
          branchName: branch.name,
        })
        .from(memberTierVerification)
        .innerJoin(member, eq(memberTierVerification.memberId, member.id))
        .leftJoin(account, eq(memberTierVerification.verifiedByAccountId, account.id))
        .leftJoin(employee, eq(account.employeeId, employee.id))
        .leftJoin(branch, eq(memberTierVerification.branchId, branch.id))
        .where(eq(member.operatorId, auth.operatorId))
        .orderBy(desc(memberTierVerification.createdAt))
        .limit(200);
      return {
        verifications: rows.map((r) => ({
          id: r.v.id,
          member: { id: r.v.memberId, nickname: r.memberNickname, phone: r.memberPhone },
          fromTier: r.v.fromTier,
          toTier: r.v.toTier,
          evidenceType: r.v.evidenceType,
          evidenceExpiresAt: r.v.evidenceExpiresAt?.toISOString().slice(0, 10) ?? null,
          expired: isEvidenceExpired(r.v.evidenceExpiresAt),
          verifiedBy: r.staffName ?? r.staffPhone ?? null,
          branch: r.branchName ?? null,
          note: r.v.note,
          verifiedAt: r.v.createdAt.toISOString(),
        })),
      };
    },
  );

  // SCRUM-32 — children CRUD (allergy edits audited).
  app.post(
    '/:id/children',
    {
      config: { permission: 'pos:child:create' },
      schema: {
        description: 'Add a child to a member',
        params: z.object({ id: z.string().uuid() }),
        body: ChildBody,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // The guardian proves the tenancy: a child is only reachable through a
      // member of the caller's own operator.
      const [m] = await app.db
        .select()
        .from(member)
        .where(and(eq(member.id, req.params.id), eq(member.operatorId, auth.operatorId)))
        .limit(1);
      if (!m) throw errors.notFound('Member not found');
      const id = newId();
      await withTx(app.db, opCtx(req), 'child.create', async (tx) => {
        const [created] = await tx.insert(child).values({
          id,
          memberId: req.params.id,
          name: req.body.name.trim(),
          dateOfBirth: req.body.dateOfBirth ?? null,
          ageYears: req.body.ageYears ?? null,
          allergies: req.body.allergies ?? null,
          medicalNotes: req.body.medicalNotes ?? null,
          medicalAlert: req.body.medicalAlert ?? Boolean(req.body.allergies),
          dietary: req.body.dietary ?? null,
          foodRestrictions: req.body.foodRestrictions ?? null,
          notes: req.body.notes ?? null,
          consentRecordedAt: new Date(),
        }).returning();
        await recordChange(tx, { operatorId: auth.operatorId, branchId: null }, {
          scope: 'members',
          entityType: 'child',
          entityId: id,
          payload: childCacheView(created!),
        });
        // SCRUM-283 — `tx`, not `app.db`. On the pool this row committed the
        // moment it was written, from inside a transaction that could still
        // roll back: an audit entry describing a child that does not exist,
        // sitting beside the `child.create.failed` row for the same attempt,
        // and no later cleanup can tell it from a real one.
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'child.create',
          entityType: 'child',
          entityId: id,
          after: req.body,
          requestId: req.id,
        });
      });
      const [c] = await app.db.select().from(child).where(eq(child.id, id)).limit(1);
      return { child: serializeChild(c!) };
    },
  );

  app.patch(
    '/children/:childId',
    {
      config: { permission: 'pos:child:update' },
      schema: {
        description: 'Update a child (allergies etc.) — audited',
        params: z.object({ childId: z.string().uuid() }),
        body: ChildBody.partial(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(child)
        .where(eq(child.id, req.params.childId))
        .limit(1);
      if (!before) throw errors.notFound('Child not found');
      // A child id carries no operator, so the guardian is what proves the
      // caller may touch this record — and the refusal is the same 404 as an
      // id that does not exist at all.
      const [owner] = await app.db
        .select()
        .from(member)
        .where(and(eq(member.id, before.memberId), eq(member.operatorId, auth.operatorId)))
        .limit(1);
      if (!owner) throw errors.notFound('Child not found');
      const patch: Partial<typeof child.$inferInsert> = {};
      const b = req.body;
      if (b.name !== undefined) patch.name = b.name;
      if (b.dateOfBirth !== undefined) patch.dateOfBirth = b.dateOfBirth;
      if (b.ageYears !== undefined) patch.ageYears = b.ageYears;
      if (b.allergies !== undefined) {
        patch.allergies = b.allergies;
        patch.medicalAlert = b.medicalAlert ?? Boolean(b.allergies);
      }
      if (b.medicalNotes !== undefined) patch.medicalNotes = b.medicalNotes;
      if (b.medicalAlert !== undefined) patch.medicalAlert = b.medicalAlert;
      if (b.dietary !== undefined) patch.dietary = b.dietary;
      if (b.foodRestrictions !== undefined) patch.foodRestrictions = b.foodRestrictions;
      if (b.notes !== undefined) patch.notes = b.notes;
      return withTx(app.db, opCtx(req), 'child.update', async (tx) => {
        const [after] = await tx
          .update(child)
          .set(patch)
          .where(eq(child.id, req.params.childId))
          .returning();
        // An allergy edited at reception has to reach the box that will warn
        // the kitchen tonight, whether or not it has internet by then.
        await recordChange(tx, { operatorId: auth.operatorId, branchId: null }, {
          scope: 'members',
          entityType: 'child',
          entityId: req.params.childId,
          payload: childCacheView(after!),
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'child.update',
          entityType: 'child',
          entityId: req.params.childId,
          before,
          after,
          requestId: req.id,
        });
        return { child: serializeChild(after!) };
      });
    },
  );
}
