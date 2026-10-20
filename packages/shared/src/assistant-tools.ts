import { z } from 'zod';

/**
 * THE INTERNAL ASSISTANT'S SHARED CONTRACT (SCRUM-591, round I1, lane b).
 *
 * Plan: docs/progress/plans/internal-assistant-build/PLAN.md §B (the tool
 * registry), §D.3 (the ask-log), §D.4 (refusals). This file is the DATA side:
 * the vocabulary the ask-log's CHECKs are built from (`@oto/db`
 * `assistant.ask`, `assistant.tool_call`), the shapes the api and the launcher
 * both read, and the registry's list of tools — their names, the system that
 * owns the data, the existing GET route each one calls, what the model reads,
 * and the arguments it may give. The adapters that build a path and summarise
 * a body live in the api (`apps/api/src/services/assistant/tools/*`, round I2)
 * and are keyed by the names here.
 *
 * THE RULE THE TYPES HOLD (§B.1, G9). A tool is an existing GET route called
 * with the asker's own session. A route template is typed `GET /…`, so a write
 * tool does not compile, and the `assistant-registry` census
 * (`apps/api/test/assistant-registry.test.ts`) fails the build if a platform
 * route is not a registered, guarded GET.
 */

// --- The ask-log's vocabulary (§D.3) -----------------------------------------

/**
 * Where an ask is. `asking` is the row as it is first written — before any
 * model call, so a retry under the same id finds it (§D.1) — and the other
 * six are the plan's final states.
 */
export const ASSISTANT_ASK_STATES = [
  'asking',
  'answered',
  'refused',
  'link_only',
  'failed',
  'capped',
  'off',
] as const;
export type AssistantAskState = (typeof ASSISTANT_ASK_STATES)[number];

/** The asker's verdict on an answer (spec §4): `wrong` may carry a correction. */
export const ASSISTANT_FEEDBACK = ['good', 'wrong'] as const;
export type AssistantFeedback = (typeof ASSISTANT_FEEDBACK)[number];

/** Which system owns the data a tool reads, and so whose fence answers (§B, X5). */
export const ASSISTANT_TOOL_SYSTEMS = ['platform', 'oto_app'] as const;
export type AssistantToolSystem = (typeof ASSISTANT_TOOL_SYSTEMS)[number];

/** The limits the database holds the ask-log to, said once (§D.3) — in `assistant-limits.ts`, import-free. */
export * from './assistant-limits';

/**
 * The one-word shapes the ask-log's CHECKs allow (§E.1: ids and words, never
 * text, outside `question`, `answer`, `correction` and the refusal lines).
 * The database states each again as a regex; `packages/db/test/assistant-i1b`
 * pins the two.
 */
export const ASSISTANT_REASON_WORD = /^[A-Z][A-Z0-9_]{0,47}$/;
export const ASSISTANT_VERSION_WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
/** A tool name: dotted lower-case words, `members.lookup`, `oto.employees.find`. */
export const ASSISTANT_TOOL_NAME = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$/;
/** A route TEMPLATE, never a URL with values: GET only, no query string. */
export const ASSISTANT_ROUTE_TEMPLATE = /^GET \/[A-Za-z0-9_:./-]{0,199}$/;
/** An error code as a route returns it: `FORBIDDEN`, `MUST_CHANGE_PASSWORD`, `not_provisioned`. */
export const ASSISTANT_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * A refusal as the route gave it (§D.4): stored on the ask row and rendered
 * by the server under the answer, prefixed by the system's name. `message`
 * is the route's own envelope text, verbatim — never the model's.
 */
export const AssistantRefusalSchema = z.object({
  tool: z.string().regex(ASSISTANT_TOOL_NAME),
  system: z.enum(ASSISTANT_TOOL_SYSTEMS),
  status: z.number().int().min(400).max(599),
  code: z.string().regex(ASSISTANT_ERROR_CODE).nullable(),
  message: z.string().max(500),
});
export type AssistantRefusal = z.infer<typeof AssistantRefusalSchema>;

/** How a refusal line reads under the answer: "OTO App: …" / "Platform: …". */
export const ASSISTANT_SYSTEM_LABEL: Record<AssistantToolSystem, string> = {
  platform: 'Platform',
  oto_app: 'OTO App',
};

// --- The registry (§B.4) ------------------------------------------------------

