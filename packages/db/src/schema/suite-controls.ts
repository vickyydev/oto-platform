import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { archivedAt, core, idPk, timestamps } from './helpers';
import { account, operator } from './tenancy';

export const SUITE_APP_KEYS = ['pos', 'console', 'oto_app', 'radar', 'booth', 'inbox'] as const;
export const APP_TILE_STATES = ['open', 'coming_soon', 'hidden', 'maintenance'] as const;
export const FLAG_KINDS = ['feature', 'kill_switch'] as const;
export const FLAG_SCOPE_TYPES = ['platform', 'operator', 'branch', 'station'] as const;
export type SuiteAppKey = typeof SUITE_APP_KEYS[number];
export type AppTileState = typeof APP_TILE_STATES[number];
export type FlagKind = typeof FLAG_KINDS[number];
export type FlagScopeType = typeof FLAG_SCOPE_TYPES[number];

/** The suite's stable directory; archiving does not create a second identity for an app key. */
export const appRegistry = core.table('app_registry', {
  id: idPk(),
  key: text('key').$type<SuiteAppKey>().notNull(),
  name: text('name').notNull(),
  purpose: text('purpose').notNull(),
  originUrls: jsonb('origin_urls').$type<Record<string, string>>().notNull(),
  schemaName: text('schema_name').notNull(),
  owningService: text('owning_service').notNull(),
  healthUrl: text('health_url'),
  versionSource: text('version_source').notNull(),
  requiredPermission: text('required_permission').notNull(),
  sortOrder: integer('sort_order').notNull(),
  tileState: text('tile_state').$type<AppTileState>().notNull(),
  maintenanceMessage: text('maintenance_message'),
  maintenanceExpiresAt: timestamp('maintenance_expires_at', { withTimezone: true, mode: 'date' }),
  maintenanceRestoreState: text('maintenance_restore_state').$type<Exclude<AppTileState, 'maintenance'>>(),
  revision: integer('revision').notNull().default(1),
  ...archivedAt,
  ...timestamps,
}, t => [
  unique('app_registry_key_unique').on(t.key),
  check('app_registry_key_check', sql`${t.key} in ('pos', 'console', 'oto_app', 'radar', 'booth', 'inbox')`),
  check('app_registry_origins_object_check', sql`jsonb_typeof(${t.originUrls}) = 'object'`),
  check('app_registry_tile_state_check', sql`${t.tileState} in ('open', 'coming_soon', 'hidden', 'maintenance')`),
  check('app_registry_revision_positive_check', sql`${t.revision} > 0`),
  check('app_registry_maintenance_check', sql`(
    ${t.tileState} = 'maintenance' and ${t.maintenanceMessage} is not null and length(btrim(${t.maintenanceMessage})) > 0
    and ${t.maintenanceExpiresAt} is not null and ${t.maintenanceRestoreState} is not null
    and ${t.maintenanceRestoreState} in ('open', 'coming_soon', 'hidden')
  ) or (
    ${t.tileState} <> 'maintenance' and ${t.maintenanceMessage} is null
    and ${t.maintenanceExpiresAt} is null and ${t.maintenanceRestoreState} is null
  )`),
]);

/**
 * The typed flag catalogue (SCRUM-643, planner ruling Q24). A key that is not
 * here does not exist: the resolver, the preview and every writer refuse it.
 * `supported: false` keys are listed so the Console can show what is planned,
 * but no write path accepts them until their real consumer is integrated and
 * proven in its own ticket — a generic store must never imply that a payment,
 * gate, booth or rollup action works.
 *
 * `defaultValue` is also the safe fallback: an expired or malformed override
 * resolves to it immediately at read time.
 */
export type FlagValue = boolean | string;
export interface FlagCatalogueEntry {
  key: string;
  kind: FlagKind;
  targetApp: SuiteAppKey;
  label: string;
  /** What stops working while the flag holds its non-default value. */
  effect: string;
  valueType: 'boolean' | 'enum';
  /** Allowed values of an `enum` flag. */
  values?: readonly string[];
  defaultValue: FlagValue;
  scopes: readonly FlagScopeType[];
  supported: boolean;
}

const SIGN_IN_APP_NAMES: Record<SuiteAppKey, string> = {
  pos: 'POS', console: 'Admin', oto_app: 'OTO App', radar: 'Radar', booth: 'Lucky Wheel', inbox: 'Inbox',
};
export const SIGN_IN_BLOCK_PREFIX = 'signin.blocked.';
export const signInBlockKey = (app: SuiteAppKey) => `${SIGN_IN_BLOCK_PREFIX}${app}`;
export const MESSAGING_PAUSE_KEY = 'messaging.outbound_paused';

