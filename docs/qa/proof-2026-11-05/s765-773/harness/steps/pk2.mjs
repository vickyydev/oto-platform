export default async function (S) {
  const BR = S.st.fixture.branchId;
  const r = await S.adminApi('GET', `/branches/${BR}/ticket-packages`);
  const list = r.body?.packages ?? r.body?.ticketPackages ?? r.body;
  return list.map((x) => ({ name: x.name, adultRules: x.adultRules, freebies: x.freebies, creditRule: x.creditRule, tierPricing: JSON.stringify(x.tierPricing).slice(0, 300) }));
}
