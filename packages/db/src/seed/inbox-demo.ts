/**
 * THE INBOX'S DEMO CONVERSATIONS (S2-19 I1b, SCRUM-579).
 *
 *   pnpm --filter @oto/db seed:inbox-demo
 *
 * Follows the `seed:demo-day` precedent: a fixture a person runs on purpose,
 * locally, in CI, or by hand on staging once — never laid by a deploy and
 * never by platform-sync. It writes, into the OTO operator:
 *   - six demo staff accounts (`./inbox-demo-fixtures.ts` DEMO_STAFF), each
 *     with the inbox role that puts them in a team, and names them on the
 *     routing rules that are STILL BLANK — a rule somebody has already named
 *     a real person on is never touched;
 *   - four simulator channel accounts (WhatsApp per park, Instagram,
 *     Facebook);
 *   - the ten fictional conversations, with their messages, owners and
 *     timeline.
 *
 * Insert-if-absent throughout, keyed on natural keys (a phone, a handle, a
 * thread, a provider message id), so a second run writes nothing and a
 * conversation somebody has since handled or reassigned on staging stays as
 * they left it.
 *
 * REFUSED ON PRODUCTION. `SEED_PROFILE=production` or
 * `DEPLOY_ENV=production` stops it before it reads anything: demo staff with a
 * known password do not belong in a real park's database.
 */
import { hash } from '@node-rs/argon2';
import { newId, normalizePhone, type InboxRole } from '@oto/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';
import type { InboxTeamKey } from '../schema/inbox';
import { DemoDayRefusedError } from './demo-refusal';
import { NAMED_RULE_PRIORITY, syncInboxSetup } from './inbox';
import {
  DEMO_CHANNEL_ACCOUNTS,
  DEMO_CONVERSATIONS,
  DEMO_RULE_PEOPLE,
  DEMO_STAFF,
  DEMO_STAFF_PASSWORD,
  type DemoBranch,
  type DemoChannelKey,
  type DemoConversation,
  type DemoStaffKey,
} from './inbox-demo-fixtures';

/** The branch codes the demo's two parks are found by (`seed/index.ts` `branchSeeds`). */
const BRANCH_CODES: Record<DemoBranch, string> = {
  central: 'hkt-central',
  chalong: 'robinson-chalong',
};

/** What the demo refuses with, in words a person can act on. */
export class InboxDemoRefusedError extends DemoDayRefusedError {
  constructor(message: string) {
    super(message);
    this.name = 'InboxDemoRefusedError';
  }
}

/** The house guard: the deployment says which it is, and production says no. */
export function assertInboxDemoAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.SEED_PROFILE === 'production' || env.DEPLOY_ENV === 'production') {
    throw new InboxDemoRefusedError(
      'The inbox demo is fictional data with known passwords and is refused on production (SEED_PROFILE or DEPLOY_ENV is "production").',
    );
  }
}

/**
 * The transaction one conversation is delivered in: everything the demo writes
 * through. A whole transaction handle, not a few of its methods, because the
 * ingest opens its own savepoints inside it.
 */
export type Writer = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Everything the delivery of one conversation needs, resolved once. */
export interface DemoContext {
  operatorId: string;
  staff: Record<DemoStaffKey, string>;
  channelAccounts: Record<DemoChannelKey, { id: string; channel: string }>;
  branches: Record<DemoBranch, string | null>;
  teams: { birthdays: string; marketing: string; reception: Record<DemoBranch, string | null> };
}

export interface DemoDelivered {
  created: boolean;
  messages: number;
  assignments: number;
  events: number;
}

/** How one conversation reaches the database — the api's ingest, played by its simulator. */
export type DemoDelivery = (
  db: Writer,
  ctx: DemoContext,
  conv: DemoConversation,
  now: Date,
) => Promise<DemoDelivered>;

export interface InboxDemoCounts {
  staffCreated: number;
  rulesNamed: number;
  channelAccountsCreated: number;
  conversationsCreated: number;
  conversationsAlreadyThere: number;
  messages: number;
  assignments: number;
  events: number;
}

// =============================================================================
// THE DELIVERY — played through the ingest (S2-19 I2d, SCRUM-583).
// =============================================================================
//
// I1b wrote the conversations straight into the tables here, behind a marked
// simulator seam. The ingest has landed and that writer is gone: every demo
// conversation's customer side is PLAYED — each customer line becomes a
// signed simulator webhook through the api's real handler (verify, receipt,
// dedupe, contact and thread upsert, routing with the backup added) — and the
// staff side is laid around it. The delivery lives in the api
// (`apps/api/src/services/inbox/simulator.ts`, `simulatorDemoDelivery`)
// because the ingest does, and this package cannot reach the api: `deliver`
// is therefore required, and the api passes it — from
// `POST /inbox/simulator/scenario` and from `pnpm --filter @oto/api inbox:demo`
// (which `pnpm --filter @oto/db seed:inbox-demo` forwards to).

