// Sign the till and the Console sessions out, and read each back.
export default async function (S) {
  const out = {};
  const so = await S.pageApi('till', 'POST', '/auth/sign-out', {});
  const me = await S.pageApi('till', 'GET', '/me');
  out.till = { signOut: so.status, meAfter: me.status };
  const c = S.pages.console.page;
  out.console = await c.evaluate(async () => {
    const id = crypto.randomUUID();
    const so = await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'idempotency-key': id, 'x-oto-action-id': id }, body: '{}' });
    const me = await fetch('/api/me', { credentials: 'include' });
    return { signOut: so.status, meAfter: me.status };
  });
  await S.closePage('till');
  await S.closePage('console');
  S.st.cleanup.sessions = { at: new Date().toISOString(), ...out };
  S.save();
  return out;
}
