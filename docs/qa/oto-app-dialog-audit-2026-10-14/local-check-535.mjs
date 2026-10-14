// Usage: from apps/oto-app run `npx vite --port 5179`, then `node local-check-535.mjs [cases|all] [WxH,...]`.
// Local layout check for SCRUM-535: the client from the lane worktree served by
// vite, every /api call answered from a small in-memory fixture (no server, no
// database, nothing leaves the machine). Measures dialogs the way the audit's
// checker does and adds a pinned-header/footer test after scrolling the body.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire('C:/w/ben/apps/pos/package.json');
const { chromium } = require('@playwright/test');

const D = 'C:/Users/waqar/AppData/Local/Temp/claude/c--Users-waqar-OneDrive-Desktop-Projects-oto-pos/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/local-dialogs';
const SH = `${D}/shots`; mkdirSync(SH, { recursive: true });
const APP = process.env.APP || 'http://localhost:5179';
const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const VPS = (process.argv[3] || '1920x1080,1280x800').split(',').map(s => { const [w, h] = s.split('x').map(Number); return { w, h, tag: s }; });

const now = new Date().toISOString();
const modules = { core: true, ops: true, hr: true, studio: true, events: true, setup: true };
const branches = [
  { id: 'b1', name: 'Oto Play Park, Central Floresta', operatorId: 'op1', isActive: true, timezone: 'Asia/Bangkok', address: '199 Moo 4, Vichitsongkram Road, Wichit, Muang, Phuket 83000, Thailand', createdAt: now },
  { id: 'b2', name: 'Oto Play Park, Robinson Chalong', operatorId: 'op1', isActive: true, timezone: 'Asia/Bangkok', address: '10/53 Moo 1, Chaofah East Road, Tambon Chalong, Mueang Phuket District, Phuket 83130, Thailand', createdAt: now },
  { id: 'b3', name: 'Head Office', operatorId: 'op1', isActive: true, timezone: 'Asia/Bangkok', address: '41/31 Moo 5, Kamala, Kathu, Phuket 83150, Thailand', createdAt: now },
  { id: 'b4', name: 'HKT Central', operatorId: 'op1', isActive: true, timezone: 'Asia/Bangkok', address: 'Central Phuket Floresta, Wichit, Mueang Phuket', createdAt: now },
];
const departments = ['Reception', 'Restaurant', 'Floor', 'Nanny', 'Kitchen', 'Management'].map((n, i) => ({ id: `d${i + 1}`, name: n, isActive: true, branchId: 'b1', operatorId: 'op1' }));
const roles = ['Reception', 'Cashier', 'Floor Staff', 'Nanny', 'Cook', 'Server', 'Supervisor', 'Branch Manager', 'Cleaner', 'Party Host'].map((n, i) => ({ id: `r${i + 1}`, name: n, isActive: true, departmentId: departments[i % 6].id }));
const user = { id: 'u1', allowedBranchIds: [], role: 'admin', fullName: 'Local Admin', email: 'admin@example.com', isActive: true, mustChangePassword: false, phoneVerified: true, phoneNumber: '+66812345678', modules, operatorId: 'op1', accessScope: 'all_branches', branchAccess: branches.map(b => ({ branchId: b.id, branch: b })), branchIds: branches.map(b => b.id), createdAt: now };
const emp = (i) => ({ id: `e${i}`, personId: i === 1 ? 'p1' : null, employeeId: `E00${i}`, fullName: `Employee Number ${i}`, nickname: `Emp${i}`, preferredName: `Emp${i}`, email: `e${i}@example.com`, phoneNumber: '+6681000000' + i, status: 'active', employmentStatus: 'active', isActive: true, branchId: 'b1', departmentId: 'd1', roleId: 'r1', userId: i === 1 ? 'u2' : null, user: i === 1 ? { id: 'u2', role: 'staff', accessLevel: 'STAFF', isActive: true, modules, branchScope: 'ALL' } : null, hasLogin: i === 1, startDate: '2026-01-01', employmentType: 'full_time', branch: branches[0], department: departments[0], role: roles[0], createdAt: now, updatedAt: now });
const employees = [1, 2, 3, 4, 5].map(emp);