/** A route template: GET only, by type (§B.1 — no write tools in Phase 3). */
export type AssistantRouteTemplate = `GET /${string}`;

/**
 * What an adapter hands the model in place of a body (§B.4): named fields,
 * capped rows with a `more` count, precomputed figures, at most 4 KB; over
 * it, `truncated` and the model offers the link.
 */
export interface AssistantToolSummary {
  data: unknown;
  /** Rows the projection left out. */
  more?: number;
  truncated?: boolean;
}

/** The ceiling on one summary's serialised size (§B.4). */
export const ASSISTANT_SUMMARY_MAX_BYTES = 4096;
/** Rows a summary carries before `more` (§B.4). */
export const ASSISTANT_SUMMARY_ROWS = 20;

/** A tool as the registry and the launcher know it: the data, no behaviour. */
export interface AssistantToolSpec<I = unknown> {
  name: string;
  system: AssistantToolSystem;
  /**
   * The existing route(s) the tool calls, as templates — for the census and
   * the `tool_call.route` column. One for every tool but `me.whoami`, which
   * reads the profile and the permission scopes (the plan's table names both).
   */
  routes: readonly [AssistantRouteTemplate, ...AssistantRouteTemplate[]];
  /** What the model reads. */
  description: string;
  /** Validated before any call; the model's arguments, never a URL. */
  input: z.ZodType<I>;
}

/**
 * The api's adapter over a spec (round I2): the spec plus the two functions
 * the model never touches. `path` builds the URL from validated input;
 * `summarise` projects the body.
 */
export interface AssistantToolDef<I = unknown> extends AssistantToolSpec<I> {
  path(input: I): string;
  summarise(body: unknown): AssistantToolSummary;
  /** The screen that shows the same thing (§C), as a key the server resolves. */
  deepLink?: (input: I) => { key: string; params: Record<string, string> } | null;
}

const Uuid = z.string().uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is YYYY-MM');
/** An OTO App id (`employees.id` is a varchar uuid there): one token, no path characters. */
const OtoAppId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const None = z.object({}).strict();

/**
 * Child medical notes reach the model only when the question was about them
 * (§B.4): otherwise the adapter reduces them to `medicalAlert`.
 */
const MemberInclude = z.array(z.enum(['allergies'])).max(1).optional();

/** Keeps each tool's name as a literal, so `AssistantToolName` is the list. */
const spec = <N extends string, S extends z.ZodTypeAny>(
  s: Omit<AssistantToolSpec<z.infer<S>>, 'name' | 'input'> & { name: N; input: S },
) => s;

/**
 * THE TOOLS (§B.4), sorted by name so the definitions the model sees are
 * cache-stable (§D.2). Platform tools land in round I2; the `oto.*` tools in
 * round I4, behind `INTERNAL_AI_OTOAPP_TOOLS` and the owner's G1. Nothing over
 * the C1–C3 fence gaps (G2) is listed.
 */
