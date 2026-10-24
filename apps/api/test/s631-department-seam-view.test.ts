import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOtoAppMigrations, createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';

let client: pg.Client;
let databaseUrl: string;
let drop: (() => Promise<void>) | undefined;
const tenant = newId(), foreignTenant = newId();
const mapped = newId(), otherMapped = newId(), unmapped = newId(), malformed = newId(), upper = newId(), foreignBranch = newId();
const core = newId(), otherCore = newId(), foreignCore = newId();
const multi = newId(), empty = newId(), inactive = newId(), invalid = newId(), foreignDepartment = newId();
const assignedEmployee = newId(), unassignedEmployee = newId(), foreignPrimaryEmployee = newId(), foreignBranchEmployee = newId();
const unknownPrimaryEmployee = newId(), unmappedEmployee = newId(), malformedEmployee = newId(), upperEmployee = newId();
const absentDepartment = newId();
const oldEmployeeSql = fileURLToPath(new URL('../../oto-app/migrations/0005_otoapp_v_employees.sql', import.meta.url));
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const oldEmployeeSqlBefore = fingerprint(readFileSync(oldEmployeeSql, 'utf8'));

beforeAll(async () => {
  const db = await createTestDatabase({ otoapp: true });
  databaseUrl = db.url; drop = db.drop;
  client = new pg.Client({ connectionString: databaseUrl, application_name: 'oto-test-631-view' });
  await client.connect();
  await client.query(`insert into otoapp.tenants (id, name, slug) values
    ($1, 'ZZ TEST 631 view own tenant', $3), ($2, 'ZZ TEST 631 view foreign tenant', $4)`,
  [tenant, foreignTenant, `zz-test-631-${tenant}`, `zz-test-631-${foreignTenant}`]);
  for (const [id, owner, coreId] of [
    [mapped, tenant, core], [otherMapped, tenant, otherCore], [unmapped, tenant, null],
    [malformed, tenant, 'ZZ TEST not-a-core-uuid'],
    [upper, tenant, 'ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF'], [foreignBranch, foreignTenant, foreignCore],
  ]) {
    await client.query(`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
      values ($1, $2, 'ZZ TEST 631 view branch', '', $3)`, [id, owner, coreId]);
  }
  for (const [id, owner, active] of [
    [multi, tenant, true], [empty, tenant, true], [inactive, tenant, false],
    [invalid, tenant, true], [foreignDepartment, foreignTenant, true],
  ]) {
    await client.query(`insert into otoapp.departments (id, tenant_id, name, description, is_active)
      values ($1, $2, 'ZZ TEST 631 view department', 'ZZ TEST private description not in seam', $3)`, [id, owner, active]);
  }
  for (const [departmentId, branchId] of [
    [multi, mapped], [multi, otherMapped], [multi, unmapped], [multi, malformed], [multi, upper],
    [invalid, foreignBranch], [foreignDepartment, mapped],
  ]) {
    await client.query('insert into otoapp.department_branch_assignments (department_id, branch_id) values ($1, $2)',
      [departmentId, branchId]);
  }
  for (const [id, branchId, departmentId] of [
    [assignedEmployee, mapped, multi], [unassignedEmployee, null, null],
    [foreignPrimaryEmployee, mapped, foreignDepartment], [foreignBranchEmployee, foreignBranch, multi],
    [unknownPrimaryEmployee, mapped, absentDepartment], [unmappedEmployee, unmapped, multi],
    [malformedEmployee, malformed, multi], [upperEmployee, upper, multi],
  ]) {
    await client.query(`insert into otoapp.employees
      (id, tenant_id, branch_id, primary_department_id, full_name, nickname, email, food_allowance_per_day, address)
      values ($1, $2, $3, $4, 'ZZ TEST private employee name', 'ZZ TEST private nickname',
        'zz-test-631-private@otopark.test', 631, 'ZZ TEST private employee address')`,
    [id, tenant, branchId, departmentId]);
  }
}, 180_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await drop?.(); } finally { await stopTestServer(); }
  }
});

