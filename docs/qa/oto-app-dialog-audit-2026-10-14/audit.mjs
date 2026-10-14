// Read-only dialog layout audit: opens dialogs, measures, screenshots, cancels.
// Every non-GET /api/ request is ABORTED so nothing can be created on staging.
import { launch } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/evidence.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const D = 'C:/Users/waqar/AppData/Local/Temp/claude/c--Users-waqar-OneDrive-Desktop-Projects-oto-pos/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/dialog-audit';
const SH = `${D}/shots`; mkdirSync(SH, { recursive: true });
const APP = 'https://oto-app-staging.onrender.com';
const only = process.argv[2] ? process.argv[2].split(',') : null;
const VPS = (process.argv[3] || '1920x1080,1280x800').split(',').map(s => { const [w, h] = s.split('x').map(Number); return { w, h, tag: s }; });

const tid = (app, id) => app.getByTestId(id);
const first = (app, sel) => app.locator(sel).first();
async function pickBranch(app) {
  const ab = app.getByText('All Branches').first();
  if (await ab.count()) { await ab.click(); await app.waitForTimeout(800); const cf = app.getByText('Central Floresta').first(); if (await cf.count()) { await cf.click(); await app.waitForTimeout(4000); } }
}
async function employeeWith(app, wantLogin) {
  const list = await app.evaluate(async () => { const r = await fetch('/api/employees', { credentials: 'include' }); return r.ok ? r.json() : []; });
  const arr = Array.isArray(list) ? list : (list.employees || list.data || []);
  const e = arr.find(x => wantLogin ? (x.userId || x.user || x.hasLogin) : !(x.userId || x.user || x.hasLogin));
  return e?.id;
}
async function empAccess(a, btn) {
  const list = await a.evaluate(async () => { const r = await fetch('/api/employees', { credentials: 'include' }); return r.ok ? r.json() : []; });
  const arr = (Array.isArray(list) ? list : (list.employees || list.data || [])).slice(0, 25);
  for (const e of arr) {
    await a.goto(`${APP}/employees/${e.id}`); await a.waitForTimeout(5000);
    const card = a.getByTestId('collapsible-access-login'); if (!(await card.count())) continue;
    await card.scrollIntoViewIfNeeded(); await card.locator('button, [data-state]').first().click().catch(() => {}); await a.waitForTimeout(800);
    const b = a.getByTestId(btn); if (await b.count()) { console.log('  employee', e.id); await b.scrollIntoViewIfNeeded(); await b.click(); return; }
  }
  throw new Error('no employee with ' + btn);
}
const CASES = {
  'enable-login2': { path: '/employees', open: a => empAccess(a, 'button-enable-login') },
  'edit-access2': { path: '/employees', open: a => empAccess(a, 'button-edit-access') },
  'add-advisor': { path: '/advisors', open: async a => tid(a, 'button-add-advisor').click() },
  'advisor-access': { path: '/advisors', open: async a => { await first(a, '[data-testid^="button-advisor-menu-"]').click(); await a.waitForTimeout(500); await tid(a, 'menu-manage-access').click(); } },
  'add-shift': { path: '/scheduling', open: async a => { await pickBranch(a); await tid(a, 'button-view-shifts').click(); await a.waitForTimeout(3000); const p = first(a, '[data-testid^="button-add-shift-row-group-"]'); await p.scrollIntoViewIfNeeded(); await p.click(); } },
  'edit-shift': { path: '/scheduling', open: async a => { await pickBranch(a); await tid(a, 'button-view-shifts').click(); await a.waitForTimeout(3000); const p = first(a, '[data-testid^="button-edit-shift-row-"]'); await p.scrollIntoViewIfNeeded(); await p.click(); } },
  'checklist-quick-create': { path: '/ops', open: async a => { await tid(a, 'tab-ops-checklists').click(); await a.waitForTimeout(1500); await tid(a, 'button-ops-new').click(); } },
  'ops-quick-task': { path: '/ops', open: async a => tid(a, 'button-ops-quick-task').click() },
  'ops-announcement': { path: '/ops', open: async a => { await tid(a, 'tab-ops-announcements').click(); await a.waitForTimeout(1500); await tid(a, 'button-ops-new').click(); } },
  'enable-login': { path: '/employees', open: async a => { const id = await employeeWith(a, false); console.log('  emp(no login)', id); await a.goto(`${APP}/employees/${id}`); await a.waitForTimeout(6000); await tid(a, 'button-enable-login').click(); } },
  'edit-access': { path: '/employees', open: async a => { const id = await employeeWith(a, true); console.log('  emp(login)', id); await a.goto(`${APP}/employees/${id}`); await a.waitForTimeout(6000); await tid(a, 'button-edit-access').click(); } },
  'offboarding': { path: '/employees', open: async a => { const id = await employeeWith(a, true); await a.goto(`${APP}/employees/${id}`); await a.waitForTimeout(6000); await first(a, '[data-testid="button-offboard-employee"]').click(); } },
  'update-terms': { path: '/employees', open: async a => { const id = await employeeWith(a, true); await a.goto(`${APP}/employees/${id}`); await a.waitForTimeout(6000); await first(a, '[data-testid="button-update-terms"]').click(); } },
  'issue-warning': { path: '/employees', open: async a => { const id = await employeeWith(a, true); await a.goto(`${APP}/employees/${id}`); await a.waitForTimeout(6000); await first(a, '[data-testid="button-issue-warning"]').click(); } },
  'payroll-period': { path: '/payroll/periods', open: async a => tid(a, 'button-create-period').click() },
  'payroll-statutory': { path: '/payroll/statutory-rules', open: async a => tid(a, 'button-create-rule').click() },
  'event-birthday': { path: '/studio/events/list', open: async a => { await tid(a, 'button-create-event').click(); await a.waitForTimeout(800); await tid(a, 'button-create-birthday').click(); } },
  'event-camp': { path: '/studio/events/list', open: async a => { await tid(a, 'button-create-event').click(); await a.waitForTimeout(800); await tid(a, 'button-create-camp').click(); } },
  'data-admin-delete': { path: '/data', open: async a => { await a.waitForTimeout(2000); const lk = first(a, 'a[href="/data/branches"]'); console.log('  model link', await lk.getAttribute('href')); await lk.click(); await a.waitForTimeout(4000); await a.getByText('Demo Branch 2').first().click(); await a.waitForTimeout(4000); await a.getByRole('button', { name: /^Delete$/ }).first().click(); } },
  'org-vacant': { path: '/org-chart', open: async a => first(a, '[data-testid="button-add-vacant"]').click() },
  'time-override': { path: '/time-attendance', open: async a => tid(a, 'button-add-override').click() },
  'create-user': { path: '/users', open: async a => tid(a, 'button-create-user').click() },
  'casual-worker': { path: '/employees/casual', open: async a => first(a, '[data-testid="button-add-casual-worker"], [data-testid="button-add-first-casual"]').click() },
  'studio-task': { path: '/studio/tasks/recurring', open: async a => tid(a, 'button-create-scheduled-task').click() },
  'studio-checklist-create': { path: '/studio/checklists?create=true', open: async a => { await a.waitForTimeout(2000); } },
  'leave-policy': { path: '/policies', open: async a => { const t = a.getByRole('tab', { name: /leave/i }).first(); if (await t.count()) { await t.click(); await a.waitForTimeout(1500); } await tid(a, 'button-add-leave-policy').click(); } },
};

