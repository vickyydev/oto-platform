import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { account, branch, employee, fileObject, session as sessionTable } from '@oto/db';
import { normalizePhone } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { holdsGrantAt, outOfBranchScope } from '../services/access-control';
import { audit } from '../services/audit';
import { isPlatformWide } from '../services/permissions';
import { opCtx, withTx } from '../services/tx';

export async function meRoutes(app: App): Promise<void> {
  // SCRUM-25 / SCRUM-19 — who am I: account, employee, branch, permissions.
  app.get('/', { config: { auth: 'session' }, schema: { description: 'Current account profile' } }, async (req) => {
    const auth = req.requireAuth();
    const [acc] = await app.db.select().from(account).where(eq(account.id, auth.accountId)).limit(1);
    if (!acc) throw errors.unauthorized();
    const emp = acc.employeeId
      ? (await app.db.select().from(employee).where(eq(employee.id, acc.employeeId)).limit(1))[0]
      : undefined;
    const br = auth.branchId
      ? (await app.db.select().from(branch).where(eq(branch.id, auth.branchId)).limit(1))[0]
      : undefined;
    const permissions = await req.effectivePermissions();
    const [photo] = await app.db
      .select()
      .from(fileObject)
      .where(and(eq(fileObject.ownerEntityType, 'account'), eq(fileObject.ownerEntityId, acc.id)))
      .orderBy(desc(fileObject.createdAt))
      .limit(1);
    return {
      account: {
        id: acc.id,
        phone: acc.phone,
        status: acc.status,
        mustChangePassword: acc.mustChangePassword,
        operatorId: acc.operatorId,
      },
      employee: emp ? { id: emp.id, name: emp.name, nickname: emp.nickname } : null,
      branch: br ? { id: br.id, name: br.name, code: br.code, timezone: br.timezone } : null,
      isPlatformAdmin: isPlatformWide(permissions),
      photoFileId: photo?.id ?? null,
      // So a reload inside a locked session comes back LOCKED rather than
      // opening the till (S2-01a).
      sessionLocked: auth.lockedAt !== null,
    };
  });

  // SCRUM-13 — effective permissions with scopes.
  app.get('/permissions', { config: { auth: 'session' }, schema: { description: 'Effective permissions with scopes' } }, async (req) => {
    req.requireAuth();
    const permissions = await req.effectivePermissions();
    return { permissions };
  });

  // SCRUM-25 — edit permitted fields (linked employee details). Non-permitted
  // fields are rejected by the strict schema.
  app.patch(
    '/',
    {
      config: { auth: 'session' },
      schema: {
        description: 'Update permitted profile fields',
        body: z
          .object({
            name: z.string().min(1).optional(),
            nickname: z.string().optional(),
            email: z.string().email().optional(),
            phone: z.string().optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [acc] = await app.db.select().from(account).where(eq(account.id, auth.accountId)).limit(1);
      if (!acc?.employeeId) throw errors.badRequest('No employee profile linked to this account');
      const [before] = await app.db.select().from(employee).where(eq(employee.id, acc.employeeId)).limit(1);
      const patch: Partial<typeof employee.$inferInsert> = {};
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.nickname !== undefined) patch.nickname = req.body.nickname;
      if (req.body.email !== undefined) patch.email = req.body.email;
      if (req.body.phone !== undefined) {
        const p = normalizePhone(req.body.phone);
        if (!p) throw errors.badRequest('Invalid phone number');
        patch.phone = p;
      }
      // SCRUM-284 — the change and its record commit together. Written as two
      // statements on the pool, a crash between them left an employee row
      // edited with nothing in the trail saying who edited it.
      const employeeId = acc.employeeId;
      await withTx(app.db, opCtx(req), 'me.update', async (tx) => {
        const [after] = await tx
          .update(employee)
          .set(patch)
          .where(eq(employee.id, employeeId))
          .returning();
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'me.update',
          entityType: 'employee',
          entityId: employeeId,
          before,
          after,
          requestId: req.id,
        });
      });
      return { ok: true };
    },
  );

  /**
   * Active branch switcher (session-scoped).
   *
   * SCRUM-264 — ONLY A BRANCH THE CALLER HOLDS SOMETHING AT.
   *
   * This used to check that the branch belonged to the operator and stop there,
   * which made the session's branch a value the caller writes for themselves:
   * reception at Central Floresta moved their session to Robinson Chalong, and
   * from there `GET /me/stations` listed that park's tills and the picker
   * handed one over. Every route that falls back to `auth.branchId` inherited
   * the same hole, which is why the list routes were moved onto grants
   * (SCRUM-249) — this closes it where it starts.
   *
   * The switcher on the screen was never the way in: it is drawn from
   * `GET /branches`, which is filtered by grants. Anything that can make an
   * HTTP request was.
   */
  app.put(
    '/session/branch',
    { config: { auth: 'session' }, schema: { description: 'Switch the active branch, among those the caller holds a grant at', body: z.object({ branchId: z.string().uuid() }) } },
    async (req) => {
      const auth = req.requireAuth();
      const [br] = await app.db
        .select()
        .from(branch)
        .where(and(eq(branch.id, req.body.branchId), eq(branch.operatorId, auth.operatorId)))
        .limit(1);
      if (!br || br.archivedAt) throw errors.notFound('Branch not found');
      if (!holdsGrantAt(await req.effectivePermissions(), auth.operatorId, br.id)) {
        // 403 rather than the 404 above: inside the caller's own operator the
        // branch's existence is not the secret — they named it — and telling
        // them plainly is what lets somebody ask for access to it.
        throw outOfBranchScope('You hold no access at that branch');
      }
      /**
       * SCRUM-282 — and it leaves a row.
       *
       * SCRUM-264 made this a security boundary: which park a session is
       * seated at decides which tills the picker offers and which branch every
       * route that falls back to `auth.branchId` reads. The grant check above
       * is what stops the move; this is the record that it was made, which is
       * the only way "who was at Chalong at 14:40" has an answer once the
       * session row has been overwritten in place. Inside the transaction, so
       * the move and the record cannot come apart.
       */
      const from = auth.branchId;
      await withTx(app.db, opCtx(req), 'session.branch_switch', async (tx) => {
        await tx
          .update(sessionTable)
          .set({ branchId: br.id })
          .where(eq(sessionTable.id, auth.sessionId));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: br.id,
          action: 'session.branch_switch',
          entityType: 'session',
          entityId: auth.sessionId,
          before: { branchId: from },
          after: { branchId: br.id },
          requestId: req.id,
        });
      });
      return { ok: true };
    },
  );

  // SCRUM-30 / CLAUDE.md §7.4 — the customer display hands the typed phone to
  // the till THROUGH THE API: a short-lived pending lookup on the session.
  app.put(
    '/session/pending-lookup',
    { config: { auth: 'session' }, schema: { description: 'Customer display: stage a membership lookup', body: z.object({ phone: z.string() }) } },
    async (req) => {
      const auth = req.requireAuth();
      await app.db
        .update(sessionTable)
        .set({ pendingLookupPhone: req.body.phone, pendingLookupAt: new Date() })
        .where(eq(sessionTable.id, auth.sessionId));
      return { ok: true };
    },
  );

  app.post(
    '/session/pending-lookup/consume',
    { config: { auth: 'session' }, schema: { description: 'Till: consume the staged lookup (30s TTL)' } },
    async (req) => {
      const auth = req.requireAuth();
      const [row] = await app.db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.id, auth.sessionId))
        .limit(1);
      if (!row?.pendingLookupPhone || !row.pendingLookupAt) return { phone: null };
      await app.db
        .update(sessionTable)
        .set({ pendingLookupPhone: null, pendingLookupAt: null })
        .where(eq(sessionTable.id, auth.sessionId));
      const fresh = Date.now() - row.pendingLookupAt.getTime() < 30_000;
      return { phone: fresh ? row.pendingLookupPhone : null };
    },
  );
}