describe('SCRUM-631 app-owned department read views', () => {
  it('publishes only the three ordered metadata allowlists with stable SQL types', async () => {
    const expected = {
      departments: [['id', 'text'], ['tenant_id', 'uuid'], ['name', 'text'], ['is_active', 'boolean'], ['updated_at', 'timestamp without time zone']],
      department_branches: [['department_id', 'text'], ['tenant_id', 'uuid'], ['otoapp_branch_id', 'text'], ['branch_id', 'uuid']],
      employee_departments: [['id', 'text'], ['tenant_id', 'uuid'], ['otoapp_branch_id', 'text'], ['branch_id', 'uuid'], ['primary_department_id', 'text']],
    };
    for (const [name, columns] of Object.entries(expected)) {
      const result = await client.query<{ column_name: string; data_type: string }>(`
        select column_name, data_type from information_schema.columns
        where table_schema = 'otoapp_v' and table_name = $1 order by ordinal_position`, [name]);
      expect(result.rows.map(row => [row.column_name, row.data_type]), name).toEqual(columns);
    }
  });

  it('includes empty and inactive departments without depending on employee or branch presence', async () => {
    const result = await client.query('select * from otoapp_v.departments where tenant_id = $1 order by id', [tenant]);
    expect(result.rows.map(row => row.id).sort()).toEqual([multi, empty, inactive, invalid].sort());
    expect(result.rows.find(row => row.id === inactive)?.is_active).toBe(false);
    expect(result.rows.every(row => row.updated_at instanceof Date)).toBe(true);
    expect(result.rows.every(row => !('description' in row))).toBe(true);
  });

  it('preserves every multi-branch assignment, including unmapped and invalid core identities', async () => {
    const result = await client.query('select * from otoapp_v.department_branches where department_id = $1', [multi]);
    expect(result.rows).toHaveLength(5);
    const links = new Map(result.rows.map(row => [row.otoapp_branch_id, row.branch_id]));
    expect([...links.keys()].sort()).toEqual([mapped, otherMapped, unmapped, malformed, upper].sort());
    expect(links.get(mapped)).toBe(core); expect(links.get(otherMapped)).toBe(otherCore);
    for (const id of [unmapped, malformed, upper]) expect(links.get(id)).toBeNull();
    expect(result.rows.every(row => row.tenant_id === tenant)).toBe(true);
    expect((await client.query('select * from otoapp_v.department_branches where department_id = $1', [empty])).rows).toEqual([]);
  });

  it('retains corrupt cross-tenant assignments as unmapped instead of joining another tenant branch', async () => {
    const own = (await client.query('select * from otoapp_v.department_branches where department_id = $1', [invalid])).rows;
    expect(own).toEqual([{ department_id: invalid, tenant_id: tenant, otoapp_branch_id: foreignBranch, branch_id: null }]);
    const away = (await client.query('select * from otoapp_v.department_branches where department_id = $1', [foreignDepartment])).rows;
    expect(away).toEqual([{ department_id: foreignDepartment, tenant_id: foreignTenant, otoapp_branch_id: mapped, branch_id: null }]);
  });

  it('includes every employee and null primary membership while leaving source primary IDs for repository validation', async () => {
    const rows = (await client.query('select * from otoapp_v.employee_departments where tenant_id = $1', [tenant])).rows;
    expect(rows).toHaveLength(8);
    const byId = new Map(rows.map(row => [row.id, row]));
    expect(byId.get(assignedEmployee)).toEqual({ id: assignedEmployee, tenant_id: tenant,
      otoapp_branch_id: mapped, branch_id: core, primary_department_id: multi });
    expect(byId.get(unassignedEmployee)).toEqual({ id: unassignedEmployee, tenant_id: tenant,
      otoapp_branch_id: null, branch_id: null, primary_department_id: null });
    expect(byId.get(foreignPrimaryEmployee)?.primary_department_id).toBe(foreignDepartment);
    expect(byId.get(unknownPrimaryEmployee)?.primary_department_id).toBe(absentDepartment);
  });

  it('fences employee branch mappings by tenant and uses the original lowercase UUID validation', async () => {
    const rows = (await client.query('select * from otoapp_v.employee_departments where tenant_id = $1', [tenant])).rows;
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const id of [foreignBranchEmployee, unmappedEmployee, malformedEmployee, upperEmployee]) {
      expect(byId.get(id)?.branch_id).toBeNull();
    }
    expect(byId.get(foreignBranchEmployee)?.otoapp_branch_id).toBe(foreignBranch);
    expect(rows.every(row => Object.keys(row).every(key => !/name|email|phone|salary|allowance|address|tax|birth|face|pin|photo/.test(key)))).toBe(true);
  });

  it('keeps the applied employee-view SQL and its original ordered columns unchanged', async () => {
    expect(fingerprint(readFileSync(oldEmployeeSql, 'utf8'))).toBe(oldEmployeeSqlBefore);
    const columns = (await client.query<{ column_name: string }>(`
      select column_name from information_schema.columns where table_schema = 'otoapp_v' and table_name = 'employees'
      order by ordinal_position`)).rows.map(row => row.column_name);
    expect(columns).toEqual(['id', 'tenant_id', 'otoapp_branch_id', 'branch_id', 'full_name', 'nickname', 'phone',
      'email', 'status', 'employment_state', 'last_working_day', 'updated_at', 'platform_user_id']);
  });

  it('replays the committed app migration chain without another journal row or changing source/view data', async () => {
    const before = (await client.query('select hash, created_at::text from otoapp.__drizzle_migrations order by created_at')).rows;
    const rowsBefore = (await client.query('select * from otoapp_v.employee_departments where tenant_id = $1 order by id', [tenant])).rows;
    await applyOtoAppMigrations(databaseUrl);
    expect((await client.query('select hash, created_at::text from otoapp.__drizzle_migrations order by created_at')).rows).toEqual(before);
    expect((await client.query('select * from otoapp_v.employee_departments where tenant_id = $1 order by id', [tenant])).rows).toEqual(rowsBefore);
    expect((await client.query('select count(*)::int as n from otoapp.employees where tenant_id = $1', [tenant])).rows[0]?.n).toBe(8);
  }, 180_000);
});