/** Find-or-create one demo staff member: employee, account, and the inbox grant. */
async function demoStaff(
  db: Db,
  operatorId: string,
  key: DemoStaffKey,
  roleIds: Record<InboxRole, string>,
  teamDepartments: Record<'birthdays' | 'marketing', string>,
  passwordHash: string,
): Promise<{ id: string; created: boolean }> {
  const person = DEMO_STAFF[key];
  const phone = normalizePhone(person.phone)!;
  const departmentId = person.team ? teamDepartments[person.team] : null;

  const [foundEmployee] = await db
    .select({ id: s.employee.id })
    .from(s.employee)
    .where(and(eq(s.employee.operatorId, operatorId), eq(s.employee.phone, phone)))
    .limit(1);
  const employeeId = foundEmployee?.id ?? newId();
  if (!foundEmployee) {
    await db.insert(s.employee).values({ id: employeeId, operatorId, name: person.name, phone, departmentId });
  }

  const [created] = await db
    .insert(s.account)
    .values({
      id: newId(),
      operatorId,
      employeeId,
      phone,
      passwordHash,
      phoneVerifiedAt: new Date(),
      status: 'active',
    })
    .onConflictDoNothing({ target: [s.account.operatorId, s.account.phone] })
    .returning({ id: s.account.id });
  const accountId =
    created?.id ??
    (
      await db
        .select({ id: s.account.id })
        .from(s.account)
        .where(and(eq(s.account.operatorId, operatorId), eq(s.account.phone, phone)))
        .limit(1)
    )[0]!.id;

  // Agents are in a team by a department-scoped grant; the GM sees everything
  // as a manager, operator-wide, and is in no team (manual-only).
  const scope =
    person.role === 'inbox_agent'
      ? { scopeType: 'department' as const, scopeId: departmentId! }
      : { scopeType: 'operator' as const, scopeId: operatorId };
  const roleId = roleIds[person.role];
  const [held] = await db
    .select({ id: s.roleAssignment.id })
    .from(s.roleAssignment)
    .where(
      and(
        eq(s.roleAssignment.accountId, accountId),
        eq(s.roleAssignment.roleId, roleId),
        eq(s.roleAssignment.scopeType, scope.scopeType),
        eq(s.roleAssignment.scopeId, scope.scopeId),
      ),
    )
    .limit(1);
  if (!held) {
    await db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId, ...scope });
  }
  return { id: accountId, created: Boolean(created) };
}

export interface SeedInboxDemoOptions {
  /** The moment the demo's "minutes ago" count back from. Default: now. */
  now?: Date;
  /** The environment the guard reads. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** How each conversation is delivered: the api's simulator through its ingest (see above). */
  deliver: DemoDelivery;
  /** The operator the demo goes into. Default: the one named OTO. */
  operatorId?: string;
}

