import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';
import {
  otoAppDepartmentsInstalled,
  readAppDepartmentSnapshot,
} from '../src/services/otoapp-departments';
import { OtoAppSeamNotGrantedError } from '../src/services/otoapp-events';
import type { Exec, Tx } from '../src/services/tx';

// The app migration has its own source-table/tenant tests. These independent
// metadata fixtures prove the reader without requiring the app runtime or
// allowing any app-table privilege. No projection or adoption policy lives here.
const views = ['departments', 'department_branches', 'employee_departments'] as const;
const tenantA = newId();
const tenantB = newId();
const ids = {
  active: newId(), inactive: newId(), empty: newId(), foreign: newId(),
  appBranchA: newId(), appUnmapped: newId(), appBranchB: newId(),
  branchA: newId(), branchB: newId(), member: newId(), unassigned: newId(), foreignMember: newId(),
};
const timestamp = '2026-10-24 09:10:11.123';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let absentDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;
let absentPool: pg.Pool;
let db: Db;
let absentDb: Db;
const queries: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  absentDatabase = await createTestDatabase();
  pool = new pg.Pool({ connectionString: database.url });
  absentPool = new pg.Pool({ connectionString: absentDatabase.url });
  db = drizzle(pool, { logger: { logQuery(query) { queries.push(query); } } }) as unknown as Db;
  absentDb = drizzle(absentPool) as unknown as Db;
  await pool.query(`
    create schema zz_s631_source;
    create schema otoapp_v;
    create table zz_s631_source.departments (
      id text primary key, tenant_id uuid not null, name text not null,
      is_active boolean not null, updated_at timestamp not null, private_note text
    );
    create table zz_s631_source.department_branches (
      department_id text not null, tenant_id uuid not null, otoapp_branch_id text not null,
      branch_id uuid, private_note text
    );
    create table zz_s631_source.employee_departments (
      id text primary key, tenant_id uuid not null, otoapp_branch_id text, branch_id uuid,
      primary_department_id text, private_note text
    );
    create view otoapp_v.departments as
      select id, tenant_id, name, is_active, updated_at from zz_s631_source.departments;
    create view otoapp_v.department_branches as
      select department_id, tenant_id, otoapp_branch_id, branch_id from zz_s631_source.department_branches;
    create view otoapp_v.employee_departments as
      select id, tenant_id, otoapp_branch_id, branch_id, primary_department_id from zz_s631_source.employee_departments;
  `);
  await pool.query(`insert into zz_s631_source.departments values
    ($1,$2,'ZZ TEST active',true,$3,'ZZ TEST hidden'),
    ($4,$2,'ZZ TEST inactive',false,$3,'ZZ TEST hidden'),
    ($5,$2,'ZZ TEST empty',true,$3,'ZZ TEST hidden'),
    ($6,$7,'ZZ TEST other tenant',true,$3,'ZZ TEST hidden')`,
  [ids.active, tenantA, timestamp, ids.inactive, ids.empty, ids.foreign, tenantB]);
  await pool.query(`insert into zz_s631_source.department_branches values
    ($1,$2,$3,$4,'ZZ TEST hidden'), ($1,$2,$5,null,'ZZ TEST hidden'),
    ($6,$7,$8,$9,'ZZ TEST hidden')`,
  [ids.active, tenantA, ids.appBranchA, ids.branchA, ids.appUnmapped,
    ids.foreign, tenantB, ids.appBranchB, ids.branchB]);
  await pool.query(`insert into zz_s631_source.employee_departments values
    ($1,$2,$3,$4,$5,'ZZ TEST hidden'), ($6,$2,null,null,null,'ZZ TEST hidden'),
    ($7,$8,$9,$10,$11,'ZZ TEST hidden')`,
  [ids.member, tenantA, ids.appBranchA, ids.branchA, ids.active, ids.unassigned,
    ids.foreignMember, tenantB, ids.appBranchB, ids.branchB, ids.foreign]);
});

afterAll(async () => {
  await pool?.end();
  await absentPool?.end();
  await database?.drop();
  await absentDatabase?.drop();
  await stopTestServer();
});

