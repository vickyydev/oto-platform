import { and, asc, eq, sql } from 'drizzle-orm';
import { account, branch, department, employee, routingRule, team } from '@oto/db';
import type { InboxCategory, InboxTeamKey, RoutingPrimaryKind } from '@oto/db';
import { AppError, errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { branchReach } from './access-control';
import { audit } from './audit';
import { claimClientId, markReplay } from './client-id';
import { hasPermission, type EffectivePermission } from './permissions';
import type { Exec, Tx } from './tx';

const MANAGE = 'inbox:routing:manage' as const;
type TeamRow = typeof team.$inferSelect;
type RuleRow = typeof routingRule.$inferSelect;
export interface RoutingActor { operatorId: string; accountId: string; requestId: string; effective: EffectivePermission[] }
export interface ManagedTeamInput {
  id?: string; key: InboxTeamKey; branchId: string | null; departmentId?: string | null;
  name: string; colour: string; sortOrder?: number;
}
export type ManagedTeamPatch = Partial<Pick<ManagedTeamInput, 'departmentId' | 'name' | 'colour' | 'sortOrder'>>;
export interface ManagedRuleInput {
  id?: string; teamId: string; category: InboxCategory; language?: string | null; branchId?: string | null;
  primaryKind: RoutingPrimaryKind; primaryAccountId?: string | null; backupAccountId?: string | null;
  autoAddBackup?: boolean; priority?: number; active?: boolean;
}
export type ManagedRulePatch = Partial<Omit<ManagedRuleInput, 'id'>>;

const referenceMissing = () => new AppError(404, 'INBOX_ROUTING_REFERENCE_NOT_FOUND', 'A routing reference was not found');
const teamMissing = () => new AppError(404, 'INBOX_TEAM_NOT_FOUND', 'Team not found');
const ruleMissing = () => new AppError(404, 'INBOX_ROUTING_RULE_NOT_FOUND', 'Routing rule not found');

export function requireRoutingReach(actor: RoutingActor): void {
  const reach = branchReach(actor.effective, MANAGE, actor.operatorId);
  if (reach.kind === 'branches' && reach.branchIds.length === 0) throw new PermissionDeniedError(MANAGE);
}

function coversPark(actor: RoutingActor, branchId: string | null): boolean {
  return hasPermission(actor.effective, MANAGE, branchId === null
    ? { operatorId: actor.operatorId, operatorOnly: true }
    : { operatorId: actor.operatorId, branchId });
}

function requirePark(actor: RoutingActor, branchId: string | null): void {
  if (!coversPark(actor, branchId)) throw new PermissionDeniedError(MANAGE);
}

async function ownPark(db: Exec, actor: RoutingActor, branchId: string | null): Promise<void> {
  if (branchId === null) return;
  const [found] = await db.select({ id: branch.id }).from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, actor.operatorId))).limit(1);
  if (!found) throw referenceMissing();
}

async function loadManagedTeam(db: Exec, actor: RoutingActor, id: string, lock = false): Promise<TeamRow> {
  const query = db.select().from(team).where(and(eq(team.id, id), eq(team.operatorId, actor.operatorId))).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw teamMissing();
  return row;
}

async function loadManagedRule(db: Exec, actor: RoutingActor, id: string, lock = false): Promise<RuleRow> {
  const query = db.select().from(routingRule)
    .where(and(eq(routingRule.id, id), eq(routingRule.operatorId, actor.operatorId))).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw ruleMissing();
  return row;
}

async function requireTeamTarget(db: Exec, actor: RoutingActor, row: Pick<TeamRow, 'branchId'>): Promise<void> {
  await ownPark(db, actor, row.branchId);
  requirePark(actor, row.branchId);
}

async function requireRuleTarget(db: Exec, actor: RoutingActor, row: Pick<RuleRow, 'branchId' | 'teamId'>): Promise<void> {
  await ownPark(db, actor, row.branchId);
  requirePark(actor, row.branchId);
  const targetTeam = await loadManagedTeam(db, actor, row.teamId);
  await ownPark(db, actor, targetTeam.branchId);
  // A global team is a reference choice, not an operator-wide rule edit.
  if (targetTeam.branchId !== null) requirePark(actor, targetTeam.branchId);
}

export type RoutingIntent =
  | { kind: 'team-create'; input: ManagedTeamInput }
  | { kind: 'team-write'; id: string }
  | { kind: 'rule-create'; input: ManagedRuleInput }
  | { kind: 'rule-write'; id: string; patch?: ManagedRulePatch };