export const FLAG_CATALOGUE: readonly FlagCatalogueEntry[] = [
  {
    key: MESSAGING_PAUSE_KEY, kind: 'kill_switch', targetApp: 'inbox', label: 'Pause outbound messaging',
    effect: 'Queued Inbox replies and automatic messages stay queued and are not handed to any channel provider.',
    valueType: 'boolean', defaultValue: false, scopes: ['platform', 'operator', 'branch'], supported: true,
  },
  ...SUITE_APP_KEYS.map((app): FlagCatalogueEntry => ({
    key: signInBlockKey(app), kind: 'kill_switch', targetApp: app, label: `Block new sign-ins to ${SIGN_IN_APP_NAMES[app]}`,
    effect: `New hand-offs into ${SIGN_IN_APP_NAMES[app]} are refused. Existing sessions, platform sign-in and other apps keep working.`,
    valueType: 'boolean', defaultValue: false, scopes: ['platform', 'operator', 'branch', 'station'], supported: true,
  })),
  {
    key: 'payments.qr_tender_disabled', kind: 'kill_switch', targetApp: 'pos', label: 'Disable QR tender',
    effect: 'Not integrated: the till does not read this switch yet.', valueType: 'boolean', defaultValue: false,
    scopes: ['platform', 'operator', 'branch', 'station'], supported: false,
  },
  {
    key: 'payments.card_tender_disabled', kind: 'kill_switch', targetApp: 'pos', label: 'Disable card tender',
    effect: 'Not integrated: the till does not read this switch yet.', valueType: 'boolean', defaultValue: false,
    scopes: ['platform', 'operator', 'branch', 'station'], supported: false,
  },
  {
    key: 'payments.manual_recording_forced', kind: 'kill_switch', targetApp: 'pos', label: 'Force manual payment recording',
    effect: 'Not integrated: the till does not read this switch yet.', valueType: 'boolean', defaultValue: false,
    scopes: ['platform', 'operator', 'branch', 'station'], supported: false,
  },
  {
    key: 'gate.closed', kind: 'kill_switch', targetApp: 'pos', label: 'Close the gate',
    effect: 'Not integrated: gates and boxes do not read this switch yet.', valueType: 'enum',
    values: ['open', 'deny_all', 'exit_only'], defaultValue: 'open', scopes: ['platform', 'operator', 'branch', 'station'], supported: false,
  },
  {
    key: 'booth.stopped', kind: 'kill_switch', targetApp: 'booth', label: 'Stop the booth',
    effect: 'Not integrated: the booth does not read this switch yet.', valueType: 'boolean', defaultValue: false,
    scopes: ['platform', 'operator', 'branch'], supported: false,
  },
  {
    key: 'analytics.rollups_frozen', kind: 'kill_switch', targetApp: 'radar', label: 'Freeze analytics rollups',
    effect: 'Not integrated: the rollup jobs do not read this switch yet.', valueType: 'boolean', defaultValue: false,
    scopes: ['platform', 'operator'], supported: false,
  },
];

export function flagCatalogueEntry(key: string): FlagCatalogueEntry | undefined {
  return FLAG_CATALOGUE.find(entry => entry.key === key);
}

/** A value is only ever one the catalogue allows; anything else is not a value of that flag. */
export function isFlagValue(entry: FlagCatalogueEntry, value: unknown): value is FlagValue {
  return entry.valueType === 'boolean' ? typeof value === 'boolean'
    : typeof value === 'string' && (entry.values ?? []).includes(value);
}