async function rolledBack(work: (tx: Tx) => Promise<void>): Promise<void> {
  const rollback = Symbol('s631 rollback');
  try {
    await db.transaction(async tx => { await work(tx); throw rollback; });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function withReader(work: (role: string, asRole: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>) => Promise<void>) {
  const role = `s631_reader_${newId().replace(/-/g, '').slice(-12)}`;
  await db.execute(sql.raw(`create role ${role} nologin`));
  const asRole = <T>(read: (tx: Tx) => Promise<T>) => db.transaction(async tx => {
    await tx.execute(sql.raw(`set local role ${role}`));
    return read(tx);
  });
  try {
    await work(role, asRole);
  } finally {
    await db.execute(sql.raw(`drop owned by ${role}`));
    await db.execute(sql.raw(`drop role ${role}`));
  }
}

describe('SCRUM-631 department metadata source reader', () => {
  it('distinguishes no schema from a complete empty snapshot', async () => {
    expect(await otoAppDepartmentsInstalled(absentDb)).toBe(false);
    expect(await readAppDepartmentSnapshot(absentDb)).toBeNull();
    await absentDb.execute(sql`create schema otoapp_v`);
    expect(await otoAppDepartmentsInstalled(absentDb)).toBe(false);
    expect(await readAppDepartmentSnapshot(absentDb)).toBeNull();
  });

  it.each(views)('refuses a ready snapshot when required view %s is absent', async view => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(`alter view otoapp_v.${view} rename to zz_s631_absent`));
      expect(await otoAppDepartmentsInstalled(tx)).toBe(false);
      expect(await readAppDepartmentSnapshot(tx)).toBeNull();
    });
  });

  it('recognises all three views and returns a genuine empty snapshot as installed', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`delete from zz_s631_source.departments`);
      await tx.execute(sql`delete from zz_s631_source.department_branches`);
      await tx.execute(sql`delete from zz_s631_source.employee_departments`);
      expect(await otoAppDepartmentsInstalled(tx)).toBe(true);
      expect(await readAppDepartmentSnapshot(tx)).toEqual({ departments: [], branches: [], members: [] });
    });
  });

  it('reads every tenant, inactive and empty masters, with typed dates', async () => {
    const snapshot = await readAppDepartmentSnapshot(db);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.departments).toHaveLength(4);
    expect(snapshot!.departments.find(row => row.id === ids.inactive)).toEqual({
      id: ids.inactive, tenantId: tenantA, name: 'ZZ TEST inactive', isActive: false,
      updatedAt: new Date(timestamp),
    });
    expect(snapshot!.departments.find(row => row.id === ids.empty)?.isActive).toBe(true);
    expect(snapshot!.departments.find(row => row.id === ids.foreign)?.tenantId).toBe(tenantB);
    expect(snapshot!.departments.every(row => row.updatedAt instanceof Date)).toBe(true);
  });

  it('preserves assigned-but-unmapped and nullable membership rows without inventing scope', async () => {
    const snapshot = await readAppDepartmentSnapshot(db);
    expect(snapshot!.branches).toHaveLength(3);
    expect(snapshot!.branches.find(row => row.otoappBranchId === ids.appUnmapped)).toEqual({
      departmentId: ids.active, tenantId: tenantA, otoappBranchId: ids.appUnmapped, branchId: null,
    });
    expect(snapshot!.members).toHaveLength(3);
    expect(snapshot!.members.find(row => row.id === ids.unassigned)).toEqual({
      id: ids.unassigned, tenantId: tenantA, otoappBranchId: null, branchId: null, primaryDepartmentId: null,
    });
    expect(snapshot!.members.find(row => row.id === ids.foreignMember)).toEqual({
      id: ids.foreignMember, tenantId: tenantB, otoappBranchId: ids.appBranchB,
      branchId: ids.branchB, primaryDepartmentId: ids.foreign,
    });
  });

  it('uses exact public field allowlists and deterministic source-id order', async () => {
    const snapshot = await readAppDepartmentSnapshot(db);
    expect(Object.keys(snapshot!).sort()).toEqual(['branches', 'departments', 'members']);
    for (const row of snapshot!.departments) {
      expect(Object.keys(row).sort()).toEqual(['id', 'isActive', 'name', 'tenantId', 'updatedAt']);
    }
    for (const row of snapshot!.branches) {
      expect(Object.keys(row).sort()).toEqual(['branchId', 'departmentId', 'otoappBranchId', 'tenantId']);
    }
    for (const row of snapshot!.members) {
      expect(Object.keys(row).sort()).toEqual(['branchId', 'id', 'otoappBranchId', 'primaryDepartmentId', 'tenantId']);
    }
    expect(snapshot!.departments.map(row => row.id)).toEqual([ids.active, ids.inactive, ids.empty, ids.foreign].sort());
    expect(snapshot!.members.map(row => row.id)).toEqual([ids.member, ids.unassigned, ids.foreignMember].sort());
    const assignmentKeys = snapshot!.branches.map(row => `${row.departmentId}/${row.otoappBranchId}`);
    expect(assignmentKeys).toEqual([...assignmentKeys].sort());
  });

  it('fetches all three collections in one data statement for one source snapshot', async () => {
    queries.length = 0;
    const snapshot = await readAppDepartmentSnapshot(db);
    expect(snapshot!.departments).toHaveLength(4);
    const sourceReads = queries.filter(query => /\b(?:from|join)\s+otoapp_v\./i.test(query));
    expect(sourceReads).toHaveLength(1);
    for (const view of views) expect(sourceReads[0]).toContain(`otoapp_v.${view}`);
  });

  it('runs in a READ ONLY transaction without changing the source', async () => {
    await db.transaction(async tx => {
      await tx.execute(sql`set transaction read only`);
      expect(await otoAppDepartmentsInstalled(tx)).toBe(true);
      expect((await readAppDepartmentSnapshot(tx))!.members).toHaveLength(3);
    });
    const sourceCount = await pool.query<{ n: number }>('select count(*)::int as n from zz_s631_source.departments');
    expect(sourceCount.rows[0]!.n).toBe(4);
  });

  it('names missing USAGE instead of executing a read or answering empty', async () => {
    await withReader(async (_role, asRole) => {
      const error: unknown = await asRole(tx => readAppDepartmentSnapshot(tx)).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(OtoAppSeamNotGrantedError);
      expect((error as OtoAppSeamNotGrantedError).missing).toEqual(['USAGE on schema otoapp_v']);
    });
  });

  it('names every missing SELECT, and SELECT on one view does not authorise the others', async () => {
    await withReader(async (role, asRole) => {
      await db.execute(sql.raw(`grant usage on schema otoapp_v to ${role}`));
      await db.execute(sql.raw(`grant select on otoapp_v.departments to ${role}`));
      const error: unknown = await asRole(tx => readAppDepartmentSnapshot(tx)).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(OtoAppSeamNotGrantedError);
      expect((error as OtoAppSeamNotGrantedError).missing).toEqual([
        'SELECT on otoapp_v.department_branches', 'SELECT on otoapp_v.employee_departments',
      ]);
    });
  });

  it('needs SELECT on the three views only, without raw source-table privileges', async () => {
    await withReader(async (role, asRole) => {
      await db.execute(sql.raw(`grant usage on schema otoapp_v to ${role}`));
      for (const view of views) await db.execute(sql.raw(`grant select on otoapp_v.${view} to ${role}`));
      expect(await asRole(tx => otoAppDepartmentsInstalled(tx))).toBe(true);
      expect((await asRole(tx => readAppDepartmentSnapshot(tx)))!.departments).toHaveLength(4);
      const privileges = await asRole(tx => tx.execute<{ usage: boolean }>(
        sql`select has_schema_privilege(to_regnamespace('zz_s631_source')::oid, 'USAGE') as usage`,
      ));
      expect(privileges.rows[0]!.usage).toBe(false);
    });
  });

  it('propagates a source read failure after successful capability checks', async () => {
    const failure = new Error('ZZ TEST source unavailable');
    const failing = {
      execute: async (query: Parameters<Exec['execute']>[0]) => {
        const before = queries.length;
        const result = await db.execute(query);
        if (queries.slice(before).some(text => /\b(?:from|join)\s+otoapp_v\./i.test(text))) throw failure;
        return result;
      },
    } as unknown as Exec;
    await expect(readAppDepartmentSnapshot(failing)).rejects.toBe(failure);
  });

  it('declares only the metadata views, no raw app tables, schema imports or writes', () => {
    const source = readFileSync(new URL('../src/services/otoapp-departments.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]@oto\/db['"]|\botoapp\./);
    expect(source).not.toMatch(/\b(?:insert\s+into|update\s+\w|delete\s+from|truncate|merge\s+into|alter\s+|create\s+|drop\s+)/i);
    const relations = [...source.matchAll(/\b(?:from|join)\s+(otoapp_v\.[a-z_]+)/gi)].map(match => match[1]);
    expect([...new Set(relations)].sort()).toEqual(views.map(view => `otoapp_v.${view}`).sort());
  });
});