/** Read-only before the ancestor replay hook; the transaction repeats row-target checks. */
export async function authorizeRoutingIntent(db: Exec, actor: RoutingActor, intent: RoutingIntent): Promise<{ branchId: string | null }> {
  requireRoutingReach(actor);
  if (intent.kind === 'team-create') {
    await requireTeamTarget(db, actor, intent.input);
    if (intent.input.id) {
      const [existing] = await db.select().from(team).where(eq(team.id, intent.input.id)).limit(1);
      if (existing?.operatorId === actor.operatorId) await requireTeamTarget(db, actor, existing);
    }
    return { branchId: intent.input.branchId };
  } else if (intent.kind === 'team-write') {
    const existing = await loadManagedTeam(db, actor, intent.id);
    await requireTeamTarget(db, actor, existing);
    return { branchId: existing.branchId };
  } else if (intent.kind === 'rule-create') {
    await requireRuleTarget(db, actor, { teamId: intent.input.teamId, branchId: intent.input.branchId ?? null });
    if (intent.input.id) {
      const [existing] = await db.select().from(routingRule).where(eq(routingRule.id, intent.input.id)).limit(1);
      if (existing?.operatorId === actor.operatorId) await requireRuleTarget(db, actor, existing);
    }
    return { branchId: intent.input.branchId ?? null };
  } else {
    const existing = await loadManagedRule(db, actor, intent.id);
    await requireRuleTarget(db, actor, existing);
    if (intent.patch) await requireRuleTarget(db, actor, { ...existing, ...intent.patch });
    return { branchId: intent.patch?.branchId === undefined ? existing.branchId : intent.patch.branchId };
  }
}

