import { z } from 'zod';
import { EMPLOYEE_SOURCES } from '@oto/db';
import {
  BENEFIT_ONLINE_ONLY_STAGES,
  BENEFIT_ROLES,
  BenefitProfileSchema,
  BenefitProfileShapeSchema,
  BenefitTargetSchema,
} from '@oto/shared';
import type { App } from '../app';
import {
  benefitTemplateHistory,
  benefitToday,
  effectiveBenefitOn,
  listBenefitTemplates,
  listStaffBenefits,
  saveBenefitTemplate,
  saveStaffBenefit,
  staffBenefitHistory,
} from '../services/benefits';
import {
  benefitCredentialQr,
  issueBenefitCredential,
  listBenefitCredentials,
  resolveBenefitCredential,
  revokeBenefitCredential,
} from '../services/benefit-credentials';
import { listBenefitApplications } from '../services/benefit-checkout';
import { branchReach } from '../services/access-control';
import { opCtx } from '../services/tx';

/**
 * Admin > Staff Benefits (S2-21, SCRUM-218, round 1 of
 * docs/progress/plans/benefits/PLAN.md §5): the role templates, who takes
 * which, their overrides, and the history of every change. The rules are in
 * `services/benefits.ts`.
 *
 * **Operator-wide, like the prototype's templates** (catalogStore.ts:1150 —
 * "global"). These routes name no branch: the guard checks the permission
 * against the caller's operator and session branch, every by-id route loads
 * the employee inside the caller's operator, and the session's branch decides
 * only which trading day "today" is.
 *
 * Two permissions: `admin:benefit:read` to look — a branch manager has it —
 * and `admin:benefit:manage` to change, which only the operator's
 * administrators hold (plan "Permissions").
 */

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');
const Role = z.enum(BENEFIT_ROLES);

const Author = z.object({ accountId: z.string().uuid(), name: z.string().nullable() }).nullable();

const VersionFields = {
  id: z.string().uuid(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  createdAt: z.string(),
  createdBy: Author,
};

const TemplateVersion = z.object({ ...VersionFields, profile: BenefitProfileShapeSchema });
const ProfileVersion = z.object({
  ...VersionFields,
  benefitRole: Role.nullable(),
  override: BenefitProfileShapeSchema.nullable(),
});

const Template = z.object({
  role: Role,
  name: z.string(),
  current: TemplateVersion.nullable(),
  upcoming: z.array(TemplateVersion),
});

const Staff = z.object({
  employeeId: z.string().uuid(),
  name: z.string(),
  nickname: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
  branchName: z.string().nullable(),
  source: z.enum(EMPLOYEE_SOURCES),
  current: ProfileVersion.nullable(),
  upcoming: z.array(ProfileVersion),
  effectiveProfile: BenefitProfileShapeSchema,
});

const Credential = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  kid: z.string(),
  version: z.number().int(),
  status: z.enum(['active', 'revoked', 'expired']),
  issuedAt: z.string(),
  expiresAt: z.string(),
  issuedBy: Author,
  revokedAt: z.string().nullable(),
  revokedBy: Author,
  lastSeenAt: z.string().nullable(),
});

const EffectiveFrom = IsoDay.optional().describe(
  'The trading day the change counts from. Today when absent; a day before today is refused.',
);

const RoleParams = z.object({ role: Role });
const EmployeeParams = z.object({ employeeId: z.string().uuid() });

