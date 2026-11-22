import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, teardownAll, type TestContext } from './helpers';

describe('SCRUM-1064 | employee contact numbers on the attendance tablet', () => {
  let ctx: TestContext;
  const tenant = randomUUID();
  beforeAll(async () => {
    ctx = await createTestContext({ otoapp: true });
    await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${tenant}, 'ZZ TEST clock', ${tenant})`);
  });
  afterAll(async () => {
    await ctx?.close();
    await teardownAll();
  });

  it('derives the clock number on import, replaces it on contact edit and clears it on removal', async () => {
    const id = randomUUID();
    const created = await ctx.db.execute(sql`insert into otoapp.employees
      (id,tenant_id,full_name,nickname,email,phone) values
      (${id},${tenant},'ZZ TEST Clock','ZZ TEST','test@example.invalid','081 234 5678') returning phone_e164`);
    expect(created.rows[0]?.phone_e164).toBe('+66812345678');
    const edited = await ctx.db.execute(sql`update otoapp.employees set phone='+66 (0)92-345-6789'
      where id=${id} returning phone_e164`);
    expect(edited.rows[0]?.phone_e164).toBe('+66923456789');
    const cleared = await ctx.db.execute(sql`update otoapp.employees set phone=null where id=${id} returning phone_e164`);
    expect(cleared.rows[0]?.phone_e164).toBeNull();
  });

  it('keeps a clock-only legacy record and refuses to derive a number from malformed contact data', async () => {
    const id = randomUUID();
    const legacy = await ctx.db.execute(sql`insert into otoapp.employees
      (id,tenant_id,full_name,nickname,email,phone_e164) values
      (${id},${tenant},'ZZ TEST legacy','ZZ TEST','legacy@example.invalid','+66812345678') returning phone_e164`);
    expect(legacy.rows[0]?.phone_e164).toBe('+66812345678');
    const invalid = await ctx.db.execute(sql`update otoapp.employees set phone='0812345678 ext 9'
      where id=${id} returning phone_e164`);
    expect(invalid.rows[0]?.phone_e164).toBeNull();
  });
});
