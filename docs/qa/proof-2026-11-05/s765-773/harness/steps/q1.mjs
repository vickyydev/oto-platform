// Read-only: the two walk-in sales of the stopped run, their tier claim and member fields.
export default async function (S) {
  const out = {};
  for (const id of ['01a1a846-fd17-7c53-a2a3-b51c435dcbbf', '01a1a847-4764-7baf-a0e1-f6f372c454f9', '01a1a844-310d-7af7-b9e7-a942a389d02d']) {
    const r = await S.adminApi('GET', '/sales/' + id);
    const s = r.body?.sale ?? {};
    out[id] = { status: r.status, saleStatus: s.status, receipt: s.receiptNumber, tier: s.customerTier, memberKeys: Object.keys(s).filter((k) => /member|tier/i.test(k)), memberId: s.memberId ?? null, tierClaim: s.tierClaim ?? null };
  }
  return out;
}