async function measure(app, vh) {
  return app.evaluate(() => {
    const ds = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(e => e.getBoundingClientRect().height > 0);
    const d = ds[ds.length - 1]; if (!d) return { none: true };
    const r = d.getBoundingClientRect(); const cs = getComputedStyle(d);
    const desc = e => ({ tag: e.tagName.toLowerCase(), tid: e.getAttribute('data-testid') || undefined, cls: (e.getAttribute('class') || '').slice(0, 110), txt: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 60) });
    const all = [d, ...d.querySelectorAll('*')];
    const title = d.querySelector('h2, [id$="-title"]');
    const btns = [...d.querySelectorAll('button')].filter(b => /cancel|save|create|add|submit|confirm|done|close|next|continue|delete/i.test(b.innerText) && b.innerText.trim() && !/absolute/.test(b.className));
    const foot = btns[btns.length - 1];
    const scrollers = all.filter(e => { const s = getComputedStyle(e); return (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) || (/(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1); })
      .map(e => { const s = getComputedStyle(e); return { ...desc(e), txt: undefined, v: /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1, h: /(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1, sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, holdsTitle: !!title && e.contains(title), holdsFooter: !!foot && e.contains(foot) }; });
    // widest overflowers relative to the scroll container they live in
    const over = [];
    for (const sc of all.filter(e => e.scrollWidth > e.clientWidth + 1 && /(auto|scroll|hidden)/.test(getComputedStyle(e).overflowX))) {
      const sr = sc.getBoundingClientRect(); const right = sr.left + sc.clientWidth;
      for (const e of sc.querySelectorAll('*')) { const er = e.getBoundingClientRect(); const p = e.parentElement; const pr = p === sc ? right : p.getBoundingClientRect().right; if (er.width && er.right > right + 1 && pr <= right + 1) over.push({ in: (sc.getAttribute('class') || '').slice(0, 40), by: Math.round(er.right - right), w: Math.round(er.width), ...desc(e) }); }
    }
    over.sort((a, b) => b.by - a.by); // outermost elements that cross the edge
    return {
      box: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }, vh: innerHeight, vw: innerWidth,
      clipped: r.top < -1 || r.bottom > innerHeight + 1, natural: d.scrollHeight, overflowY: cs.overflowY, maxH: cs.maxHeight, display: cs.display,
      titleBox: title ? Math.round(title.getBoundingClientRect().top) : null, footer: foot ? { txt: foot.innerText.trim(), bottom: Math.round(foot.getBoundingClientRect().bottom) } : null,
      scrollers, overflowers: over.slice(0, 4), pageScrollY: scrollY,
    };
  });
}

