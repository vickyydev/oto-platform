// Read-only: tonight's sales at Reception Till 1, open (tendering) sales there, and the ZZ TEST members.
export default async function (S) {
  const { adminApi, st } = S;
  const BR = st.fixture.branchId, T1 = st.fixture.till.id;
  const recent = await adminApi('GET', `/sales?branchId=${BR}&stationId=${T1}&limit=30`);
  const tonight = (recent.body?.sales ?? []).filter((s) => (s.createdAt ?? s.occurredAt) > '2026-11-04T20:00:00Z').map((s) => ({ id: s.id, receipt: s.receiptNumber, status: s.status, at: s.occurredAt, gross: s.totals?.grossSatang, member: s.member?.nickname ?? null, soldBy: s.soldBy?.name, lineKinds: s.lineKinds }));
  const tend = await adminApi('GET', `/sales?branchId=${BR}&stationId=${T1}&status=tendering&limit=50`);
  const open = (tend.body?.sales ?? []).map((s) => ({ id: s.id, at: s.occurredAt, gross: s.totals?.grossSatang, member: s.member?.nickname ?? null, soldBy: s.soldBy?.name }));
  const members = {};
  for (const [k, m] of Object.entries(st.fixture.members)) {
    const r = await adminApi('GET', `/members/${m.id}`);
    const b = r.body?.member ?? r.body;
    members[k] = { status: r.status, nickname: b?.nickname, archivedAt: b?.archivedAt ?? null, tier: b?.tierCode ?? null, verification: b?.tierVerification ? { proof: b.tierVerification.proofType, note: b.tierVerification.note, expires: b.tierVerification.expiresAt, by: b.tierVerification.verifiedBy } : null };
  }
  return { recentStatus: recent.status, tonight, openCount: open.length, open, members };
}
