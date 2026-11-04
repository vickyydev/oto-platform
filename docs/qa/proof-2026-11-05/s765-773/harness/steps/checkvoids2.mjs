export default async function (S) {
  const { adminApi, st, save } = S;
  const BR = st.fixture.branchId, T1 = st.fixture.till.id;
  const all = [];
  let cursor = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await adminApi('GET', `/sales?branchId=${BR}&stationId=${T1}&status=voided&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    all.push(...(r.body?.sales ?? []));
    cursor = r.body?.nextCursor ?? null;
    if (!cursor) break;
  }
  const tonight = all.filter((s) => s.voidedAt && s.voidedAt > '2026-11-04T20:00:00Z').map((s) => ({ id: s.id, occurredAt: s.occurredAt, gross: s.totals?.grossSatang, voidedAt: s.voidedAt, voidedBy: s.voidedByName, soldBy: s.soldBy?.name, reason: s.voidReason, member: s.member?.nickname ?? s.member?.name ?? null, lineKinds: s.lineKinds, channel: s.salesChannel }));
  st.incidents = st.incidents ?? [];
  st.voidedTonight = tonight; save();
  return { total: all.length, tonight };
}
