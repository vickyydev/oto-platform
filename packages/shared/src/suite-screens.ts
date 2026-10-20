import type { Permission } from './permissions';

/**
 * THE DEEP-LINK MAP (SCRUM-591, round I1, lane b; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §C).
 *
 * The suite's screens as data, shared by the api (offered to the model as
 * KEYS) and the launcher (rendered as buttons). The model returns a key with
 * parameters and never a URL; the server validates the parameters, builds the
 * path with `buildSuiteScreenPath`, and drops any screen the asker would not
 * be let into (`suiteScreenOffered`). Each entry says which app it is in, the
 * route, what it shows, and what makes it worth offering — a platform
 * permission, an OTO App role floor or OTO App permission, or everyone with
 * the app's tile.
 *
 * The Inbox entries (`inbox.thread`, `inbox.queue`) arrived with
 * prerequisite P2, which gave the Inbox URL state (`apps/inbox/src/lib/url.ts`:
 * `?c=<id>` opens a conversation, `?unanswered=1` the unanswered queue);
 * `apps/inbox/test/url.test.ts` reads every Inbox entry back through that
 * reader, so the two cannot drift apart.
 *
 * THE POS (test night 2026-10-21, W5): one screen, `pos.member`, the till's
 * History page opened on a phone number (`/history?phone=…`), which looks the
 * member's sales up through `GET /sales/lookup`: a "Take me there" for
 * reception after a member lookup. The POS honours the hand-off target the
 * way the Console and the Inbox do (`apps/pos/src/auth/OperatorContext.tsx`).
 *
 * Prerequisite P1 lets the launcher's hand-off carry a target path
 * (`handoff-target.ts`), and the Console, the Inbox and the OTO App land on
 * it. The OTO App is outside the pnpm workspace, so its receiver
 * (`apps/oto-app/client/src/lib/platform-handoff.ts`) carries its own copy of
 * the rule (`apps/oto-app/client/src/lib/handoff-target.ts`), pinned by the
 * same vectors.
 *
 * The console entries copy each page's own gate (`apps/console/src/components/
 * consoleSections.ts`); `apps/console/test/suite-screens.test.ts` compares the
 * two, so a page whose gate moves fails the build until the map follows.
 */

/** The apps a link can open. */
export const SUITE_SCREEN_APPS = ['oto_app', 'console', 'inbox', 'pos', 'launcher'] as const;
export type SuiteScreenApp = (typeof SUITE_SCREEN_APPS)[number];

/** The tile a person needs to open the app at all. The launcher is every session's. */
export const SUITE_SCREEN_APP_ACCESS: Record<SuiteScreenApp, Permission | null> = {
  oto_app: 'app:oto_app:access',
  console: 'app:console:access',
  inbox: 'app:inbox:access',
  pos: 'app:pos:access',
  launcher: null,
};

/** The OTO App's roles, lowest first (`apps/oto-app/server/auth.ts`). */
export const OTOAPP_ROLES = ['staff', 'manager', 'admin', 'operator_admin', 'global_admin'] as const;
export type OtoAppRole = (typeof OTOAPP_ROLES)[number];

/** What makes a screen worth offering, beyond its app's tile. */
export type SuiteScreenGate =
  | { kind: 'everyone' }
  | { kind: 'permission'; permission: Permission }
  /** The OTO App role floor its route table asks (`requiredRole`). */
  | { kind: 'otoapp_role'; floor: 'manager' | 'admin' }
  /** An OTO App permission key, e.g. `hr.view_salary` for payroll. */
  | { kind: 'otoapp_permission'; key: 'hr.view_salary' };

/** One parameter a link takes, and the only shape it may have. */
export interface SuiteScreenParam {
  name: string;
  in: 'path' | 'query';
  kind: 'otoapp_id' | 'uuid' | 'date' | 'month' | 'phone' | 'enum';
  values?: readonly string[];
  required: boolean;
}

export interface SuiteScreen {
  key: string;
  app: SuiteScreenApp;
  /** The route, with `:name` for each path parameter and no query string. */
  path: string;
  /** Query parameters every link to this screen carries (`?tab=time`). */
  fixedQuery?: Readonly<Record<string, string>>;
  params: readonly SuiteScreenParam[];
  /** What the screen shows: the line the model reads and the button's title. */
  shows: string;
  worthOffering: SuiteScreenGate;
}

const id = (name: string): SuiteScreenParam => ({ name, in: 'path', kind: 'otoapp_id', required: true });
const date = (name = 'date'): SuiteScreenParam => ({ name, in: 'query', kind: 'date', required: false });
const MANAGER: SuiteScreenGate = { kind: 'otoapp_role', floor: 'manager' };
const EVERYONE: SuiteScreenGate = { kind: 'everyone' };
const SALARY: SuiteScreenGate = { kind: 'otoapp_permission', key: 'hr.view_salary' };

