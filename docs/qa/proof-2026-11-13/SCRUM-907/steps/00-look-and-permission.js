S.phase = '0: read-only look (the branch, the box, the menu) and point 1, the permission, before anything is made';
const r = {};
const branch = (await S.call('GET', '/branches')).body.branches.find(b => b.id === S.branchId);
r.branch = { name: branch.name, partySlipsStationIdAtStart: branch.partySlipsStationId ?? null };
S.receipt.foundAtStart.partySlipsStationId = branch.partySlipsStationId ?? null;
S.receipt.foundAtStart.readAt = new Date().toISOString();
if (branch.partySlipsStationId) {
  const st = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === branch.partySlipsStationId);
  S.receipt.foundAtStart.partySlipsStation = st ? { id: st.id, name: st.name, archived: !!st.archived } : 'not found';
}
const box = (await S.call('GET', `/branches/${S.branchId}/boxes`)).body.boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
r.box = box ? { slot: box.slot, status: box.status, role: box.role } : null;
S.box = box;
const ev = (await S.call('GET', `/events?branchId=${S.branchId}&type=party`)).body;
for (const e of ev?.events ?? []) if (!S.isZz(e.title)) S.hidden.push(String(e.title).trim());
r.todaysParties = { count: (ev?.events ?? []).length, zz: (ev?.events ?? []).filter(e => S.isZz(e.title)).map(e => e.title) };
const menu = (await S.call('GET', `/branches/${S.branchId}/menu`)).body;
S.menu = menu;
const live = p => p.active && !p.archivedAt && p.code && (!p.branchId || p.branchId === S.branchId);
const fmt = p => `${p.code} ${p.name} ${p.priceSatang / 100}/${(p.effectiveWeekendSatang ?? p.priceSatang) / 100} ${p.effectivePrepStation ?? '-'} kind=${p.kind}`;
r.menu = {
  calamari: menu.products.filter(p => live(p) && /calamari/i.test(p.name)).map(fmt),
  hummus: menu.products.filter(p => live(p) && /hummus/i.test(p.name)).map(fmt),
  fries: menu.products.filter(p => live(p) && /fries/i.test(p.name)).map(fmt),
  water: menu.products.filter(p => live(p) && /mineral water|^water/i.test(p.name)).map(fmt),
};
// point 1: the manager's and reception's effective permissions, each in its own api session, signed out after
const perms = {};
for (const [who, phone, pass] of [['manager', 'STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD'], ['reception', 'STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD']]) {
  const ctx = await S.pw.request.newContext({ baseURL: S.pos });
  try {
    const si = await ctx.post('/api/auth/sign-in', { data: { phone: S.need(phone), password: S.need(pass) } });
    const me = await (await ctx.get('/api/me')).json().catch(() => null);
    S.walkNames(me);
    const pr = await ctx.get('/api/me/permissions');
    const pb = await pr.json().catch(() => null);
    const list = Array.isArray(pb) ? pb : (pb?.permissions ?? pb?.effective ?? []);
    const hits = list.filter(p => (p.permission ?? p) === 'pos:party:kitchen_update');
    const roles = (me?.roles ?? me?.account?.roles ?? me?.assignments ?? []).map?.(x => x.roleName ?? x.name ?? x.role ?? x) ?? null;
    const so = await ctx.post('/api/auth/sign-out', { headers: { 'idempotency-key': S.randomUUID() } });
    const after = await ctx.get('/api/me');
    perms[who] = { signIn: si.status(), permissionsStatus: pr.status(), total: list.length, holdsKitchenUpdate: hits.length > 0, kitchenUpdateScopes: hits.map(h => ({ scopeType: h.scopeType ?? h.scope?.type ?? null, scopeIsFloresta: JSON.stringify(h).includes(S.branchId) })), partyPermissions: list.map(p => p.permission ?? p).filter(p => /^pos:party:/.test(p)).sort(), roles, signOut: so.status(), meAfter: after.status() };
  } finally { await ctx.dispose(); }
}
r.permissions = perms;
S.receipt.reads.look = r;
return r;