function fixture(path) {
  if (path === '/api/user' || path === '/api/me') return user;
  if (path === '/api/branches' || path.startsWith('/api/branches?')) return branches;
  if (path.startsWith('/api/departments')) return departments;
  if (path.startsWith('/api/roles')) return roles;
  if (path.startsWith('/api/activity-logs')) return { logs: [] };
  if (path === '/api/data-admin/models') return [{ name: 'Branch', plural: 'Branches', slug: 'branches', description: 'A physical location or site belonging to an operator, with its own timezone, address, and Google Drive integration.', priority: 1, count: 4, searchFields: ['name'], filters: [], formFields: [], defaultOrderBy: 'name',
    listDisplay: [{ key: 'name', label: 'Name' }, { key: 'address', label: 'Address' }, { key: 'timezone', label: 'Timezone' }, { key: 'operatorId', label: 'Operator', relatedModel: 'operators' }, { key: 'createdAt', label: 'Created At', type: 'date' }] }];
  if (path.startsWith('/api/data-admin/branches')) return { rows: branches.map(b => ({ ...b, operatorId_label: 'Oto' })), total: branches.length, page: 1, pageSize: 25 };
  if (path.startsWith('/api/schedule/week?') || path === '/api/schedule/week') return {
    id: 'wp1', branchId: 'b1', weekStartDate: '2026-10-12', name: null,
    shiftGroups: [{ id: 'g1', name: 'Front of House', sortOrder: 0, branchId: 'b1' }],
    shiftRows: [{ id: 'sr1', branchId: 'b1', departmentId: 'd1', weekPlanId: 'wp1', rowOrder: 0, label: 'Morning', startTime: '09:00', endTime: '18:00', note: null, staffRequired: 2, staffRequiredByDay: {}, colorIndex: 1, shiftGroupId: 'g1', sortOrderWithinGroup: 0, department: departments[0], roles: [{ roleId: 'r1', role: roles[0] }], assignments: [], breaks: [] }],
  };
  if (path.startsWith('/api/permissions/effective')) return { userId: 'u2', role: 'manager', modules: [] };
  if (path === '/api/people/p1') return { id: 'p1', accessPolicy: { accessLevel: 'MANAGER', modules, branchScope: 'SELECTED', branchIds: ['b1', 'b2'] } };
  if (path === '/api/operators') return [{ id: 'op1', name: 'Oto', isActive: true }];
  if (/^\/api\/employees\/e\d+$/.test(path)) return employees[0];
  if (path === '/api/employees' || path.startsWith('/api/employees?')) return employees;
  if (path.startsWith('/api/users')) return [user];
  return null; // fall through to the generic answer
}