const browser = await launch();
const results = {};
for (const vp of VPS) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, storageState: `${D}/state.json` });
  await ctx.route('**/api/**', route => { const m = route.request().method(); if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') { console.log('  BLOCKED', m, route.request().url()); return route.abort(); } return route.continue(); });
  for (const [name, c] of Object.entries(CASES)) {
    if (only && !only.includes(name)) continue;
    const app = await ctx.newPage(); app.on('dialog', d => d.dismiss());
    const key = `${name}@${vp.tag}`;
    try {
      await app.goto(APP + c.path, { waitUntil: 'domcontentloaded', timeout: 120000 }); await app.waitForTimeout(6000);
      await c.open(app); await app.waitForTimeout(1800);
      const m = await measure(app, vp.h); results[key] = m;
      await app.screenshot({ path: `${SH}/da-${name}-${vp.tag}.png` });
      const sv = (m.scrollers || []).map(s => `${s.v ? 'V' : ''}${s.h ? 'H' : ''}[${s.sh}/${s.ch}${s.h ? ` w${s.sw}/${s.cw}` : ''}${s.holdsTitle ? ' +title' : ''}${s.holdsFooter ? ' +footer' : ''}] ${s.cls.slice(0, 50)}`).join(' || ');
      console.log(`${key}: ${m.none ? 'NO DIALOG' : `box ${m.box.w}x${m.box.h} top${m.box.top} bot${m.box.bottom} clipped=${m.clipped} natural=${m.natural} ovY=${m.overflowY} maxH=${m.maxH} footer=${JSON.stringify(m.footer)}`}\n   scrollers: ${sv || '-'}`);
      for (const o of m.overflowers || []) console.log(`   OVERFLOW by ${o.by}px w${o.w} <${o.tag}> ${o.tid || ''} "${o.txt}" cls=${o.cls}`);
      await app.keyboard.press('Escape'); await app.waitForTimeout(400);
    } catch (e) { console.log(`${key}: ERR ${e.message.split('\n')[0]}`); await app.screenshot({ path: `${SH}/err-${name}-${vp.tag}.png` }).catch(() => {}); results[key] = { err: e.message.split('\n')[0] }; }
    await app.close();
  }
  await ctx.close();
}
writeFileSync(`${D}/results-${Date.now()}.json`, JSON.stringify(results, null, 1));
await browser.close();
