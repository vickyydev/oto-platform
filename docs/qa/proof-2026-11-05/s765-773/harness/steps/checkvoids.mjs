export default async function (S) {
  const { adminApi, st, save } = S;
  const BR = st.fixture.branchId, T1 = st.fixture.till.id;
  const r = await adminApi('GET', `/sales?branchId=${BR}&stationId=${T1}&status=voided&limit=30`);
  const rows = (r.body?.sales ?? []).map((s) => ({ id: s.id, receipt: s.receiptNumber, status: s.status, occurredAt: s.occurredAt, gross: s.totals?.grossSatang, voidedAt: s.voidedAt ?? s.voided?.at ?? null, voidReason: s.voidReason ?? s.voided?.reason ?? null, soldBy: s.soldBy?.name ?? s.soldBy?.accountId, member: s.memberId, keys: Object.keys(s).join(',') }));
  const t = await adminApi('GET', `/sales?branchId=${BR}&stationId=${T1}&status=tendering&limit=30`);
  const trows = (t.body?.sales ?? []).map((s) => ({ id: s.id, occurredAt: s.occurredAt, gross: s.totals?.grossSatang, soldBy: s.soldBy?.name ?? s.soldBy?.accountId }));
  return { status: r.status, voided: rows.slice(0, 15), tendering: trows };
}
