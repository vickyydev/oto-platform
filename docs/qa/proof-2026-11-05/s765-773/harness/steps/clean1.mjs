// Clean-up: archive the five ZZ TEST members this proof created, then read everything back.
export default async function (S) {
  const out = { at: new Date().toISOString(), members: {}, salesTonight: [], openTonight: [] };
  for (const [k, m] of Object.entries(S.st.fixture.members)) {
    if (!/^ZZ TEST 7(65|73) /.test(m.nickname)) throw new Error('not a proof member: ' + k);
    const d = await S.adminApi('DELETE', '/members/' + m.id);
    const r = await S.adminApi('GET', '/members/' + m.id);
    const b = r.body?.member ?? r.body;
    out.members[k] = { nickname: m.nickname, archiveStatus: d.status, readStatus: r.status, archivedAt: b?.archivedAt ?? null };
  }
  const BR = S.st.fixture.branchId, T1 = S.st.fixture.till.id;
  const recent = await S.adminApi('GET', `/sales?branchId=${BR}&stationId=${T1}&limit=40`);
  out.salesTonight = (recent.body?.sales ?? []).filter((s) => (s.occurredAt ?? '') > '2026-11-04T20:00:00Z').map((s) => ({ id: s.id, receipt: s.receiptNumber, status: s.status, at: s.occurredAt, gross: s.totals?.grossSatang, member: s.member?.nickname ?? null }));
  const tend = await S.adminApi('GET', `/sales?branchId=${BR}&stationId=${T1}&status=tendering&limit=50`);
  out.openTotal = (tend.body?.sales ?? []).length;
  out.openTonight = (tend.body?.sales ?? []).filter((s) => (s.occurredAt ?? '') > '2026-11-04T17:00:00Z').map((s) => s.id);
  const tt = await S.adminApi('GET', '/members/01a0fcb5-11fe-7066-b6dc-20029dae26e0');
  const tb = tt.body?.member ?? tt.body;
  out.zzTierThaiUnchanged = { proof: tb?.tierVerification?.proofType ?? null, archivedAt: tb?.archivedAt ?? null };
  S.st.cleanup = { ...(S.st.cleanup ?? {}), ...out };
  S.save();
  return out;
}
