import { z } from 'zod';
import type { App } from '../app';
import {
  NANNY_MATCH_TEXT_MAX_CHARS,
  NANNY_NAME_MAX_CHARS,
  addManualNanny,
  nannyBusinessDate,
  nannyDutyView,
  removeNannyShift,
  syncNannyDuty,
  updateNannyMatchText,
} from '../services/nanny-duty';
import { opCtx } from '../services/tx';

/**
 * The park's nannies and their shifts (SCRUM-699), for the Console's Care
 * page: the day's roster as the till sees it, "Sync now" from the OTO App's
 * rota, a nanny added by hand for today, a shift taken off, and the match
 * text. `services/nanny-duty.ts` does the work and states what it never does.
 *
 * The branch is in the path, so every route declares it as its target and
 * the plugin checks the grant against it before the handler runs; the
 * service then refuses (404) a branch of another operator. The permission
 * split mirrors the booth's — looking, staffing the day, configuring the rule:
 *
 *   - read  `pos:checkin:read`, the Care page's own; every counter role holds it;
 *   - staff `pos:checkin:update` for Sync now, add and remove — reception
 *     holds it, which D2 ("reception may add a nanny for the day") needs;
 *   - rule  `catalog:package:update`, the permission every drop-off settings
 *     write already uses.
 *
 * Every write takes an idempotency key through the global plugin, and stores
 * the route's own answer (the view), never an intermediate result.
 */
