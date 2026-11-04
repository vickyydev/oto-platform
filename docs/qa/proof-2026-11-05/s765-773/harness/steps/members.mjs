// Four ZZ TEST members made from the till session (own records only). Phones are test numbers, never printed.
export default async function (S) {
  const { st, save, pageApi } = S;
  const f = st.fixture;
  f.members = f.members ?? {};
  const want = [['socks', 'ZZ TEST 765 Socks', 76501], ['nowallet', 'ZZ TEST 765 No Wallet', 76511], ['licence', 'ZZ TEST 773 Licence', 77301], ['other', 'ZZ TEST 773 Other', 77311]];
  for (const [key, nickname, start] of want) {
    if (f.members[key]) continue;
    let phone = null;
    for (let n = start; n < start + 9; n += 1) {
      const p = '+668976' + String(n).padStart(5, '0');
      const look = await pageApi('till', 'GET', '/members/lookup?phone=' + encodeURIComponent(p));
      if (look.status === 404 || (look.status === 200 && !look.body?.member)) { phone = p; break; }
    }
    if (!phone) throw new Error('no free test phone for ' + key);
    const res = await pageApi('till', 'POST', '/members', { phone, nickname, createdVia: 'pos' });
    if (res.status !== 200 && res.status !== 201) throw new Error('member ' + key + ' ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 300));
    const m = res.body.member;
    f.members[key] = { id: m.id, nickname: m.nickname, phone: m.phone, tierCode: m.tierCode ?? m.tier ?? null, createdAt: new Date().toISOString() };
    st.created.push({ kind: 'member', id: m.id, name: nickname });
    save();
  }
  return Object.fromEntries(Object.entries(f.members).map(([k, v]) => [k, { id: v.id, nickname: v.nickname, tier: v.tierCode }]));
}
