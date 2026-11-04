// Plan steps 11 and 12, read-only: any recorded "Residence certificate" check on a ZZ TEST member,
// and the audit rows for tonight's tier verifications (actor = the signed-in reception account).
export default async function (S) {
  const v = await S.adminApi('GET', '/members/tier-verifications');
  const rows = v.body?.verifications ?? [];
  const residence = rows.filter((r) => r.evidenceType === 'Residence certificate').map((r) => ({ member: r.member?.nickname, zz: /^ZZ TEST/i.test(r.member?.nickname ?? ''), verifiedAt: r.verifiedAt }));
  const tonightIds = new Set(Object.values(S.st.fixture.members).map((m) => m.id));
  const tonight = rows.filter((r) => tonightIds.has(r.member?.id)).map((r) => ({ id: r.id, member: r.member?.nickname, evidenceType: r.evidenceType, note: r.note, expires: r.evidenceExpiresAt, verifiedBy: r.verifiedBy, verifiedAt: r.verifiedAt }));
  const a = await S.adminApi('GET', '/audit?entityType=member_tier_verification&from=2026-11-04T20:00:00.000Z&limit=50');
  const entries = (a.body?.entries ?? []).map((e) => ({ at: e.createdAt, action: e.action, entityId: e.entityId, actor: e.actorAccountId ?? e.actor?.id ?? null, actorName: e.actorName ?? e.actor?.name ?? null, evidence: e.after?.evidenceType ?? e.after?.evidence_type ?? null, note: e.after?.note ?? null, expires: e.after?.evidenceExpiresAt ?? e.after?.evidence_expires_at ?? null }));
  const receptionId = S.st.tills?.till?.accountId;
  S.st.steps.s11 = { at: new Date().toISOString(), listStatus: v.status, rowsRead: rows.length, residenceCertificateRows: residence, zzResidenceCertificate: residence.filter((r) => r.zz).length };
  S.st.steps.s12 = { at: new Date().toISOString(), auditStatus: a.status, masked: a.body?.masked ?? null, entries, allByReception: entries.length > 0 && entries.every((e) => e.actor === receptionId), verificationsTonight: tonight };
  S.save();
  return { s11: S.st.steps.s11, s12: S.st.steps.s12, sampleKeys: Object.keys(a.body?.entries?.[0] ?? {}) };
}