/** The map (§C), in the plan's order. */
export const SUITE_SCREENS = [
  {
    key: 'oto.employee.time',
    app: 'oto_app',
    path: '/employees/:id',
    fixedQuery: { tab: 'time' },
    params: [id('id')],
    shows: 'Time & leave on the employee file',
    worthOffering: MANAGER,
  },
  {
    key: 'oto.timekeeping.employee',
    app: 'oto_app',
    path: '/timekeeping-review/employee/:employeeId',
    params: [id('employeeId'), date()],
    shows: "One person's clock review",
    worthOffering: MANAGER,
  },
  {
    key: 'oto.timekeeping.issues',
    app: 'oto_app',
    path: '/timekeeping-review',
    fixedQuery: { tab: 'issues' },
    params: [date()],
    shows: "The day's timekeeping issues",
    worthOffering: MANAGER,
  },
  {
    key: 'oto.timekeeping.missing',
    app: 'oto_app',
    path: '/timekeeping/live',
    fixedQuery: { tab: 'missing' },
    params: [],
    shows: 'Who has not clocked in',
    worthOffering: MANAGER,
  },
  {
    key: 'oto.scheduling',
    app: 'oto_app',
    path: '/scheduling',
    params: [],
    shows: 'The scheduling board',
    worthOffering: MANAGER,
  },
  { key: 'oto.rota', app: 'oto_app', path: '/core/rota', params: [], shows: 'My rota', worthOffering: EVERYONE },
  {
    key: 'oto.availability',
    app: 'oto_app',
    path: '/core/my-availability',
    params: [],
    shows: 'My availability',
    worthOffering: EVERYONE,
  },
  { key: 'oto.payroll.hub', app: 'oto_app', path: '/payroll', params: [], shows: 'The payroll hub', worthOffering: SALARY },
  {
    key: 'oto.payroll.month',
    app: 'oto_app',
    path: '/payroll/month-end',
    params: [
      { name: 'month', in: 'query', kind: 'month', required: true },
      { name: 'tab', in: 'query', kind: 'enum', values: ['preview', 'outputs'], required: false },
    ],
    shows: 'One month-end',
    worthOffering: SALARY,
  },
  {
    key: 'oto.payroll.person',
    app: 'oto_app',
    path: '/payroll/people/:employeeId',
    params: [id('employeeId')],
    shows: 'One payroll profile',
    worthOffering: SALARY,
  },
  {
    key: 'oto.payslips.mine',
    app: 'oto_app',
    path: '/payroll/me/payslips',
    params: [],
    shows: 'My payslips',
    worthOffering: EVERYONE,
  },
  {
    key: 'oto.checklists.today',
    app: 'oto_app',
    path: '/core/today',
    params: [],
    shows: "Today's checklists",
    worthOffering: EVERYONE,
  },
  {
    key: 'oto.checklists.ops',
    app: 'oto_app',
    path: '/ops',
    fixedQuery: { tab: 'checklists' },
    params: [],
    shows: 'Checklist operations',
    worthOffering: MANAGER,
  },
  { key: 'oto.ask', app: 'oto_app', path: '/core/ask', params: [], shows: 'Ask OTO (SOPs, KB)', worthOffering: EVERYONE },
  { key: 'oto.account', app: 'oto_app', path: '/my-account', params: [], shows: 'My account', worthOffering: EVERYONE },
  {
    key: 'console.health',
    app: 'console',
    path: '/health',
    params: [],
    shows: 'Platform health',
    worthOffering: { kind: 'permission', permission: 'admin:health:read' },
  },
  {
    key: 'console.failures',
    app: 'console',
    path: '/failures',
    params: [],
    shows: 'Open failures',
    worthOffering: { kind: 'permission', permission: 'admin:health:read' },
  },
  {
    key: 'console.activity',
    app: 'console',
    path: '/activity',
    params: [],
    shows: 'The audit trail',
    worthOffering: { kind: 'permission', permission: 'admin:audit:read' },
  },
  {
    key: 'console.devices',
    app: 'console',
    path: '/devices',
    params: [],
    shows: 'Stations, boxes and devices',
    worthOffering: { kind: 'permission', permission: 'admin:station:read' },
  },
  {
    key: 'console.branches',
    app: 'console',
    path: '/branches',
    params: [],
    shows: 'Branches',
    worthOffering: { kind: 'permission', permission: 'admin:branch:read' },
  },
  {
    key: 'console.bookings',
    app: 'console',
    path: '/bookings',
    params: [],
    shows: 'Bookings',
    worthOffering: { kind: 'permission', permission: 'pos:booking:read' },
  },
  {
    key: 'console.vouchers',
    app: 'console',
    path: '/vouchers',
    params: [],
    shows: 'Vouchers',
    // The page's own gate (consoleSections.ts): vouchers sit with the booths.
    worthOffering: { kind: 'permission', permission: 'admin:booth:read' },
  },
  {
    key: 'inbox.thread',
    app: 'inbox',
    path: '/',
    params: [{ name: 'c', in: 'query', kind: 'uuid', required: true }],
    shows: 'One conversation in the Inbox',
    // Whether THIS conversation is one the asker may read is the Inbox api's
    // call when the link is opened; a refused one lands on the list (P2).
    worthOffering: { kind: 'permission', permission: 'inbox:conversation:read' },
  },
  {
    key: 'inbox.queue',
    app: 'inbox',
    path: '/',
    fixedQuery: { unanswered: '1' },
    params: [],
    shows: 'The unanswered queue',
    worthOffering: { kind: 'permission', permission: 'inbox:conversation:read' },
  },
  {
    key: 'pos.member',
    app: 'pos',
    path: '/history',
    // The phone as the asker typed it or as a member summary shows it; History normalises it (`parseHistorySearch`).
    params: [{ name: 'phone', in: 'query', kind: 'phone', required: true }],
    shows: "The member's sales on the till (History)",
    worthOffering: { kind: 'permission', permission: 'pos:member:read' },
  },
  { key: 'launcher.account', app: 'launcher', path: '/account', params: [], shows: 'My account', worthOffering: EVERYONE },
] as const satisfies readonly SuiteScreen[];

