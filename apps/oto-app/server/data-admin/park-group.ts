import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type AnyPgColumn, type AnyPgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../shared/schema';

export const dataAdminContext = new AsyncLocalStorage<{ tenantId: string }>();
export class DataAdminScopeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const financeTables = new Set([
  'xero_sync_runs',
  'xero_tracking_categories',
  'xero_tracking_options',
  'xero_reports_raw',
  'pl_facts',
  'cash_txns',
  'cash_daily',
]);
const parents: Record<string, string> = {
  auth_otp_events: 'user_id',
  branch_events: 'branch_id',
  contract_instances: 'employee_id',
  coverage_rules: 'branch_id',
  department_branch_assignments: 'branch_id',
  employee_assets: 'employee_id',
  employee_changes: 'employee_id',
  employee_documents: 'employee_id',
  employee_letters: 'employee_id',
  employee_offboarding: 'employee_id',
  employee_roles: 'employee_id',
  enrollment_sessions: 'employee_id',
  kiosk_auth_attempts: 'branch_id',
  offboarding_checklist: 'employee_id',
  payroll_day_reconciliations: 'payroll_run_id',
  payroll_employee_summaries: 'payroll_run_id',
  payroll_exceptions: 'payroll_run_id',
  payroll_exception_approvals: 'payroll_exception_id',
  payroll_line_items: 'payroll_run_id',
  payroll_runs: 'payroll_period_id',
  payslips: 'payroll_run_id',
  role_branch_assignments: 'branch_id',
  role_department_map: 'department_id',
  salary_advance_repayments: 'salary_advance_id',
  schedule_template_assignments: 'template_row_id',
  statutory_calculation_results: 'payroll_run_id',
  template_assignments: 'branch_id',
};

/** The same strict placement as User Management, including its sole-group fallback. */
export function userScope(userColumn: AnyPgColumn | SQL, tenantId: string): SQL {
  return sql`(
    (exists (select 1 from ${schema.userBranchAccess} uba where uba.user_id = ${userColumn} and uba.tenant_id = ${tenantId})
      and not exists (select 1 from ${schema.userBranchAccess} uba left join ${schema.branches} b on b.id = uba.branch_id
        where uba.user_id = ${userColumn} and (uba.tenant_id <> ${tenantId} or (uba.branch_id is not null and (b.id is null or b.tenant_id <> ${tenantId}))))
      and not exists (select 1 from ${schema.users} owner_user left join ${schema.operators} o on o.id = owner_user.operator_id
        where owner_user.id = ${userColumn} and owner_user.role = 'operator_admin' and owner_user.operator_id is not null and (o.id is null or o.tenant_id <> ${tenantId})))
    or (not exists (select 1 from ${schema.userBranchAccess} uba where uba.user_id = ${userColumn})
      and (select count(*) from ${schema.tenants}) = 1 and exists (select 1 from ${schema.tenants} t where t.id = ${tenantId}))
  )`;
}

export function personScope(id: AnyPgColumn | SQL, tenantId: string): SQL {
  const owner = (getTableColumns(schema.people) as Record<string, AnyPgColumn>).tenantId;
  const anchor = owner ? sql`${owner} = ${tenantId}` : sql`false`;
  const consistentAnchor = owner ? sql`(${owner} is null or ${owner} = ${tenantId})` : sql`true`;
  return sql`(
    (${anchor} or exists (select 1 from ${schema.accessPolicies} ap where ap.person_id = ${id} and ap.tenant_id = ${tenantId})
      or exists (select 1 from ${schema.employees} e where e.person_id = ${id} and e.tenant_id = ${tenantId})
      or ((select count(*) from ${schema.tenants}) = 1 and exists (select 1 from ${schema.tenants} t where t.id = ${tenantId})))
    and ${consistentAnchor}
    and not exists (select 1 from ${schema.users} u join ${schema.people} p on p.email = u.email where p.id = ${id} and not (${userScope(sql`u.id`, tenantId)}))
    and not exists (select 1 from ${schema.accessPolicies} ap where ap.person_id = ${id} and ap.tenant_id <> ${tenantId})
    and not exists (select 1 from ${schema.accessPolicies} ap where ap.person_id = ${id} and ap.core_user_id is not null and not (${userScope(sql`ap.core_user_id`, tenantId)}))
    and not exists (select 1 from ${schema.employees} e where e.person_id = ${id} and e.tenant_id <> ${tenantId})
  )`;
}

/** Every registered model has a direct owner or a named business parent. */
export function rowScope(table: AnyPgTable, tenantId: string, _sharedRoles = false): SQL {
  const config = getTableConfig(table);
  const columns = getTableColumns(table) as Record<string, AnyPgColumn>;
  if (config.name === 'tenants') return eq(columns.id, tenantId);
  if (config.name === 'users') return userScope(columns.id, tenantId);
  if (config.name === 'people') return personScope(columns.id, tenantId);
  if (financeTables.has(config.name)) {
    return sql`exists (select 1 from ${schema.xeroTokens} xt where xt.tenant_id = ${tenantId} and xt.xero_tenant_id = ${columns.tenantId})
      and not exists (select 1 from ${schema.xeroTokens} xt where xt.xero_tenant_id = ${columns.tenantId} and (xt.tenant_id is null or xt.tenant_id <> ${tenantId}))`;
  }
  if (columns.tenantId) {
    if (config.name === 'roles') {
      return sql`(${columns.tenantId} = ${tenantId} or ${columns.tenantId} in (select id from ${schema.tenants} where slug = 'default'))`;
    }
    return eq(columns.tenantId, tenantId);
  }
  const parent = parents[config.name];
  const fk = config.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === parent));
  if (!fk)
    throw new DataAdminScopeError(
      503,
      'This model needs a park-group ownership link before data administration is available',
    );
  const ref = fk.reference();
  return sql`exists (select 1 from ${ref.foreignTable} where ${and(eq(ref.foreignColumns[0], ref.columns[0]), rowScope(ref.foreignTable, tenantId))})`;
}

export function currentTenant(): string {
  const tenantId = dataAdminContext.getStore()?.tenantId;
  if (!tenantId) throw new DataAdminScopeError(403, 'Access denied');
  return tenantId;
}
