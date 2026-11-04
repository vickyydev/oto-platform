// Finding evidence, then clean-up: the unpaid walk-in sale the stopped run left at 03:36 today.
// The notice is only photographed; the void goes through the API on this till's own session.
const ID = '01a1a846-fd17-7c53-a2a3-b51c435dcbbf';
export default async function (S) {
  const page = S.pages.till.page;
  const n = page.getByTestId('left-behind-sale').filter({ hasText: '5 Nov 2026 03:36' });
  if ((await n.count()) !== 1) throw new Error('expected exactly one notice for the 03:36 sale');
  const file = S.OUT + '/s773-st-09k-finding-unpaid-duplicate-after-walk-in-entered-details.png';
  await n.screenshot({ path: file });
  S.st.images.push({ file: S.REL + '/s773-st-09k-finding-unpaid-duplicate-after-walk-in-entered-details.png', at: new Date().toISOString(), page: 'till', url: page.url(), note: 'photographed only; nothing on the notice was pressed' });
  const before = await S.adminApi('GET', '/sales/' + ID);
  if (before.body?.sale?.status !== 'tendering' || before.body?.sale?.occurredAt < '2026-11-04T20:00:00Z') throw new Error('not the expected open sale from tonight');
  const v = await S.pageApi('till', 'POST', `/sales/${ID}/void`, { reason: 'ZZ TEST proof clean-up: unpaid duplicate left by the SCRUM-773 staging proof run' });
  const after = await S.adminApi('GET', '/sales/' + ID);
  const s = after.body?.sale ?? {};
  S.st.cleanup = S.st.cleanup ?? {};
  S.st.cleanup.leftoverSale = { id: ID, at: new Date().toISOString(), voidStatus: v.status, error: v.body?.error?.code ?? null, readBack: { status: s.status, voidedAt: s.voidedAt ?? null, voidReason: s.voidReason ?? null, tierClaim: s.tierClaim ? { documentKind: s.tierClaim.documentKind, note: s.tierClaim.documentNote } : null } };
  S.save();
  return S.st.cleanup.leftoverSale;
}