/** Scope shape is structural; services validate the exact live station/branch/operator lineage. */
export const featureFlag = core.table('feature_flag', {
  id: idPk(),
  key: text('key').notNull(),
  kind: text('kind').$type<FlagKind>().notNull(),
  targetApp: text('target_app').$type<SuiteAppKey>().notNull().references(() => appRegistry.key),
  scopeType: text('scope_type').$type<FlagScopeType>().notNull(),
  scopeId: uuid('scope_id'),
  operatorId: uuid('operator_id').references(() => operator.id),
  value: jsonb('value').notNull(),
  defaultValue: jsonb('default_value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  reason: text('reason'),
  updatedBy: uuid('updated_by').references(() => account.id),
  revision: integer('revision').notNull().default(1),
  ...timestamps,
}, t => [
  uniqueIndex('feature_flag_platform_key_unique').on(t.key).where(sql`${t.scopeType} = 'platform'`),
  uniqueIndex('feature_flag_scoped_key_unique').on(t.key, t.scopeType, t.scopeId).where(sql`${t.scopeType} <> 'platform'`),
  index('feature_flag_operator_idx').on(t.operatorId),
  index('feature_flag_updated_by_idx').on(t.updatedBy),
  index('feature_flag_target_app_idx').on(t.targetApp),
  index('feature_flag_expiry_idx').on(t.expiresAt),
  check('feature_flag_kind_check', sql`${t.kind} in ('feature', 'kill_switch')`),
  check('feature_flag_scope_type_check', sql`${t.scopeType} in ('platform', 'operator', 'branch', 'station')`),
  check('feature_flag_scope_shape_check', sql`(
    ${t.scopeType} = 'platform' and ${t.scopeId} is null and ${t.operatorId} is null
  ) or (
    ${t.scopeType} <> 'platform' and ${t.scopeId} is not null and ${t.operatorId} is not null
  )`),
  check('feature_flag_operator_scope_check', sql`${t.scopeType} <> 'operator' or ${t.scopeId} = ${t.operatorId}`),
  check('feature_flag_revision_positive_check', sql`${t.revision} > 0`),
  check('feature_flag_kill_switch_check', sql`${t.kind} <> 'kill_switch' or (
    ${t.expiresAt} is not null and ${t.reason} is not null and length(btrim(${t.reason})) > 0
  )`),
]);

/** Only supplied release facts; unknown version, CI result and deployment time stay unknown. */
export const deployEvent = core.table('deploy_event', {
  id: idPk(),
  app: text('app').$type<SuiteAppKey>().notNull().references(() => appRegistry.key),
  version: text('version'),
  commit: text('commit'),
  actorAccountId: uuid('actor_account_id').references(() => account.id),
  status: text('status').notNull(),
  ciGreen: boolean('ci_green'),
  deployedAt: timestamp('deployed_at', { withTimezone: true, mode: 'date' }),
  ...timestamps,
}, t => [
  index('deploy_event_app_time_idx').on(t.app, t.deployedAt),
  index('deploy_event_actor_idx').on(t.actorAccountId),
  check('deploy_event_status_check', sql`length(btrim(${t.status})) > 0`),
]);

export const SUITE_CONTROL_APPROVAL_STATES = ['pending', 'approved', 'consumed', 'expired'] as const;
export type SuiteControlApprovalState = typeof SUITE_CONTROL_APPROVAL_STATES[number];

/** Two admins review one immutable operation; consumption and its effect share the caller's transaction. */
export const suiteControlApproval = core.table('suite_control_approval', {
  id: idPk(),
  action: text('action').$type<'kill_switch.set'>().notNull(),
  operation: jsonb('operation').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  /** The original event owner, independent of the approving admin's working context. */
  operatorId: uuid('operator_id').references(() => operator.id),
  requesterAccountId: uuid('requester_account_id').notNull().references(() => account.id),
  approverAccountId: uuid('approver_account_id').references(() => account.id),
  state: text('state').$type<SuiteControlApprovalState>().notNull(),
  requestExpiresAt: timestamp('request_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  expiredAt: timestamp('expired_at', { withTimezone: true, mode: 'date' }),
  ...timestamps,
}, t => [
  index('suite_control_approval_requester_idx').on(t.requesterAccountId),
  index('suite_control_approval_approver_idx').on(t.approverAccountId),
  index('suite_control_approval_operator_idx').on(t.operatorId),
  index('suite_control_approval_expiry_idx').on(t.state, t.requestExpiresAt),
  check('suite_control_approval_action_check', sql`${t.action} = 'kill_switch.set'`),
  check('suite_control_approval_operation_check', sql`jsonb_typeof(${t.operation}) = 'object'`),
  check('suite_control_approval_digest_check', sql`${t.payloadSha256} ~ '^[a-f0-9]{64}$'`),
  check('suite_control_approval_ten_minutes_check', sql`${t.requestExpiresAt} = ${t.createdAt} + interval '10 minutes'`),
  check('suite_control_approval_state_check', sql`${t.state} in ('pending', 'approved', 'consumed', 'expired')`),
  check('suite_control_approval_transition_check', sql`(
    ${t.state} = 'pending' and ${t.approverAccountId} is null and ${t.approvedAt} is null
    and ${t.consumedAt} is null and ${t.expiredAt} is null
  ) or (
    ${t.state} in ('approved', 'consumed') and ${t.approverAccountId} is not null
    and ${t.approverAccountId} <> ${t.requesterAccountId} and ${t.approvedAt} is not null
    and ${t.approvedAt} >= ${t.createdAt} and ${t.approvedAt} < ${t.requestExpiresAt} and ${t.expiredAt} is null
    and ((${t.state} = 'approved' and ${t.consumedAt} is null)
      or (${t.state} = 'consumed' and ${t.consumedAt} is not null and ${t.consumedAt} >= ${t.approvedAt}
        and ${t.consumedAt} < ${t.requestExpiresAt}))
  ) or (
    ${t.state} = 'expired' and ${t.consumedAt} is null and ${t.expiredAt} is not null and ${t.expiredAt} >= ${t.requestExpiresAt}
    and ((${t.approverAccountId} is null and ${t.approvedAt} is null)
      or (${t.approverAccountId} is not null and ${t.approverAccountId} <> ${t.requesterAccountId}
        and ${t.approvedAt} is not null and ${t.approvedAt} >= ${t.createdAt} and ${t.approvedAt} < ${t.requestExpiresAt}))
  )`),
]);
