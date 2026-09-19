import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { account, branch, child, employee, member, memberTierVerification, tier } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';

const ChildBody = z.object({
  name: z.string().min(1),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
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

/** The document stays valid through the whole expiry DAY it names. */
function isEvidenceExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt.getTime() + 24 * 60 * 60 * 1000;
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

async function memberWithChildren(app: App, memberId: string) {
  const [m] = await app.db.select().from(member).where(eq(member.id, memberId)).limit(1);
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
  const active = verification && !isEvidenceExpired(verification.evidenceExpiresAt) ? verification : null;
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
      schema: {
        description: 'Look up a member by phone, with children and tier verification',
        querystring: z.object({ phone: z.string() }),
      },
    },
    async (req) => {
      await req.requirePermission('pos:member:read');
      const phone = normalizePhone(req.query.phone);
      if (!phone) return { member: null };
      const auth = req.auth!;
      const [m] = await app.db
        .select()
        .from(member)
        .where(
          and(eq(member.operatorId, auth.operatorId), eq(member.phone, phone), isNull(member.archivedAt)),
        )
        .limit(1);
      if (!m) return { member: null };
      return { member: await memberWithChildren(app, m.id) };
    },
  );

  // Admin list/search.
  app.get(
    '/',
    { schema: { description: 'List/search members', querystring: z.object({ q: z.string().optional() }) } },
    async (req) => {
      const auth = await req.requirePermission('pos:member:read');
      const base = and(eq(member.operatorId, auth.operatorId), isNull(member.archivedAt));
      const rows = req.query.q
        ? await app.db
            .select()
            .from(member)
            .where(and(base, or(ilike(member.nickname, `%${req.query.q}%`), ilike(member.phone, `%${req.query.q}%`))))
            .limit(50)
        : await app.db.select().from(member).where(base).limit(50);
      // Full objects (children + active verification) — the admin panel edits in place.
      const full = await Promise.all(rows.map((m) => memberWithChildren(app, m.id)));
      return { members: full.filter((m) => m !== null) };
    },
  );

  // Soft delete (archive) — no hard deletes of business records (CLAUDE.md §3).
  app.delete(
    '/:id',
    { schema: { description: 'Archive a member', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = await req.requirePermission('pos:member:update');
      const [before] = await app.db
        .select()
        .from(member)
        .where(and(eq(member.id, req.params.id), eq(member.operatorId, auth.operatorId)))
        .limit(1);
      if (!before) throw errors.notFound('Member not found');
      await app.db.update(member).set({ archivedAt: new Date() }).where(eq(member.id, req.params.id));
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        branchId: auth.branchId,
        action: 'member.archive',
        entityType: 'member',
        entityId: req.params.id,
        before,
        requestId: req.id,
      });
      return { ok: true };
    },
  );

  app.get(
    '/:id',
    { schema: { description: 'Member detail with children', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      await req.requirePermission('pos:member:read');
      const m = await memberWithChildren(app, req.params.id);
      if (!m) throw errors.notFound('Member not found');
      return { member: m };
    },
  );

  // SCRUM-31 — create from phone + nickname only; duplicates rejected clearly.
  app.post(
    '/',
    {
      schema: {
        description: 'Create a member (phone + name only)',
        body: z.object({
          phone: z.string(),
          nickname: z.string().min(1),
          preferredChannel: z.enum(['whatsapp', 'telegram', 'line']).optional(),
          createdVia: z.enum(['pos', 'booking', 'import']).default('pos'),
        }),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('pos:member:create');
      const phone = normalizePhone(req.body.phone);
      if (!phone) throw errors.badRequest('Invalid phone number');
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
      const id = newId();
      await app.db.insert(member).values({
        id,
        operatorId: auth.operatorId,
        phone,
        nickname: req.body.nickname.trim(),
        preferredChannel: req.body.preferredChannel ?? null,
        createdVia: req.body.createdVia,
      });
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        branchId: auth.branchId,
        action: 'member.create',
        entityType: 'member',
        entityId: id,
        after: { phone, nickname: req.body.nickname.trim() },
        requestId: req.id,
      });
      return { member: await memberWithChildren(app, id) };
    },
  );

  // SCRUM-31 — enrich.
  app.patch(
    '/:id',
    {
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
      const auth = await req.requirePermission('pos:member:update');
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
      const [after] = await app.db.update(member).set(patch).where(eq(member.id, req.params.id)).returning();
      await audit.record(app.db, {
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
      return { member: await memberWithChildren(app, req.params.id) };
    },
  );

  // Tier verification (client extension): staff checked a discount-tier proof
  // document at the counter. WHO checked is stamped server-side from the
  // session — the client cannot supply or spoof it — along with branch + time.
  app.post(
    '/:id/tier-verification',
    {
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
      const auth = await req.requirePermission('pos:member:update');
      const [m] = await app.db
        .select()
        .from(member)
        .where(and(eq(member.id, req.params.id), eq(member.operatorId, auth.operatorId), isNull(member.archivedAt)))
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
        throw errors.badRequest('The document has already expired — it cannot verify a discounted rate');
      }

      const id = newId();
      await app.db.insert(memberTierVerification).values({
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
      await app.db.update(member).set({ tierCode: req.body.toTier }).where(eq(member.id, m.id));
      await audit.record(app.db, {
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
      return { member: await memberWithChildren(app, m.id) };
    },
  );

  // Admin record-checking: every tier upgrade with document, expiry, the staff
  // member who checked it, branch and timestamp (newest first).
  app.get(
    '/tier-verifications',
    { schema: { description: 'List tier verification records for record checking' } },
    async (req) => {
      const auth = await req.requirePermission('pos:member:read');
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
      schema: {
        description: 'Add a child to a member',
        params: z.object({ id: z.string().uuid() }),
        body: ChildBody,
      },
    },
    async (req) => {
      const auth = await req.requirePermission('pos:child:create');
      const [m] = await app.db.select().from(member).where(eq(member.id, req.params.id)).limit(1);
      if (!m || m.operatorId !== auth.operatorId) throw errors.notFound('Member not found');
      const id = newId();
      await app.db.insert(child).values({
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
      });
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        branchId: auth.branchId,
        action: 'child.create',
        entityType: 'child',
        entityId: id,
        after: req.body,
        requestId: req.id,
      });
      const [c] = await app.db.select().from(child).where(eq(child.id, id)).limit(1);
      return { child: serializeChild(c!) };
    },
  );

  app.patch(
    '/children/:childId',
    {
      schema: {
        description: 'Update a child (allergies etc.) — audited',
        params: z.object({ childId: z.string().uuid() }),
        body: ChildBody.partial(),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('pos:child:update');
      const [before] = await app.db.select().from(child).where(eq(child.id, req.params.childId)).limit(1);
      if (!before) throw errors.notFound('Child not found');
      const [owner] = await app.db.select().from(member).where(eq(member.id, before.memberId)).limit(1);
      if (!owner || owner.operatorId !== auth.operatorId) throw errors.notFound('Child not found');
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
      const [after] = await app.db.update(child).set(patch).where(eq(child.id, req.params.childId)).returning();
      await audit.record(app.db, {
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
    },
  );
}