export type SuiteScreenKey = (typeof SUITE_SCREENS)[number]['key'];

export const SUITE_SCREEN_KEYS: readonly SuiteScreenKey[] = SUITE_SCREENS.map((s) => s.key);

export function findSuiteScreen(key: string): SuiteScreen | undefined {
  return (SUITE_SCREENS as readonly SuiteScreen[]).find((s) => s.key === key);
}

const PARAM_SHAPE: Record<Exclude<SuiteScreenParam['kind'], 'enum'>, RegExp> = {
  otoapp_id: /^[A-Za-z0-9-]{1,64}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-(0[1-9]|1[0-2])$/,
  /** A phone as typed or as a screen shows it: digits with spaces, dashes or brackets, an optional leading +. */
  phone: /^\+?\d[\d\s()-]{6,24}$/,
};

function paramOk(param: SuiteScreenParam, value: string): boolean {
  if (param.kind === 'enum') return (param.values ?? []).includes(value);
  return PARAM_SHAPE[param.kind].test(value);
}

/**
 * The relative path of one link, or null when the key is unknown, a required
 * parameter is missing, a value has the wrong shape, or a parameter is one the
 * screen does not take. The model's words never reach a path unchecked: every
 * value matches its declared shape before it is encoded.
 */
export function buildSuiteScreenPath(key: string, params: Readonly<Record<string, string>> = {}): string | null {
  const screen = findSuiteScreen(key);
  if (!screen) return null;
  const known = new Set(screen.params.map((p) => p.name));
  if (Object.keys(params).some((name) => !known.has(name))) return null;
  let path = screen.path;
  const query = new URLSearchParams(screen.fixedQuery ?? {});
  for (const p of screen.params) {
    const value = params[p.name];
    if (value === undefined || value === '') {
      if (p.required) return null;
      continue;
    }
    if (!paramOk(p, value)) return null;
    if (p.in === 'path') path = path.replace(`:${p.name}`, encodeURIComponent(value));
    else query.set(p.name, value);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/** What the server knows about the asker when it filters links. */
export interface SuiteScreenViewer {
  /** Holds the platform permission somewhere in the operator. */
  has(permission: Permission): boolean;
  /**
   * The asker's OTO App role and permission keys, when the ask opened an OTO
   * App session (round I4). Unknown means an OTO App screen gated on a role or
   * a permission is not offered: a link is a courtesy, never a guess.
   */
  otoApp?: { role: OtoAppRole; permissions: readonly string[] } | null;
}

const ROLE_FLOOR: Record<'manager' | 'admin', readonly OtoAppRole[]> = {
  manager: ['manager', 'admin', 'operator_admin', 'global_admin'],
  admin: ['admin', 'operator_admin', 'global_admin'],
};

/** Whether a screen is worth offering this asker: the app's tile, then its own gate. */
export function suiteScreenOffered(screen: SuiteScreen, viewer: SuiteScreenViewer): boolean {
  const access = SUITE_SCREEN_APP_ACCESS[screen.app];
  if (access && !viewer.has(access)) return false;
  const gate = screen.worthOffering;
  switch (gate.kind) {
    case 'everyone':
      return true;
    case 'permission':
      return viewer.has(gate.permission);
    case 'otoapp_role':
      return !!viewer.otoApp && ROLE_FLOOR[gate.floor].includes(viewer.otoApp.role);
    case 'otoapp_permission':
      return !!viewer.otoApp && viewer.otoApp.permissions.includes(gate.key);
  }
}