export async function benefitRoutes(app: App): Promise<void> {
  const todayOf = (req: { requireAuth: () => { operatorId: string; branchId: string | null } }) => {
    const auth = req.requireAuth();
    return benefitToday(app.db, { operatorId: auth.operatorId, branchId: auth.branchId });
  };

  app.get(
    '/templates',
    {
      config: { permission: 'admin:benefit:read' },
      schema: {
        description:
          'The Owner, Manager and Staff benefit templates: the version in force today (null for a role never given one) and any saved for a later day, soonest first. "Today" is the trading day of the branch the session is at.',
        response: { 200: z.object({ today: IsoDay, templates: z.array(Template) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listBenefitTemplates(app.db, auth.operatorId, await todayOf(req));
    },
  );

  app.get(
    '/templates/:role',
    {
      config: { permission: 'admin:benefit:read' },
      schema: {
        description:
          'One role template and its history: every version ever saved, newest first, with the trading days it counts on (`effectiveTo` exclusive; equal to `effectiveFrom` when it was replaced before it started), who saved it and when.',
        params: RoleParams,
        response: {
          200: z.object({ today: IsoDay, template: Template, versions: z.array(TemplateVersion) }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return benefitTemplateHistory(app.db, auth.operatorId, req.params.role, await todayOf(req));
    },
  );

  app.put(
    '/templates/:role',
    {
      config: { permission: 'admin:benefit:manage' },
      schema: {
        description:
          'Save a role template from a trading day (today when absent). The version in force that day is closed on it and a new one runs from it to wherever the closed one ran — or, with nothing in force that day, to the next version already saved. A change dated tomorrow leaves today unchanged. A save identical to the version in force that day writes nothing (`changed: false`). Every category or menu item the profile names must be this operator’s. Audited `benefit.template_update`.',
        params: RoleParams,
        body: z.object({ profile: BenefitProfileSchema, effectiveFrom: EffectiveFrom }),
        response: { 200: z.object({ changed: z.boolean(), template: Template }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return saveBenefitTemplate(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.params.role,
        req.body,
        await todayOf(req),
      );
    },
  );

  app.get(
    '/profiles',
    {
      config: { permission: 'admin:benefit:read' },
      schema: {
        description:
          'Every current staff member of the operator (`core.employee`, read only: the OTO App is the employee master) with their benefit role and override today, any change saved for a later day, and the profile a scan would apply today.',
        response: { 200: z.object({ today: IsoDay, staff: z.array(Staff) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listStaffBenefits(app.db, auth.operatorId, await todayOf(req));
    },
  );

  app.get(
    '/profiles/:employeeId',
    {
      config: { permission: 'admin:benefit:read' },
      schema: {
        description:
          'One staff member’s benefit and its history: every version saved, newest first, with who saved it and when. Another operator’s employee is a 404.',
        params: EmployeeParams,
        response: {
          200: z.object({ today: IsoDay, staff: Staff, versions: z.array(ProfileVersion) }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return staffBenefitHistory(
        app.db,
        auth.operatorId,
        req.params.employeeId,
        await todayOf(req),
      );
    },
  );

  app.put(
    '/profiles/:employeeId',
    {
      config: { permission: 'admin:benefit:manage' },
      schema: {
        description:
          'Set a staff member’s benefit role (null: no benefit) and override (null: their role’s template as it stands; set: their whole profile while it is on) from a trading day, versioned exactly as a template is. An override needs a role. Someone who has left (archived) is refused. Audited `benefit.profile_update`.',
        params: EmployeeParams,
        body: z.object({
          benefitRole: Role.nullable(),
          override: BenefitProfileSchema.nullable(),
          effectiveFrom: EffectiveFrom,
        }),
        response: { 200: z.object({ changed: z.boolean(), staff: Staff }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return saveStaffBenefit(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.params.employeeId,
        req.body,
        await todayOf(req),
      );
    },
  );

  app.get(
    '/profiles/:employeeId/effective',
    {
      config: { permission: 'admin:benefit:read' },
      schema: {
        description:
          'The one profile that applies to this staff member on a trading day (today when `on` is absent): their override if one is on, otherwise their role’s template in force that day, otherwise nothing. Exactly one answer for any day.',
        params: EmployeeParams,
        querystring: z.object({ on: IsoDay.optional() }),
        response: {
          200: z.object({
            employeeId: z.string().uuid(),
            on: IsoDay,
            benefitRole: Role.nullable(),
            hasOverride: z.boolean(),
            profileVersionId: z.string().uuid().nullable(),
            templateVersionId: z.string().uuid().nullable(),
            profile: BenefitProfileShapeSchema,
            isEmpty: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const on = req.query.on ?? (await todayOf(req));
      return effectiveBenefitOn(app.db, auth.operatorId, req.params.employeeId, on);
    },
  );

  // --- The Audit log (round 3) -------------------------------------------------

  app.get(
    '/applications',
    {
      config: { permission: 'admin:benefit:read' },
      schema: {
        description:
          'The Staff Benefits Audit log: every staff benefit applied to an order that was recorded, newest first (200 at most) — whose QR, their benefit role, who processed it at which station and box, whether it was a comp, the four amounts and the total in satang, what came off the bill, and the sale and its receipt number. Kept whatever later happens to the order: a refund gives no quota back (plan Q4’s default) and the entry says what the order has since given back in money (`saleStatus`, `refundedSatang`). An application taken off, or moved to the order rung up again, before its order was paid is not an entry. Read per branch: a reader holding `admin:benefit:read` at some branches reads only their applications; `branchId` narrows to one branch, refused (403) for a branch the caller does not hold.',
        querystring: z.object({ branchId: z.string().uuid().optional() }),
        response: {
          200: z.object({
            applications: z.array(
              z.object({
                id: z.string().uuid(),
                at: z.string(),
                employeeId: z.string().uuid(),
                employeeName: z.string(),
                benefitRole: Role,
                processedByAccountId: z.string().uuid(),
                processedByName: z.string().nullable(),
                isComp: z.boolean(),
                compedSatang: z.number().int(),
                freeItemsSatang: z.number().int(),
                creditSatang: z.number().int(),
                discountSatang: z.number().int(),
                totalReliefSatang: z.number().int(),
                appliedSatang: z.number().int(),
                saleId: z.string().uuid(),
                receiptNumber: z.string().nullable(),
                branchId: z.string().uuid(),
                stationId: z.string().uuid(),
                boxId: z.string().uuid().nullable(),
                origin: z.enum(['cloud', 'box']),
                saleStatus: z.enum(['finalised', 'refunded']),
                refundedSatang: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      /**
       * S2-21 round 4 (from the round 3 review) — WHOSE ROWS. The templates
       * and the staff list are operator-wide configuration; these rows are one
       * branch's sales, so they are read by the caller's reach, as the audit
       * log's own route reads its rows (`branchReach`).
       */
      if (req.query.branchId) {
        await req.requirePermission('admin:benefit:read', { branchId: req.query.branchId });
        return {
          applications: await listBenefitApplications(app.db, auth.operatorId, [req.query.branchId]),
        };
      }
      const reach = branchReach(await req.effectivePermissions(), 'admin:benefit:read', auth.operatorId);
      return {
        applications: await listBenefitApplications(
          app.db,
          auth.operatorId,
          reach.kind === 'operator' ? 'all' : reach.branchIds,
        ),
      };
    },
  );

  // --- The benefit QR (round 2) ----------------------------------------------
  //
  // Issued, printed and revoked under `admin:benefit:credential_issue`, which
  // only the operator's administrators hold: a branch manager reads the
  // screen and sees which QRs exist, and cannot print one — the printed code
  // IS the credential, and showing it is handing it over. Resolved at the till
  // under `pos:benefit:apply`. The rules are in `services/benefit-credentials.ts`.

  app.get(
    '/credentials',
    {
      config: { permission: 'admin:benefit:read' },
      schema: {
        description:
          'The benefit QRs issued in this operator — or one staff member’s with `employeeId` — newest first, with their status (`active`, `revoked`, `expired`), who issued and who revoked each, and when one last applied a benefit. Never the code: printing it is `GET /benefits/credentials/:id/qr`.',
        querystring: z.object({ employeeId: z.string().uuid().optional() }),
        response: { 200: z.object({ credentials: z.array(Credential) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return {
        credentials: await listBenefitCredentials(app.db, auth.operatorId, {
          employeeId: req.query.employeeId,
        }),
      };
    },
  );

  app.post(
    '/credentials',
    {
      config: { permission: 'admin:benefit:credential_issue' },
      schema: {
        description:
          'Issue a staff member’s benefit QR: an Ed25519-signed `OTO-BEN:v1` credential under the `benefit_qr` key, good for a year. One live QR per person — a second is refused (`BENEFIT_CREDENTIAL_LIVE`) until the first is revoked — and nobody without a benefit role gets one (`BENEFIT_NO_ROLE`). The answer is the credential’s record, never the code, so a retried request replays nothing that can be scanned. 503 `BENEFIT_QR_UNAVAILABLE` when the deployment has no `BENEFIT_QR_PRIVATE_KEY`. Audited `benefit.credential_issue`.',
        body: z.object({ employeeId: z.string().uuid() }),
        response: { 200: z.object({ credential: Credential }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return issueBenefitCredential(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.body.employeeId,
        app.env,
        await todayOf(req),
      );
    },
  );

  app.get(
    '/credentials/:credentialId/qr',
    {
      config: { permission: 'admin:benefit:credential_issue' },
      schema: {
        description:
          'The printable payload behind the Staff Benefits QR dialog: the staff member’s name and the code the QR encodes (and the line printed under it). Re-derived from the record and the key, never stored; refused for a QR that is revoked, expired, or whose holder has left, and for one signed under a key this deployment no longer holds. Not cached.',
        params: z.object({ credentialId: z.string().uuid() }),
        response: {
          200: z.object({
            credentialId: z.string().uuid(),
            employeeId: z.string().uuid(),
            name: z.string(),
            code: z.string(),
            expiresAt: z.string(),
          }),
        },
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const payload = await benefitCredentialQr(
        app.db,
        auth.operatorId,
        req.params.credentialId,
        app.env,
      );
      void reply.header('cache-control', 'no-store');
      return payload;
    },
  );

  app.post(
    '/credentials/:credentialId/revoke',
    {
      config: { permission: 'admin:benefit:credential_issue' },
      schema: {
        description:
          'Revoke a benefit QR. The cloud refuses it from this moment ("Benefit revoked"); every box refuses it from its next pull of the `benefits` cache scope, which carries the revocation list — until then, a box that is offline is bounded by the QR’s own expiry. Revoking one already revoked changes nothing (`changed: false`). Audited `benefit.credential_revoke`.',
        params: z.object({ credentialId: z.string().uuid() }),
        response: { 200: z.object({ changed: z.boolean(), credential: Credential }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return revokeBenefitCredential(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.params.credentialId,
      );
    },
  );

  app.post(
    '/resolve',
    {
      config: {
        permission: 'pos:benefit:apply',
        /**
         * S2-21 round 3 (from the round 2 review) — resolve's answers are kept
         * out of the replay store altogether. Each is computed from a scanned
         * credential, and a refusal echoes what was read (short of a
         * signature); the route writes nothing, so a retry is the same lookup
         * asked again, not a second effect a stored answer must prevent.
         */
        secretResponse: true,
      },
      schema: {
        description:
          'A scanned or typed staff benefit QR, resolved online: the staff member it names and the profile that applies to them today (the trading day of the session’s branch), with what of it a box may apply offline. Applies nothing and uses up nothing. Refused in the prototype’s words — `No staff benefit found for "<code>".` (404, a benefit QR echoed only up to its signature) for anything this park did not issue, `<name> has no benefit configured.` (409 `BENEFIT_NOT_CONFIGURED`) — and in the platform’s for a QR that is revoked (409 `BENEFIT_REVOKED`, "Benefit revoked"), expired, or whose holder has left.',
        body: z.object({ code: z.string().min(1).max(512) }),
        response: {
          200: z.object({
            employeeId: z.string().uuid(),
            name: z.string(),
            credentialId: z.string().uuid(),
            on: IsoDay,
            benefitRole: Role,
            hasOverride: z.boolean(),
            profile: BenefitProfileShapeSchema,
            offline: z.object({
              comp: z.boolean(),
              standingDiscount: z
                .object({ percent: z.number(), target: BenefitTargetSchema.optional() })
                .nullable(),
              onlineOnly: z.array(z.enum(BENEFIT_ONLINE_ONLY_STAGES)),
            }),
            expiresAt: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return resolveBenefitCredential(app.db, {
        operatorId: auth.operatorId,
        code: req.body.code,
        today: await todayOf(req),
      });
    },
  );
}
