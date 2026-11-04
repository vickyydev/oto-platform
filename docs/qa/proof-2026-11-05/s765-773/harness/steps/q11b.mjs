// Read-only: the ZZ TEST member holding a recorded "Residence certificate" check.
export default async function (S) {
  const v = await S.adminApi('GET', '/members/tier-verifications');
  const row = (v.body?.verifications ?? []).find((r) => r.evidenceType === 'Residence certificate' && /^ZZ TEST/i.test(r.member?.nickname ?? ''));
  const m = await S.adminApi('GET', '/members/' + row.member.id);
  const b = m.body?.member ?? m.body;
  const all = (v.body?.verifications ?? []).filter((r) => r.member?.id === row.member.id).map((r) => ({ evidenceType: r.evidenceType, verifiedAt: r.verifiedAt, expires: r.evidenceExpiresAt }));
  S.st.steps.s11.zzMember = { id: row.member.id, nickname: b?.nickname, archivedAt: b?.archivedAt ?? null, tier: b?.tierCode, current: b?.tierVerification ? { proof: b.tierVerification.proofType, expires: b.tierVerification.expiresAt, by: b.tierVerification.verifiedBy, reverifyDue: b.tierVerification.reverifyDue } : null, history: all };
  S.save();
  return { ...S.st.steps.s11.zzMember, hasPhone: !!b?.phone };
}