export async function seedInboxDemo(db: Db, opts: SeedInboxDemoOptions): Promise<InboxDemoCounts> {
  assertInboxDemoAllowed(opts.env);
  const now = opts.now ?? new Date();
  const deliver = opts.deliver;
  const counts: InboxDemoCounts = {
    staffCreated: 0,
    rulesNamed: 0,
    channelAccountsCreated: 0,
    conversationsCreated: 0,
    conversationsAlreadyThere: 0,
    messages: 0,
    assignments: 0,
    events: 0,
  };

  const [operator] = await db
    .select({ id: s.operator.id })
    .from(s.operator)
    .where(opts.operatorId ? eq(s.operator.id, opts.operatorId) : eq(s.operator.name, 'OTO'))
    .limit(1);
  if (!operator) {
    throw new InboxDemoRefusedError('No OTO operator to put the demo conversations in. Run `pnpm db:seed` first — this seeds on top of it.');
  }
  const operatorId = operator.id;

  // The configuration is the platform's and converges first: teams, rules,
  // templates, roles. A database that has never been synced gets it here.
  await syncInboxSetup(db);

  const branches = {} as Record<DemoBranch, string | null>;
  for (const [key, code] of Object.entries(BRANCH_CODES) as Array<[DemoBranch, string]>) {
    const [b] = await db
      .select({ id: s.branch.id })
      .from(s.branch)
      .where(and(eq(s.branch.operatorId, operatorId), eq(s.branch.code, code)))
      .limit(1);
    branches[key] = b?.id ?? null;
  }

  const teamRows = await db
    .select({ id: s.team.id, key: s.team.key, branchId: s.team.branchId, departmentId: s.team.departmentId })
    .from(s.team)
    .where(eq(s.team.operatorId, operatorId));
  const teamOf = (key: InboxTeamKey, branchId: string | null = null) =>
    teamRows.find((t) => t.key === key && t.branchId === branchId);
  const birthdays = teamOf('birthdays');
  const marketing = teamOf('marketing');
  if (!birthdays?.departmentId || !marketing?.departmentId) {
    throw new InboxDemoRefusedError('The Birthdays & Events or Marketing team is missing or has no department. Run `pnpm db:platform-sync`.');
  }
  const teams: DemoContext['teams'] = {
    birthdays: birthdays.id,
    marketing: marketing.id,
    reception: {
      central: branches.central ? (teamOf('reception', branches.central)?.id ?? null) : null,
      chalong: branches.chalong ? (teamOf('reception', branches.chalong)?.id ?? null) : null,
    },
  };

  const roleRows = await db
    .select({ id: s.role.id, name: s.role.name })
    .from(s.role)
    .where(eq(s.role.operatorId, operatorId));
  const roleIds = Object.fromEntries(roleRows.map((r) => [r.name, r.id])) as Record<InboxRole, string>;

  const passwordHash = await hash(DEMO_STAFF_PASSWORD);
  const staff = {} as Record<DemoStaffKey, string>;
  for (const key of Object.keys(DEMO_STAFF) as DemoStaffKey[]) {
    const made = await demoStaff(
      db,
      operatorId,
      key,
      roleIds,
      { birthdays: birthdays.departmentId, marketing: marketing.departmentId },
      passwordHash,
    );
    staff[key] = made.id;
    counts.staffCreated += Number(made.created);
  }

  // Name the demo people on the rules — only where the slot is still blank.
  for (const r of DEMO_RULE_PEOPLE) {
    const teamId = r.team === 'birthdays' ? birthdays.id : marketing.id;
    const named = await db
      .update(s.routingRule)
      .set({ primaryKind: 'account', primaryAccountId: staff[r.primary], backupAccountId: staff[r.backup] })
      .where(
        and(
          eq(s.routingRule.operatorId, operatorId),
          eq(s.routingRule.teamId, teamId),
          eq(s.routingRule.category, r.category),
          r.language === null ? isNull(s.routingRule.language) : eq(s.routingRule.language, r.language),
          isNull(s.routingRule.branchId),
          eq(s.routingRule.priority, NAMED_RULE_PRIORITY),
          eq(s.routingRule.primaryKind, 'team'),
          isNull(s.routingRule.primaryAccountId),
          isNull(s.routingRule.archivedAt),
        ),
      )
      .returning({ id: s.routingRule.id });
    counts.rulesNamed += named.length;
  }

  // The simulator twins of the park's numbers and pages.
  const channelAccounts = {} as DemoContext['channelAccounts'];
  for (const [key, ca] of Object.entries(DEMO_CHANNEL_ACCOUNTS) as Array<
    [DemoChannelKey, (typeof DEMO_CHANNEL_ACCOUNTS)[DemoChannelKey]]
  >) {
    const [found] = await db
      .select({ id: s.channelAccount.id })
      .from(s.channelAccount)
      .where(
        and(
          eq(s.channelAccount.operatorId, operatorId),
          eq(s.channelAccount.provider, 'simulator'),
          eq(s.channelAccount.externalId, ca.externalId),
        ),
      )
      .limit(1);
    let id = found?.id;
    if (!id) {
      id = newId();
      await db.insert(s.channelAccount).values({
        id,
        operatorId,
        branchId: ca.branch ? branches[ca.branch] : null,
        channel: ca.channel,
        provider: 'simulator',
        externalId: ca.externalId,
        displayName: ca.displayName,
        defaultCategory: 'general',
        canReply: true,
        status: 'active',
      });
      counts.channelAccountsCreated += 1;
    }
    channelAccounts[key] = { id, channel: ca.channel };
  }

  const ctx: DemoContext = { operatorId, staff, channelAccounts, branches, teams };
  for (const conv of DEMO_CONVERSATIONS) {
    // One transaction per conversation: a thread is all there or not at all.
    const done = await db.transaction((tx) => deliver(tx, ctx, conv, now));
    if (done.created) counts.conversationsCreated += 1;
    else counts.conversationsAlreadyThere += 1;
    counts.messages += done.messages;
    counts.assignments += done.assignments;
    counts.events += done.events;
  }
  return counts;
}

export function describeInboxDemo(c: InboxDemoCounts): string {
  return `Inbox demo: ${c.conversationsCreated} conversation(s) written (${c.messages} messages, ${c.assignments} owners, ${c.events} timeline events), ${c.conversationsAlreadyThere} already there; ${c.staffCreated} demo staff created, ${c.rulesNamed} blank routing rule(s) named, ${c.channelAccountsCreated} simulator channel account(s) created. Demo staff sign in with password "${DEMO_STAFF_PASSWORD}".`;
}