const tid = (a, id) => a.getByTestId(id);
const first = (a, sel) => a.locator(sel).first();
async function click(a, id) { const b = tid(a, id); await b.scrollIntoViewIfNeeded(); await b.click(); }
const CASES = {
  'add-advisor': { path: '/advisors', open: a => click(a, 'button-add-advisor') },
  'add-advisor-login': { path: '/advisors', open: async a => { await click(a, 'button-add-advisor'); await a.waitForTimeout(400); const cb = tid(a, 'checkbox-create-login'); if ((await cb.getAttribute('data-state')) !== 'checked') await cb.click(); await a.waitForTimeout(300); await tid(a, 'select-branch-scope-create').click(); await a.getByRole('option', { name: 'Selected Branches' }).click(); } },
  'create-user': { path: '/users', open: async a => { await click(a, 'button-create-user'); await a.waitForTimeout(400); await tid(a, 'select-user-role').click(); await a.getByRole('option', { name: 'Staff' }).click(); await a.waitForTimeout(200); await tid(a, 'select-access-scope').click(); await a.getByRole('option', { name: 'Selected Branches' }).click(); } },
  'checklist-quick-create': { path: '/ops', open: async a => { await click(a, 'tab-ops-checklists'); await a.waitForTimeout(1200); await click(a, 'button-ops-new'); } },
  'studio-checklist-create': { path: '/studio/checklists?create=true', open: async a => { await a.waitForTimeout(1500); } },
  'payroll-statutory': { path: '/payroll/statutory-rules', open: a => click(a, 'button-create-rule') },
  'studio-task': { path: '/studio/tasks/recurring', open: a => click(a, 'button-create-scheduled-task') },
  'casual-worker': { path: '/employees/casual', open: a => first(a, '[data-testid="button-add-casual-worker"], [data-testid="button-add-first-casual"]').click() },
  'offboarding': { path: '/employees/e1', open: a => first(a, '[data-testid="button-offboard-employee"]').click() },
  'issue-warning': { path: '/employees/e1', open: a => first(a, '[data-testid="button-issue-warning"]').click() },
  'edit-access': { path: '/employees/e1', open: async a => { const card = tid(a, 'collapsible-access-login'); if (await card.count()) { await card.scrollIntoViewIfNeeded(); await card.locator('button, [data-state]').first().click().catch(() => {}); await a.waitForTimeout(600); } await click(a, 'button-edit-access'); } },
  'add-shift': { path: '/scheduling', open: async a => { await click(a, 'button-view-shifts'); await a.waitForTimeout(2500); const p = first(a, '[data-testid^="button-add-shift-row-group-"]'); await p.scrollIntoViewIfNeeded(); await p.click(); } },
  'edit-shift': { path: '/scheduling', open: async a => { await click(a, 'button-view-shifts'); await a.waitForTimeout(2500); const p = first(a, '[data-testid^="button-edit-shift-row-"]'); await p.scrollIntoViewIfNeeded(); await p.click(); } },
  // short reference dialogs (class B-ok): must look unchanged
  'ops-quick-task': { path: '/ops', open: a => click(a, 'button-ops-quick-task') },
  'payroll-period': { path: '/payroll/periods', open: a => click(a, 'button-create-period') },
  'time-override': { path: '/time-attendance', open: a => click(a, 'button-add-override') },
  'data-branches': { path: '/data/branches', open: async () => {}, page: true },
};

