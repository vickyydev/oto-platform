import { z } from 'zod';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { account, branch, employee, fileObject, session as sessionTable } from '@oto/db';
import {
  THEME_PREFERENCES,
  UI_LANGUAGES,
  normalizePhone,
  uiPreferencesUpdateSchema,
  type UiPreferences,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { holdsGrantAt, outOfBranchScope } from '../services/access-control';
import { audit } from '../services/audit';
import { isPlatformWide } from '../services/permissions';
import { switchSessionOperator } from '../services/operator-switch';
import { opCtx, withTx } from '../services/tx';

/** What `GET /me` and `PUT /me/preferences` answer as `preferences` (SCRUM-653). */
const PreferencesShape = z.object({
  theme: z.enum(THEME_PREFERENCES),
  language: z.enum(UI_LANGUAGES),
});

const OperatorContextShape = z.object({
  homeOperatorId: z.string().uuid(),
  effectiveOperatorId: z.string().uuid(),
  operatorOverride: z.string().uuid().nullable(),
  branchId: z.string().uuid().nullable(),
  stationId: z.string().uuid().nullable(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const MeShape = z.object({
  account: z.object({ id: z.string().uuid(), phone: z.string(), status: z.enum(['invited', 'active', 'inactive']),
    mustChangePassword: z.boolean(), operatorId: z.string().uuid() }),
  employee: z.object({ id: z.string().uuid(), name: z.string(), nickname: z.string().nullable() }).nullable(),
  branch: z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), timezone: z.string() }).nullable(),
  isPlatformAdmin: z.boolean(),
  photoFileId: z.string().uuid().nullable(),
  sessionLocked: z.boolean(),
  preferences: PreferencesShape,
  operatorContext: OperatorContextShape.extend({ sessionId: z.string().uuid() }),
});

function preferencesOf(row: { uiTheme: UiPreferences['theme']; uiLanguage: UiPreferences['language'] }): UiPreferences {
  return { theme: row.uiTheme, language: row.uiLanguage };
}

export async function meRoutes(app: App): Promise<void> {
  // SCRUM-25 / SCRUM-19 — who am I: account, employee, branch, permissions.
  app.get('/', { config: { auth: 'session' }, schema: { description: 'Current home account and working session context', response: { 200: MeShape } } }, async (req) => {
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
      // SCRUM-653 — how every staff app looks for this person, applied by
      // each app as it reads this answer at sign-in.
      preferences: preferencesOf(acc),
      // Home identity stays factual. Working scope belongs to this verified
      // session and includes a revision so A-B-A cannot revive stale controls.
      operatorContext: {
        sessionId: auth.sessionId,
        homeOperatorId: acc.operatorId,
        effectiveOperatorId: auth.operatorId,
        operatorOverride: auth.operatorOverride ?? null,
        branchId: auth.branchId,
        stationId: auth.stationId,
        revision: auth.operatorRevision ?? 0,
      },
    };
  });

  app.put('/session/operator', {
    config: { permission: 'platform:operator:switch', target: { operator: true } },
    schema: {
      description: 'Select the working operator for this staff session, preserving the real home account',
      headers: z.object({ 'idempotency-key': z.string().min(1).max(200) }).passthrough(),
      body: z.object({ operatorId: z.string().uuid().nullable(),
        expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
      response: { 200: OperatorContextShape.extend({ changed: z.boolean() }) },
    },
  }, async req => {
    const auth = req.requireAuth();
    return switchSessionOperator(app.db, { accountId: auth.accountId, sessionId: auth.sessionId,
      operatorId: req.body.operatorId, expectedRevision: req.body.expectedRevision }, opCtx(req));
  });

  /**
   * SCRUM-653 — the person's own theme and language, written back from any
   * staff app's toggle. Either field alone, so one app's theme change cannot
   * carry a stale language over another's. Only the caller's own account:
   * there is no id in the path to name anybody else's. Setting a value to
   * what it already is still answers 200 and still records a row, so a
   * retried write and the first are indistinguishable to the app.
   */
  app.put(
    '/preferences',
    {
      config: { auth: 'session' },
      schema: {
        description: "Set the caller's own theme and language, shown by every staff app",
        body: uiPreferencesUpdateSchema,
        response: { 200: z.object({ preferences: PreferencesShape }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // The transaction's value IS the stored answer a retried key replays
      // (services/tx.ts), so it returns the whole response.
      return withTx(app.db, opCtx(req), 'account.preferences', async (tx) => {
        const [before] = await tx
          .select({ uiTheme: account.uiTheme, uiLanguage: account.uiLanguage })
          .from(account)
          .where(eq(account.id, auth.accountId))
          .limit(1)
          .for('update');
        if (!before) throw errors.unauthorized();
        const patch: Partial<typeof account.$inferInsert> = {};
        if (req.body.theme !== undefined) patch.uiTheme = req.body.theme;
        if (req.body.language !== undefined) patch.uiLanguage = req.body.language;
        const [after] = await tx
          .update(account)
          .set(patch)
          .where(eq(account.id, auth.accountId))
          .returning({ uiTheme: account.uiTheme, uiLanguage: account.uiLanguage });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'account.preferences',
          entityType: 'account',
          entityId: auth.accountId,
          before: preferencesOf(before),
          after: preferencesOf(after!),
          requestId: req.id,
        });
        return { preferences: preferencesOf(after!) };
      });
    },
  );

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
      /**
       * S2-17b round 2 (H5, conflict C13) — a copied employee's name,
       * nickname, email and phone are the OTO App's. An edit here would be
       * silently undone by the next copy, so it is refused in words instead,
       * before anything is written. Nothing else on the platform writes these
       * fields on a copied row.
       */
      if (before?.source === 'otoapp') {
        const mirrored = (['name', 'nickname', 'email', 'phone'] as const).filter(
          (field) => req.body[field] !== undefined,
        );
        if (mirrored.length > 0) {
          throw errors.conflict(
            'EMPLOYEE_KEPT_IN_OTO_APP',
            'Your name, nickname, email and phone are kept in the OTO App. Change them there, and they reach here at the next copy.',
            { fields: mirrored },
          );
        }
      }
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
        // The source check above ran on the pool: an adoption by the copy can
        // commit between it and this write, and then the edit would land on a
        // row that is now the OTO App's and be silently undone by the next
        // copy (H5). Every field this route edits is a mirrored one, so the
        // write itself refuses a row the copy has taken.
        const [after] = await tx
          .update(employee)
          .set(patch)
          .where(and(eq(employee.id, employeeId), ne(employee.source, 'otoapp')))
          .returning();
        if (!after) {
          throw errors.conflict(
            'EMPLOYEE_KEPT_IN_OTO_APP',
            'Your name, nickname, email and phone are kept in the OTO App. Change them there, and they reach here at the next copy.',
            { fields: Object.keys(patch) },
          );
        }
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
    { config: { auth: 'session' }, schema: { description: 'Switch the active branch, among those the caller holds a grant at', body: z.object({ branchId: z.string().uuid() }), response: { 200: z.object({ ok: z.literal(true) }) } } },
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
        const [updated] = await tx
          .update(sessionTable)
          .set({ branchId: br.id, ...(from !== br.id ? { stationId: null } : {}) })
          .where(and(eq(sessionTable.id, auth.sessionId), eq(sessionTable.accountId, auth.accountId),
            auth.operatorOverride == null ? isNull(sessionTable.operatorOverride) : eq(sessionTable.operatorOverride, auth.operatorOverride),
            from === null ? isNull(sessionTable.branchId) : eq(sessionTable.branchId, from),
            auth.stationId === null ? isNull(sessionTable.stationId) : eq(sessionTable.stationId, auth.stationId),
            isNull(sessionTable.revokedAt), gt(sessionTable.expiresAt, new Date()), isNull(sessionTable.lockedAt)))
          .returning({ id: sessionTable.id });
        // The earlier grant/branch checks belong to this exact working seat.
        // A later operator or seat selection cannot inherit their write.
        if (!updated) throw errors.conflict('SESSION_CONTEXT_CHANGED', 'The session context changed. Read it again before selecting a branch.');
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
      return { ok: true as const };
    },
  );

  // Membership entry now uses the independently paired station display.
}
