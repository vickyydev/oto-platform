import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import { storage } from '../server/storage';

// Runs only in the disposable, migrated database made by the review test.
const tenant = randomUUID();
const branch = randomUUID();
const group = randomUUID();
const department = randomUUID();
const role = randomUUID();
const employee = randomUUID();
const casual = randomUUID();
const plan = randomUUID();
const old = randomUUID();
const replacement = randomUUID();
const adjacent = randomUUID();
const date = '2026-11-23';
const name = 'ZZ TEST retired shift';
const q = (query: string, values: string[]) => pool.query(query, values);
try {
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /test/i);
  await q('insert into tenants (id,name,slug) values ($1,$2,$3)', [tenant, name, tenant]);
  await q("insert into branches (id,tenant_id,name,address) values ($1,$2,$3,'ZZ TEST')", [
    branch,
    tenant,
    name,
  ]);
  await q('insert into departments (id,tenant_id,name) values ($1,$2,$3)', [
    department,
    tenant,
    name,
  ]);
  await q('insert into roles (id,tenant_id,name) values ($1,$2,$3)', [role, tenant, name]);
  await q('insert into shift_groups (id,tenant_id,branch_id,name) values ($1,$2,$3,$4)', [
    group,
    tenant,
    branch,
    name,
  ]);
  await q(
    'insert into schedule_week_plans (id,tenant_id,branch_id,week_start_date) values ($1,$2,$3,$4)',
    [plan, tenant, branch, date],
  );
  await q(
    "insert into employees (id,tenant_id,branch_id,primary_department_id,full_name,nickname,email,status) values ($1,$2,$3,$4,$5,$5,'zz-1068@example.invalid','active')",
    [employee, tenant, branch, department, name],
  );
  await q(
    "insert into casual_workers (id,tenant_id,branch_id,department_id,role_id,full_name,nickname,start_date,end_date,daily_rate) values ($1,$2,$3,$4,$5,$6,$6,'2026-01-01','2026-12-31',100)",
    [casual, tenant, branch, department, role, name],
  );
  for (const [id, start, end] of [
    [old, '09:30', '18:30'],
    [replacement, '11:00', '20:00'],
    [adjacent, '18:30', '22:00'],
  ]) {
    await q(
      'insert into schedule_shift_rows (id,tenant_id,branch_id,department_id,shift_group_id,week_plan_id,start_time,end_time) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, tenant, branch, department, group, plan, start, end],
    );
  }
  await q(
    'insert into schedule_assignments (tenant_id,week_plan_id,shift_row_id,shift_date,employee_id) values ($1,$2,$3,$4,$5)',
    [tenant, plan, old, date, employee],
  );
  await q(
    "insert into schedule_assignments (tenant_id,week_plan_id,shift_row_id,shift_date,assignee_type,casual_worker_id) values ($1,$2,$3,$4,'casual',$5)",
    [tenant, plan, old, date, casual],
  );
  const employed = (target: string) =>
    storage.canAssignEmployeeToShift(employee, target, date, undefined, tenant);
  const freelance = (target: string) =>
    storage.canAssignCasualWorkerToShift(casual, target, date, tenant);
  for (const validate of [employed, freelance]) {
    assert.equal((await validate(adjacent)).ok, true);
    assert.equal((await validate(replacement)).conflictingShift?.shiftRowId, old);
  }
  await q("update schedule_shift_rows set active_until_date='2026-11-22' where id=$1", [old]);
  for (const validate of [employed, freelance]) {
    assert.equal((await validate(replacement)).ok, true);
    assert.equal((await validate(old)).ok, false);
  }
  assert.equal(await storage.hasEmployeeShiftOnDate(employee, date, undefined, tenant), false);
  assert.equal((await storage.getEmployeeAssignmentsOnDate(employee, date, tenant)).length, 0);
  assert.equal(
    (await q('select count(*)::int n from schedule_assignments where shift_row_id=$1', [old]))
      .rows[0].n,
    2,
  );
  await q('update schedule_shift_rows set active_from_date=$2, active_until_date=$2 where id=$1', [
    old,
    date,
  ]);
  for (const validate of [employed, freelance]) {
    assert.equal((await validate(replacement)).conflictingShift?.shiftRowId, old);
  }
  console.log('Retired assignments, inclusive boundaries and touching shifts passed.');
} finally {
  await pool.end();
}