export async function nannyDutyRoutes(app: App): Promise<void> {
  const READ = 'pos:checkin:read';
  const STAFF = 'pos:checkin:update';
  const RULE = 'catalog:package:update';

  const NannySource = z.enum(['seed', 'app_schedule', 'manual']);
  const NannyAppState = z.enum(['ok', 'app_not_installed', 'no_app_branch', 'ambiguous_app_branch']);
  const NannyUnmatched = z.object({
    name: z.string().nullable(),
    reason: z.enum(['no_employee_row', 'no_name', 'casual_worker']),
  });
  const NannyShiftView = z.object({
    id: z.string().uuid(),
    source: NannySource,
    startsAt: z.string(),
    endsAt: z.string(),
    syncedAt: z.string().nullable(),
    addedByAccountId: z.string().uuid().nullable(),
  });
  const NannyRosterRow = z.object({
    id: z.string().uuid(),
    name: z.string(),
    source: NannySource,
    employeeId: z.string().uuid().nullable(),
    onShift: z.boolean(),
    load: z.number().int(),
    shifts: z.array(NannyShiftView),
  });
  const NannyDutyViewSchema = z.object({
    branchId: z.string().uuid(),
    businessDate: z.string(),
    timezone: z.string(),
    asOf: z.string(),
    rule: z.object({ matchText: z.string(), alsoMatches: z.array(z.string()) }),
    nannies: z.array(NannyRosterRow),
    lastSync: z
      .object({
        syncedAt: z.string(),
        appState: NannyAppState,
        unmatched: z.array(NannyUnmatched),
        syncedByAccountId: z.string().uuid().nullable(),
      })
      .nullable(),
    log: z.array(
      z.object({
        at: z.string(),
        action: z.string(),
        actorAccountId: z.string().uuid().nullable(),
        detail: z.record(z.string(), z.unknown()).nullable(),
      }),
    ),
  });
  const NannySyncAnswer = z.object({
    sync: z.object({
      businessDate: z.string(),
      appState: NannyAppState,
      added: z.number().int(),
      removed: z.number().int(),
      renamed: z.number().int(),
      reshifted: z.number().int(),
      unmatched: z.array(NannyUnmatched),
    }),
    view: NannyDutyViewSchema,
  });
  const BranchParams = z.object({ id: z.string().uuid() });
  const ShiftParams = z.object({ id: z.string().uuid(), shiftId: z.string().uuid() });
  const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

  app.get(
    '/branches/:id/nannies/today',
    {
      config: { permission: READ, target: { branchId: 'params.id' } },
      schema: {
        description:
          'The branch’s nannies for one trading day (SCRUM-699): each nanny with where she came from (the demo seed, the OTO App’s rota, or added by hand), her shifts that overlap the day of any source, whether she is on shift now and her load — both read exactly as the till reads them — the last sync from the OTO App and the names it could not make a nanny, the match text, and the day’s log lines. `date` defaults to the branch’s trading day now. Reads only.',
        params: BranchParams,
        querystring: z.object({ date: IsoDate.optional() }),
        response: { 200: NannyDutyViewSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return nannyDutyView(app.db, { operatorId: auth.operatorId, branchId: req.params.id, date: req.query.date });
    },
  );

  app.post(
    '/branches/:id/nannies/sync',
    {
      config: { permission: STAFF, target: { branchId: 'params.id' } },
      schema: {
        description:
          'Sync now: read the OTO App’s schedule for this branch and today’s trading day, and write the difference into the nanny roster — a new shift audited `nanny_duty.assign`, a changed one `nanny_duty.reshift`, one the rota no longer names `nanny_duty.unassign` (deleted if it has not started, cut short now if it is in progress; a finished shift stays). Nothing is written back to the app; manual and seed shifts are never touched; nothing is removed when the rota cannot be read; no nanny is ever archived. A re-run with nothing changed writes nothing. Casual workers and people with no employee row come back in `unmatched`.',
        params: BranchParams,
        response: { 200: NannySyncAnswer },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const ctx = { ...opCtx(req), branchId: req.params.id };
      const sync = await syncNannyDuty(app.db, ctx, {
        operatorId: auth.operatorId,
        branchId: req.params.id,
        actorAccountId: auth.accountId,
      });
      const view = await nannyDutyView(app.db, {
        operatorId: auth.operatorId,
        branchId: req.params.id,
        date: sync.businessDate,
      });
      return { sync, view };
    },
  );

  app.post(
    '/branches/:id/nannies/manual',
    {
      config: { permission: STAFF, target: { branchId: 'params.id' } },
      schema: {
        description:
          'Add a nanny for the day by hand when nobody is rostered (D2), so a nanny drop-off never blocks: a name and wall-clock hours `from`–`to` on the branch’s day (`to` at or before `from` ends the next day; the API does the time-zone work). The oldest live nanny of the branch with that name is reused, otherwise a new one is made; audited `nanny_duty.assign` with source `manual`. Refused 400 `NANNY_SHIFT_OVER` for a shift that has already ended. The same shift twice changes nothing. A sync never touches it. Answers with the day’s roster.',
        params: BranchParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(NANNY_NAME_MAX_CHARS),
            from: HHMM,
            to: HHMM,
            date: IsoDate.optional(),
          })
          .strict(),
        response: { 200: NannyDutyViewSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const ctx = { ...opCtx(req), branchId: req.params.id };
      const added = await addManualNanny(
        app.db,
        ctx,
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.params.id,
        { name: req.body.name, from: req.body.from, to: req.body.to, date: req.body.date },
      );
      return nannyDutyView(app.db, {
        operatorId: auth.operatorId,
        branchId: req.params.id,
        date: added.businessDate,
      });
    },
  );

  app.delete(
    '/branches/:id/nannies/shifts/:shiftId',
    {
      config: { permission: STAFF, target: { branchId: 'params.id' } },
      schema: {
        description:
          'Take a nanny shift off this branch’s roster, whatever put it there (audited `nanny_duty.unassign`): deleted if it has not started, cut short now if it is in progress. A finished shift stays on the record (409 `NANNY_SHIFT_ENDED`). A shift from the OTO App’s rota comes back at the next sync while the rota still names her — the rota is the staff app’s, and a wrong shift is fixed there. Answers with the shift’s day’s roster.',
        params: ShiftParams,
        response: { 200: NannyDutyViewSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const ctx = { ...opCtx(req), branchId: req.params.id };
      const removed = await removeNannyShift(
        app.db,
        ctx,
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.params.id,
        req.params.shiftId,
      );
      const date =
        removed.businessDate ?? (await nannyBusinessDate(app.db, auth.operatorId, req.params.id));
      return nannyDutyView(app.db, { operatorId: auth.operatorId, branchId: req.params.id, date });
    },
  );

  app.patch(
    '/branches/:id/nannies/rule',
    {
      config: { permission: RULE, target: { branchId: 'params.id' } },
      schema: {
        description:
          'Change the text that makes somebody on the OTO App’s rota a nanny at this branch: matched inside a shift row’s group, department or role name, case-insensitive, surrounding spaces trimmed; “Nanny” by default. พี่เลี้ยง always matches as well, so an empty text turns off only the English term. Audited `nanny_duty.rule`; the next sync applies it. Answers with today’s roster.',
        params: BranchParams,
        body: z.object({ matchText: z.string().max(NANNY_MATCH_TEXT_MAX_CHARS) }).strict(),
        response: { 200: NannyDutyViewSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const ctx = { ...opCtx(req), branchId: req.params.id };
      await updateNannyMatchText(
        app.db,
        ctx,
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.params.id,
        req.body.matchText,
      );
      return nannyDutyView(app.db, { operatorId: auth.operatorId, branchId: req.params.id });
    },
  );
}
