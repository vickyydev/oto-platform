import { z } from 'zod';
import { EMPLOYEE_SOURCES } from '@oto/db';
import { BENEFIT_ROLES, BenefitProfileSchema, BenefitProfileShapeSchema } from '@oto/shared';
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
}
