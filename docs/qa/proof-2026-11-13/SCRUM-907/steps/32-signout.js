S.phase = 'sign-out: every session of this run, each read back';
const out = { at: new Date().toISOString() };
for (const label of Object.keys(S.pages)) out[label] = await S.signOutTill(label);
if (S.app) {
  const c = S.app.ctx;
  const lo = await c.request.post(S.APP + '/api/logout', { headers: { 'Idempotency-Key': S.randomUUID() } }).catch(() => null);
  const so = await c.request.post(S.LAUNCHER + '/api/auth/sign-out', { data: {}, headers: { 'Idempotency-Key': S.randomUUID() } }).catch(() => null);
  out.otoApp = { appLogout: lo?.status() ?? null, launcherSignOut: so?.status() ?? null, appUserAfter: (await c.request.get(S.APP + '/api/user').catch(() => null))?.status() ?? null, launcherMeAfter: (await c.request.get(S.LAUNCHER + '/api/me').catch(() => null))?.status() ?? null };
  await c.close().catch(() => {});
  S.app = null;
}
const so = await S.admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': S.randomUUID() } });
out.platformAdmin = { signOut: so.status(), meAfter: (await S.admin.get('/api/me')).status() };
S.receipt.cleanup.signOut = out;
S.receipt.finishedAt = new Date().toISOString();
return out;