async function measure(app) {
  return app.evaluate(() => {
    const ds = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(e => e.getBoundingClientRect().height > 0);
    const d = ds[ds.length - 1]; if (!d) return { none: true };
    const r = d.getBoundingClientRect(); const cs = getComputedStyle(d);
    const all = [d, ...d.querySelectorAll('*')];
    const title = d.querySelector('h2, [id$="-title"]');
    const btns = [...d.querySelectorAll('button')].filter(b => /cancel|save|create|add|submit|confirm|done|close|next|continue|delete|update/i.test(b.innerText) && b.innerText.trim() && !/absolute/.test(b.className));
    const foot = btns[btns.length - 1];
    const scrollers = all.filter(e => { const s = getComputedStyle(e); return (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) || (/(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1); })
      .map(e => { const s = getComputedStyle(e); return { cls: (e.getAttribute('class') || '').slice(0, 60), v: /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1, h: /(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1, sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, holdsTitle: !!title && e.contains(title), holdsFooter: !!foot && e.contains(foot), isCard: e === d }; });
    const hidden = all.filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'hidden' && e.clientWidth > 100).map(e => ({ cls: (e.getAttribute('class') || '').slice(0, 50), by: e.scrollWidth - e.clientWidth }));
    return {
      box: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }, vh: innerHeight,
      clipped: r.top < -1 || r.bottom > innerHeight + 1, natural: d.scrollHeight, maxH: cs.maxHeight,
      titleTop: title ? Math.round(title.getBoundingClientRect().top) : null, footer: foot ? { txt: foot.innerText.trim(), bottom: Math.round(foot.getBoundingClientRect().bottom) } : null,
      scrollers, hiddenOverflow: hidden, pageScroll: document.scrollingElement.scrollHeight > innerHeight + 1 && getComputedStyle(document.body).overflow !== 'hidden',
    };
  });
}
// Scroll every vertical scroller inside the dialog to the bottom, then report where title and footer sit.
async function scrollTest(app) {
  return app.evaluate(() => {
    const ds = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(e => e.getBoundingClientRect().height > 0);
    const d = ds[ds.length - 1]; if (!d) return null;
    const title = d.querySelector('h2, [id$="-title"]');
    const btns = [...d.querySelectorAll("button")].filter(b => /cancel|save|create|add|submit|confirm|done|close|next|continue|delete|update/i.test(b.innerText) && b.innerText.trim() && !/absolute/.test(b.className));
    const foot = btns[btns.length - 1];
    const before = { t: title?.getBoundingClientRect().top, f: foot?.getBoundingClientRect().bottom };
    for (const e of [d, ...d.querySelectorAll('*')]) if (e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight;
    const after = { t: title?.getBoundingClientRect().top, f: foot?.getBoundingClientRect().bottom };
    return { titleMoved: Math.round((after.t ?? 0) - (before.t ?? 0)), footerMoved: Math.round((after.f ?? 0) - (before.f ?? 0)), footerBottom: Math.round(after.f ?? -1), vh: innerHeight };
  });
}

const browser = await chromium.launch();
const results = {};
for (const vp of VPS) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.addInitScript(() => { try { localStorage.setItem('oto_active_branch_id', 'b1'); } catch {} });
  await ctx.route('**/api/**', route => {
    const u = new URL(route.request().url()); const p = u.pathname + (u.search || '');
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    let body = fixture(u.pathname) ?? fixture(p);
    if (body === null && u.pathname.startsWith('/api/employees/e1/') && !/(changes|letters|assets|documents|contracts|roles|cost-allocations)$/.test(u.pathname)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not found"}' });
    if (body === null) body = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  for (const [name, c] of Object.entries(CASES)) {
    if (only && !only.includes(name)) continue;
    const app = await ctx.newPage(); const errs = [];
    app.on('pageerror', e => errs.push((e.stack || e.message).split(String.fromCharCode(10)).slice(0, 3).join(' ').slice(0, 300)));
    const key = `${name}@${vp.tag}`;
    try {
      await app.goto(APP + c.path, { waitUntil: 'domcontentloaded' }); await app.waitForTimeout(3500);
      await c.open(app); await app.waitForTimeout(1200);
      if (c.page) { await app.screenshot({ path: `${SH}/${name}-${vp.tag}.png` }); console.log(`${key}: page shot`); await app.close(); continue; }
      const m = await measure(app); await app.screenshot({ path: `${SH}/${name}-${vp.tag}.png` });
      const st = m.none ? null : await scrollTest(app);
      if (st && (st.titleMoved || st.footerMoved)) await app.screenshot({ path: `${SH}/${name}-${vp.tag}-scrolled.png` });
      results[key] = { ...m, scroll: st };
      const sv = (m.scrollers || []).map(s => `${s.v ? 'V' : ''}${s.h ? 'H' : ''}[${s.sh}/${s.ch}${s.h ? ` w${s.sw}/${s.cw}` : ''}${s.isCard ? ' CARD' : ''}${s.holdsTitle ? ' +title' : ''}${s.holdsFooter ? ' +footer' : ''}] ${s.cls.slice(0, 45)}`).join(' || ');
      console.log(`${key}: ${m.none ? 'NO DIALOG' : `box ${m.box.w}x${m.box.h} top${m.box.top} bot${m.box.bottom} clipped=${m.clipped} natural=${m.natural} maxH=${m.maxH} footer=${JSON.stringify(m.footer)}`}`);
      if (!m.none) console.log(`   scrollers: ${sv || 'none'}${m.hiddenOverflow.length ? `  hiddenOverflow: ${JSON.stringify(m.hiddenOverflow)}` : ''}${st ? `  afterScroll: title moved ${st.titleMoved}, footer moved ${st.footerMoved}, footer bottom ${st.footerBottom}/${st.vh}` : ''}`);
    } catch (e) { console.log(`${key}: ERR ${e.message.split('\n')[0]}`); await app.screenshot({ path: `${SH}/err-${name}-${vp.tag}.png` }).catch(() => {}); results[key] = { err: e.message.split('\n')[0] }; }
    if (errs.length) console.log(`   pageerrors: ${errs.slice(0, 3).join(' | ')}`);
    await app.close();
  }
  await ctx.close();
}
writeFileSync(`${D}/results-${Date.now()}.json`, JSON.stringify(results, null, 1));
await browser.close();
