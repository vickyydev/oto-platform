export default async function (S) {
  const so = await S.adminApi('POST', '/auth/sign-out', {});
  const me = await S.adminApi('GET', '/me');
  S.st.cleanup.sessions.admin = { signOut: so.status, meAfter: me.status };
  S.st.finishedAt = new Date().toISOString();
  S.save();
  return S.st.cleanup.sessions;
}