export const ASSISTANT_TOOLS = [
  spec({
    name: 'audit.search',
    system: 'platform',
    routes: ['GET /audit'],
    description:
      'Search the audit trail: who did what, to what, and when. At most 20 rows; masked unless the asker may read sensitive fields.',
    input: z
      .object({
        action: z.string().max(80).optional(),
        entityType: z.string().max(60).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .strict(),
  }),
  spec({
    name: 'branches.list',
    system: 'platform',
    routes: ['GET /branches'],
    description: "The parks the asker can see, with each one's id, name and code. Use it to turn a park's name into its id.",
    input: None,
  }),
  spec({
    name: 'checkin.board',
    system: 'platform',
    routes: ['GET /checkin/board'],
    description: "The drop-off board at one park: counts by state and up to 20 children's names.",
    input: z.object({ branchId: Uuid }).strict(),
  }),
  spec({
    name: 'inbox.queue',
    system: 'platform',
    routes: ['GET /inbox/conversations'],
    description: "The Inbox conversations the asker can see: unanswered, mine and team counts, and up to 10 thread titles.",
    input: z.object({ tab: z.enum(['mine', 'team']).optional() }).strict(),
  }),
  spec({
    name: 'me.whoami',
    system: 'platform',
    routes: ['GET /me', 'GET /me/permissions'],
    description: "The asker: their name, seat park, roles and permission scopes. For 'what can I do' questions.",
    input: None,
  }),
  spec({
    name: 'members.get',
    system: 'platform',
    routes: ['GET /members/:id'],
    description:
      'One member by id: name, nickname, phone as the screen shows it, tier, the member’s notes, and children (name, age, medical alert yes or no; allergy text only with include).',
    input: z.object({ memberId: Uuid, include: MemberInclude }).strict(),
  }),
  spec({
    name: 'members.lookup',
    system: 'platform',
    routes: ['GET /members/lookup'],
    description:
      'Find a member by phone number, in any format the asker typed: name, nickname, phone as the screen shows it, tier, the member’s notes, and children (name, age, medical alert yes or no; allergy text only with include).',
    input: z.object({ phone: z.string().min(3).max(32), include: MemberInclude }).strict(),
  }),
  spec({
    name: 'members.search',
    system: 'platform',
    routes: ['GET /members'],
    description: 'Search the member register by name or phone: up to 20 matches, each with id, name and a masked phone.',
    input: z.object({ q: z.string().min(1).max(200) }).strict(),
  }),
  spec({
    name: 'occupancy.now',
    system: 'platform',
    routes: ['GET /branches/:id/occupancy'],
    description: 'Who is inside one park right now, by kind (adults, children), and whether the count is current.',
    input: z.object({ branchId: Uuid }).strict(),
  }),
  spec({
    name: 'ops.failures',
    system: 'platform',
    routes: ['GET /ops/failures'],
    description: 'Open platform failures by kind, over the last hours asked for (default 24).',
    input: z.object({ windowHours: z.number().int().min(1).max(168).optional() }).strict(),
  }),
  spec({
    name: 'oto.attendance',
    system: 'oto_app',
    routes: ['GET /api/timekeeping/employee/:employeeId'],
    description:
      "One employee's attendance between two dates: days worked, hours, and anomalies by kind (late arrivals, no-shows, open sessions). Needs the employee's id from oto.employees.find.",
    input: z.object({ employeeId: OtoAppId, startDate: Day, endDate: Day }).strict(),
  }),
  spec({
    name: 'oto.employee_leave',
    system: 'oto_app',
    routes: ['GET /api/employees/:employeeId/time-off'],
    description:
      "One employee's leave records, optionally between two dates. Needs the employee's id from oto.employees.find. No balance: the screen shows it.",
    input: z.object({ employeeId: OtoAppId, from: Day.optional(), to: Day.optional() }).strict(),
  }),
  spec({
    name: 'oto.employees.find',
    system: 'oto_app',
    routes: ['GET /api/employees'],
    description:
      "Find a colleague by name or nickname at the asker's park: up to 5 candidates (id, name, nickname, park). Ask which one when there are several.",
    input: z.object({ name: z.string().min(1).max(80) }).strict(),
  }),
  spec({
    name: 'oto.my_leave',
    system: 'oto_app',
    routes: ['GET /api/my-time-off'],
    description:
      "The asker's own leave records (type, dates, half days), optionally between two dates, and their weekly off days. No balance figure: the screen shows it.",
    input: z.object({ from: Day.optional(), to: Day.optional() }).strict(),
  }),
  spec({
    name: 'oto.my_payslips',
    system: 'oto_app',
    routes: ['GET /api/payroll/me/payslips'],
    description: "The months the asker has a payslip for. Not the figures: the payslip itself is the link.",
    input: None,
  }),
  spec({
    name: 'oto.payroll_summary',
    system: 'oto_app',
    routes: ['GET /api/payroll/history'],
    description: 'Locked payroll runs with their totals per month (gross, deductions, net), for payroll roles only.',
    input: z.object({ month: Month.optional() }).strict(),
  }),
  spec({
    name: 'oto.rota',
    system: 'oto_app',
    routes: ['GET /api/rota'],
    description:
      "Shifts between two dates: the asker's own (me), their department's or the whole park's (branch) — who, when, which department. The park is the asker's own unless branchId (an OTO App branch id, as oto.employees.find shows it) is given.",
    input: z
      .object({ scope: z.enum(['me', 'department', 'branch']), from: Day, to: Day, branchId: OtoAppId.optional() })
      .strict(),
  }),
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number]['name'];

export const ASSISTANT_TOOL_NAMES: readonly AssistantToolName[] = ASSISTANT_TOOLS.map((t) => t.name);

export function findAssistantTool(name: string): (typeof ASSISTANT_TOOLS)[number] | undefined {
  return ASSISTANT_TOOLS.find((t) => t.name === name);
}