/** Serialize management edits, body-ID claims and duplicate identities within one operator. */
async function lockRoutingOperator(tx: Tx, actor: RoutingActor): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`console-routing:${actor.operatorId}`}, 0))`);
}

async function routingDirectory(db: Exec, actor: RoutingActor) {
  const [parks, departments, accounts, teams] = await Promise.all([
    db.select({ id: branch.id, name: branch.name }).from(branch)
      .where(eq(branch.operatorId, actor.operatorId)).orderBy(asc(branch.name), asc(branch.id)),
    db.select({ id: department.id, name: department.name, branchId: department.branchId }).from(department)
      .where(eq(department.operatorId, actor.operatorId)).orderBy(asc(department.name), asc(department.id)),
    db.select({ id: account.id, status: account.status, name: employee.name, employeeBranchId: employee.branchId })
      .from(account).leftJoin(employee, and(eq(employee.id, account.employeeId), eq(employee.operatorId, actor.operatorId)))
      .where(eq(account.operatorId, actor.operatorId)).orderBy(asc(account.id)),
    db.select().from(team).where(eq(team.operatorId, actor.operatorId)).orderBy(asc(team.sortOrder), asc(team.createdAt), asc(team.id)),
  ]);
  const parkMap = new Map(parks.map(p => [p.id, p]));
  const validPark = (id: string | null) => id === null || parkMap.has(id);
  const accountOptions = accounts.map(a => ({ id: a.id, status: a.status,
    displayName: a.name !== null && validPark(a.employeeBranchId) ? a.name : `Account ${a.id.slice(0, 8)}` }));
  return { parks, parkMap, validPark, departments: departments.filter(d => validPark(d.branchId)),
    accounts: accountOptions, teams: teams.filter(t => validPark(t.branchId)) };
}

type Directory = Awaited<ReturnType<typeof routingDirectory>>;
function managedTeamView(row: TeamRow, directory: Directory) {
  const linked = directory.departments.find(d => d.id === row.departmentId && (d.branchId === null || d.branchId === row.branchId));
  return { id: row.id, key: row.key, name: row.name, branchId: row.branchId,
    branchName: row.branchId ? directory.parkMap.get(row.branchId)?.name ?? null : null,
    departmentId: linked?.id ?? null, departmentName: linked?.name ?? null, colour: row.colour, sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function manageableRule(row: RuleRow, actor: RoutingActor, directory: Directory): boolean {
  const targetTeam = directory.teams.find(t => t.id === row.teamId);
  return directory.validPark(row.branchId) && coversPark(actor, row.branchId) && Boolean(targetTeam)
    && (targetTeam!.branchId === null || coversPark(actor, targetTeam!.branchId));
}

function managedRuleView(row: RuleRow, directory: Directory) {
  const primary = directory.accounts.find(a => a.id === row.primaryAccountId);
  const backup = directory.accounts.find(a => a.id === row.backupAccountId);
  return { id: row.id, teamId: row.teamId, teamName: directory.teams.find(t => t.id === row.teamId)?.name ?? null,
    category: row.category, language: row.language, branchId: row.branchId,
    branchName: row.branchId ? directory.parkMap.get(row.branchId)?.name ?? null : null,
    primaryKind: row.primaryKind, primaryAccountId: primary?.id ?? null, primaryAccountName: primary?.displayName ?? null,
    backupAccountId: backup?.id ?? null, backupAccountName: backup?.displayName ?? null,
    autoAddBackup: row.autoAddBackup, priority: row.priority, active: row.active,
    archivedAt: row.archivedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function listManagedTeams(db: Exec, actor: RoutingActor) {
  requireRoutingReach(actor);
  const directory = await routingDirectory(db, actor);
  return { teams: directory.teams.filter(t => coversPark(actor, t.branchId)).map(t => managedTeamView(t, directory)),
    operatorWide: coversPark(actor, null), branches: directory.parks.filter(p => coversPark(actor, p.id)),
    departments: directory.departments.filter(d => d.branchId === null || coversPark(actor, d.branchId)),
    accounts: directory.accounts,
    teamReferences: directory.teams.filter(t => t.branchId === null || coversPark(actor, t.branchId))
      .map(t => ({ id: t.id, key: t.key, name: t.name, branchId: t.branchId })) };
}

export async function listManagedRules(db: Exec, actor: RoutingActor) {
  requireRoutingReach(actor);
  const directory = await routingDirectory(db, actor);
  const rows = await db.select().from(routingRule).where(eq(routingRule.operatorId, actor.operatorId));
  const specificity = (row: RuleRow) => Number(row.language !== null) + Number(row.branchId !== null);
  return { rules: rows.filter(r => manageableRule(r, actor, directory))
    .sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a)
      || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map(r => managedRuleView(r, directory)) };
}

async function requireTeamDepartment(tx: Exec, actor: RoutingActor, branchId: string | null, departmentId: string | null) {
  if (departmentId === null) return;
  const [row] = await tx.select().from(department)
    .where(and(eq(department.id, departmentId), eq(department.operatorId, actor.operatorId))).limit(1);
  if (!row || (row.branchId !== null && row.branchId !== branchId)) throw referenceMissing();
  await ownPark(tx, actor, row.branchId);
}

async function requireRuleAccounts(tx: Exec, actor: RoutingActor, row: Pick<RuleRow, 'primaryKind' | 'primaryAccountId' | 'backupAccountId'>) {
  if ((row.primaryKind === 'account') !== (row.primaryAccountId !== null)) {
    throw new AppError(400, 'INBOX_ROUTING_PRIMARY_INVALID', 'Choose a primary person, or use the team without a person');
  }
  if (row.backupAccountId !== null && row.backupAccountId === row.primaryAccountId) {
    throw new AppError(400, 'INBOX_ROUTING_BACKUP_INVALID', 'The backup must be different from the primary person');
  }
  for (const id of [row.primaryAccountId, row.backupAccountId]) {
    if (id === null) continue;
    const [found] = await tx.select({ id: account.id }).from(account)
      .where(and(eq(account.id, id), eq(account.operatorId, actor.operatorId))).limit(1);
    if (!found) throw referenceMissing();
  }
}

function auditRouting(tx: Tx, actor: RoutingActor, action: string, entityType: string, entityId: string,
  branchId: string | null, before: unknown, after: unknown) {
  return audit.record(tx, { actorAccountId: actor.accountId, operatorId: actor.operatorId,
    requestId: actor.requestId, action, entityType, entityId, branchId, before, after });
}

export async function createManagedTeam(tx: Tx, actor: RoutingActor, input: ManagedTeamInput) {
  await lockRoutingOperator(tx, actor);
  await requireTeamTarget(tx, actor, input);
  const claim = await claimClientId(input.id,
    async id => (await tx.select().from(team).where(eq(team.id, id)).limit(1))[0],
    row => row.operatorId === actor.operatorId && row.key === input.key && row.branchId === input.branchId);
  if (claim.replay) {
    await requireTeamTarget(tx, actor, claim.row);
    return markReplay({ team: managedTeamView(claim.row, await routingDirectory(tx, actor)) });
  }
  await requireTeamDepartment(tx, actor, input.branchId, input.departmentId ?? null);
  const [duplicate] = await tx.select({ id: team.id }).from(team).where(and(eq(team.operatorId, actor.operatorId),
    eq(team.key, input.key), sql`${team.branchId} is not distinct from ${input.branchId}::uuid`)).limit(1);
  if (duplicate) throw errors.conflict('INBOX_TEAM_EXISTS', 'This team already exists for that park; edit it instead');
  const now = new Date();
  const [row] = await tx.insert(team).values({ ...input, id: claim.id, operatorId: actor.operatorId,
    departmentId: input.departmentId ?? null, sortOrder: input.sortOrder ?? 0, createdAt: now, updatedAt: now }).returning();
  const result = { team: managedTeamView(row!, await routingDirectory(tx, actor)) };
  await auditRouting(tx, actor, 'inbox.team.create', 'inbox.team', row!.id, row!.branchId, null, result.team);
  return result;
}

export async function updateManagedTeam(tx: Tx, actor: RoutingActor, id: string, patch: ManagedTeamPatch) {
  await lockRoutingOperator(tx, actor);
  const before = await loadManagedTeam(tx, actor, id, true);
  await requireTeamTarget(tx, actor, before);
  const proposed = { ...before, ...patch };
  await requireTeamDepartment(tx, actor, proposed.branchId, proposed.departmentId);
  const [row] = await tx.update(team).set({ ...patch, updatedAt: new Date() }).where(eq(team.id, before.id)).returning();
  const directory = await routingDirectory(tx, actor);
  const result = { team: managedTeamView(row!, directory) };
  await auditRouting(tx, actor, 'inbox.team.update', 'inbox.team', id, before.branchId, managedTeamView(before, directory), result.team);
  return result;
}

export async function refuseManagedTeamDelete(tx: Tx, actor: RoutingActor, id: string): Promise<never> {
  await lockRoutingOperator(tx, actor);
  await requireTeamTarget(tx, actor, await loadManagedTeam(tx, actor, id, true));
  throw errors.conflict('INBOX_TEAM_DELETE_REFUSED', 'Teams cannot be deleted. Edit the team or archive its routing rules instead.');
}

export async function createManagedRule(tx: Tx, actor: RoutingActor, input: ManagedRuleInput) {
  await lockRoutingOperator(tx, actor);
  const proposed = { ...input, language: input.language ?? null, branchId: input.branchId ?? null,
    primaryAccountId: input.primaryAccountId ?? null, backupAccountId: input.backupAccountId ?? null,
    autoAddBackup: input.autoAddBackup ?? true, priority: input.priority ?? 0, active: input.active ?? true };
  await requireRuleTarget(tx, actor, proposed);
  const claim = await claimClientId(input.id,
    async id => (await tx.select().from(routingRule).where(eq(routingRule.id, id)).limit(1))[0],
    row => row.operatorId === actor.operatorId && row.teamId === proposed.teamId && row.branchId === proposed.branchId);
  if (claim.replay) {
    await requireRuleTarget(tx, actor, claim.row);
    return markReplay({ rule: managedRuleView(claim.row, await routingDirectory(tx, actor)) });
  }
  await requireRuleAccounts(tx, actor, proposed);
  const now = new Date();
  const [row] = await tx.insert(routingRule).values({ ...proposed, id: claim.id, operatorId: actor.operatorId,
    createdAt: now, updatedAt: now }).returning();
  const result = { rule: managedRuleView(row!, await routingDirectory(tx, actor)) };
  await auditRouting(tx, actor, 'inbox.routing_rule.create', 'inbox.routing_rule', row!.id, row!.branchId, null, result.rule);
  return result;
}

export async function updateManagedRule(tx: Tx, actor: RoutingActor, id: string, patch: ManagedRulePatch) {
  await lockRoutingOperator(tx, actor);
  const before = await loadManagedRule(tx, actor, id, true);
  await requireRuleTarget(tx, actor, before);
  const proposed = { ...before, ...patch };
  await requireRuleTarget(tx, actor, proposed);
  if (before.archivedAt !== null) throw errors.conflict('INBOX_ROUTING_RULE_ARCHIVED', 'This routing rule is archived; create another rule instead');
  await requireRuleAccounts(tx, actor, proposed);
  const [row] = await tx.update(routingRule).set({ ...patch, updatedAt: new Date() }).where(eq(routingRule.id, before.id)).returning();
  const directory = await routingDirectory(tx, actor);
  const result = { rule: managedRuleView(row!, directory) };
  await auditRouting(tx, actor, 'inbox.routing_rule.update', 'inbox.routing_rule', id, row!.branchId,
    managedRuleView(before, directory), result.rule);
  return result;
}

export async function archiveManagedRule(tx: Tx, actor: RoutingActor, id: string) {
  await lockRoutingOperator(tx, actor);
  const before = await loadManagedRule(tx, actor, id, true);
  await requireRuleTarget(tx, actor, before);
  if (before.archivedAt !== null) return { ok: true as const };
  const [row] = await tx.update(routingRule).set({ active: false, archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(routingRule.id, before.id)).returning();
  const directory = await routingDirectory(tx, actor);
  await auditRouting(tx, actor, 'inbox.routing_rule.archive', 'inbox.routing_rule', id, row!.branchId,
    managedRuleView(before, directory), managedRuleView(row!, directory));
  return { ok: true as const };
}
