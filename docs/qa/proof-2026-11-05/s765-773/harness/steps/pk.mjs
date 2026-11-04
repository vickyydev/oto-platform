export default async function (S) {
  const BR = S.st.fixture.branchId;
  for (const p of [`/branches/${BR}/ticket-packages`, `/ticket-packages?branchId=${BR}`, `/branches/${BR}/packages`]) {
    const r = await S.adminApi('GET', p);
    if (r.status === 200) {
      const list = r.body?.packages ?? r.body?.ticketPackages ?? r.body;
      return { path: p, rows: (Array.isArray(list) ? list : []).map((x) => ({ name: x.name, includedAdults: x.includedAdults, wallet: x.walletCreditAmount ?? x.walletCreditSatang ?? null, adultCredit: x.adultCreditSatang ?? null, keys: Object.keys(x).join(',').slice(0, 400) })) };
    }
  }
  return 'none';
}
