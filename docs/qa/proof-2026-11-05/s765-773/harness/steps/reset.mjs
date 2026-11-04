// Back out of the old unpaid sale opened on screen by mistake, without voiding or paying it:
// forget it in this tab's storage, sign this session out, close the tab. Nothing is written to the sale.
export default async function (S) {
  const { pages, pageApi, closePage, st, save } = S;
  const page = pages.till.page;
  const removed = await page.evaluate(() => {
    const out = [];
    for (const s of [sessionStorage, localStorage]) for (const k of Object.keys(s)) if (k.startsWith('oto.till.saleOnScreen.')) { out.push(k); s.removeItem(k); }
    return out;
  });
  const out = await pageApi('till', 'POST', '/auth/sign-out', {});
  await closePage('till');
  st.incidents = st.incidents ?? [];
  st.incidents.push({ at: new Date().toISOString(), what: 'The first notice-dismiss loop pressed "Resume this sale" on an old unpaid ZZ TEST Parent sale of 1 Oct (฿1935) at Reception Till 1. Resume only reads the sale; the tab was closed without paying, cancelling or voiding it.', removedKeys: removed.length, signOut: out.status });
  save();
  return { removed: removed.length, signOut: out.status };
}
