import { and, eq, sql } from 'drizzle-orm';
import { branch, type Db } from '@oto/db';
import { z } from 'zod';
import { errors } from '../lib/errors';
import type { Tx } from './tx';
import { boothEmployeeLinks } from './otoapp-employees';

export const PayrollBoothQuery = z.object({
  branchId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  after: z.string().uuid().optional(),
});

export const PayrollBoothRecord = z.object({
  voucherId: z.string().uuid(),
  stationId: z.string().uuid(),
  booth: z.string(),
  timezone: z.string(),
  issuedAt: z.string(),
  issuedDay: z.string(),
  issuedMonth: z.string(),
  usedAt: z.string().nullable(),
  usedDay: z.string().nullable(),
  saleId: z.string().uuid().nullable(),
  saleState: z.string().nullable(),
  spendSatang: z.number().int().nonnegative(),
  reversedAt: z.string().nullable(),
  reversals: z.array(z.object({ saleId: z.string().uuid(), usedDay: z.string(), at: z.string() })),
  sharedCode: z.boolean(),
  accountIds: z.array(z.string().uuid()),
  employeeIds: z.array(z.string()).nullable(),
  staffLabel: z.string().nullable(),
});
export const PayrollBoothPage = z.object({
  records: z.array(PayrollBoothRecord),
  next: z.string().uuid().nullable(),
});

/** Resolve the immutable press roster through this operator's employee directory once, on ingest. */
export async function boothPayrollEmployees(tx: Tx, operatorId: string, ids: string[]) {
  if (!ids.length) return [];
  const keys = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const viewLinks = await boothEmployeeLinks(tx, ids);
  const mapped = viewLinks.length
    ? sql`
    union select a.id, v.employee_id from core.account a
    join (values ${sql.join(
      viewLinks.map(
        (link) => sql`(${link.accountId}::uuid,${link.employeeId}::text,${link.branchId}::uuid)`,
      ),
      sql`, `,
    )}) v(account_id,employee_id,branch_id)
      on v.account_id=a.id
    join core.branch b on b.id=v.branch_id and b.operator_id=a.operator_id
    where a.operator_id=${operatorId} and a.id in (${keys})`
    : sql``;
  const rows = await tx.execute<{ id: string }>(sql`
    select min(employee_id) as id from (
      select a.id, e.external_id as employee_id from core.account a
      join core.employee e on e.id = a.employee_id and e.operator_id = a.operator_id
      where a.operator_id = ${operatorId} and a.id in (${keys})
        and e.source = 'otoapp' and e.external_id is not null ${mapped}
    ) links group by links.id having count(distinct employee_id)=1 order by id`);
  return rows.rows.map((row) => row.id);
}

/** The shared till/HR provisioner supplies the operator. Never send guest details or a redeemable code. */
export async function payrollBoothVouchers(
  db: Db,
  operatorId: string,
  query: z.infer<typeof PayrollBoothQuery>,
) {
  const [park] = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.operatorId, operatorId), eq(branch.id, query.branchId)))
    .limit(1);
  if (!park) throw errors.notFound('Branch not found');
  const pageSize = 250;
  const result = await db.execute(sql`
    select v.id as "voucherId", s.station_id as "stationId", st.name as booth, b.timezone,
      v.issued_at as "issuedAt", to_char(v.issued_at at time zone b.timezone, 'YYYY-MM-DD') as "issuedDay",
      to_char(v.issued_at at time zone b.timezone, 'YYYY-MM') as "issuedMonth",
      use.occurred_at as "usedAt", to_char(use.occurred_at at time zone b.timezone, 'YYYY-MM-DD') as "usedDay",
      use.sale_id as "saleId", use.status as "saleState", coalesce(use.gross_satang,0)::float8 as "spendSatang",
      use.reversed_at as "reversedAt", vd.code_mode = 'fixed' as "sharedCode", coalesce(use.reversals,'[]'::jsonb) as reversals,
      coalesce(a.snapshot->'dutyAccountIds', ev.payload->'dutyAccountIds',
        case when s.staff_account_id is not null then jsonb_build_array(s.staff_account_id) else '[]'::jsonb end) as "accountIds",
      a.snapshot->'dutyEmployeeIds' as "employeeIds",
      coalesce(a.snapshot->>'staffLabel', ev.payload->>'staffLabel') as "staffLabel",
      coalesce(cv.bundle->'settings'->>'voucherShowStaff','true') <> 'false' as "staffPrinted"
    from promo.voucher v
    join booth.spin s on s.voucher_id = v.id and s.operator_id = v.operator_id and s.branch_id = v.branch_id and not s.simulated
    join booth.booth_config_version cv on cv.id=s.booth_config_version_id and cv.station_id=s.station_id
    join core.branch b on b.id = s.branch_id and b.operator_id = v.operator_id
    join core.station st on st.id = s.station_id and st.operator_id = v.operator_id
    join promo.voucher_definition vd on vd.id = v.voucher_definition_id and vd.operator_id = v.operator_id
    left join edge.sync_event ev on ev.event_id = s.source_event_id
    left join lateral (select l.after as snapshot from core.audit_log l
      where l.operator_id = v.operator_id and l.entity_type = 'spin' and l.entity_id = s.id::text
        and l.action = 'spin.record' order by l.created_at, l.id limit 1) a on true
    left join lateral (
      with consumed as (
        select r.sale_id, r.occurred_at, x.status, x.gross_satang,
          least(x.voided_at,x.refunded_at,(select min(rr.created_at) from pos.refund rr
            where rr.operator_id=v.operator_id and rr.sale_id=x.id)) as reversed_at
        from promo.voucher_redemption r
        join pos.sale x on x.id=r.sale_id and x.operator_id=r.operator_id
        where r.voucher_id=v.id and r.operator_id=v.operator_id and r.kind='consumed'
      )
      select c.*, (select coalesce(jsonb_agg(jsonb_build_object('saleId',sale_id,'usedDay',
        to_char(occurred_at at time zone b.timezone,'YYYY-MM-DD'),'at',reversed_at)), '[]'::jsonb)
        from consumed where reversed_at is not null) as reversals,
        exists (select 1 from consumed where ${query.month} in (to_char(occurred_at at time zone b.timezone,'YYYY-MM'),
          to_char(reversed_at at time zone b.timezone,'YYYY-MM'),
          to_char((reversed_at at time zone b.timezone)+interval '1 month','YYYY-MM'))) as relevant
      from consumed c order by (c.reversed_at is null and c.status in ('paid','finalised')) desc,
        c.occurred_at, c.sale_id limit 1
    ) use on true
    where v.operator_id=${operatorId} and v.branch_id=${park.id} and v.source='booth' and v.print_count>0
      ${query.after ? sql`and v.id > ${query.after}::uuid` : sql``}
      and (to_char(v.issued_at at time zone b.timezone, 'YYYY-MM')=${query.month} or use.relevant)
    order by v.id limit ${pageSize + 1}`);
  const instant = (value: unknown) =>
    value == null ? null : (value instanceof Date ? value : new Date(String(value))).toISOString();
  const records = result.rows.slice(0, pageSize).map((row) =>
    PayrollBoothRecord.parse({
      ...row,
      ...(row.staffPrinted === false ? { employeeIds: [], accountIds: [], staffLabel: null } : {}),
      issuedAt: instant(row.issuedAt),
      usedAt: instant(row.usedAt),
      reversedAt: instant(row.reversedAt),
    }),
  );
  return { records, next: result.rows.length > pageSize ? records.at(-1)!.voucherId : null };
}
