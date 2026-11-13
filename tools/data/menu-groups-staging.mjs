// STAGING ONLY. Groups the F&B menu's categories under three top-level tabs,
// as the park's tester marked them on 13 November 2026 (with the owner's
// correction: Soup goes under Special):
//
//   Food    : Breakfast, Sides, Sharing, Salads, Pasta, Pizza, Mains,
//             Asian Food, Kids, Desserts
//   Drinks  : Coffee, Iced Coffee, Chocolate, Soda, Smoothies, Juice, Tea pot,
//             Soft drinks, Kids juice, Wine, Beer, Free Drinks Menu
//   Special : Specials, Soup
//
// It changes only which tab a category sits under (its parent). Items stay in
// their categories; a category's own tax area, printing station, order and
// code are not touched. The till already draws a parent as a top tab and its
// sub-categories under it (apps/pos/src/components/fnb/MenuGrid.tsx), so this
// is a change of records, made through the platform's own routes as the
// staging admin: no database is touched directly.
//
//   node tools/data/menu-groups-staging.mjs            says what it would do
//   node tools/data/menu-groups-staging.mjs --apply    does it
//
// Credentials are read by NAME from the repo-root .env and never printed.
import { randomUUID } from 'node:crypto';
import { need } from '../../scripts/agent/env.mjs';

const API = 'https://oto-api-staging.onrender.com';
if (!/-staging\.onrender\.com$/.test(new URL(API).host)) throw new Error('staging only');
const APPLY = process.argv.includes('--apply');

const GROUPS = {
  FOOD: ['CAT-BREAKFAST', 'CAT-SIDES', 'CAT-SHARING', 'CAT-SALADS', 'CAT-PASTA', 'CAT-PIZZA', 'CAT-MAINS', 'CAT-ASIAN-FOOD', 'CAT-KIDS', 'CAT-DESSERTS'],
  DRINKS: ['CAT-COFFEE', 'CAT-ICED-COFFEE', 'CAT-CHOCOLATE', 'CAT-SODA', 'CAT-SMOOTHIES', 'CAT-JUICE', 'CAT-TEA-POT', 'CAT-SOFT-DRINKS', 'CAT-KIDS-JUICE', 'CAT-WINE', 'CAT-BEER', 'CAT-FREE-DRINKS'],
  SPECIAL: ['CAT-SPECIALS', 'CAT-SOUP'],
};

let cookie = '';
async function call(method, path, body) {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

/** The live categories, and how many live items each holds across the parks. */
async function readAll() {
  const answer = (await call('GET', '/branches')).json;
  const parks = (answer?.branches ?? answer ?? []).filter((b) => !b.archivedAt);
  let cats = null;
  const count = {};
  for (const park of parks) {
    const menu = await call('GET', `/branches/${park.id}/menu`);
    if (menu.status !== 200) throw new Error(`the menu of ${park.name} answered ${menu.status}`);
    cats ??= menu.json.categories;
    for (const p of (menu.json.products ?? []).filter((x) => !x.archivedAt)) count[p.categoryId] = (count[p.categoryId] ?? 0) + 1;
  }
  return { cats: cats.filter((c) => !c.archivedAt), count };
}

const say = (...a) => console.log(...a);
const signIn = await call('POST', '/auth/sign-in', { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') });
if (signIn.status !== 200) throw new Error(`sign-in refused: ${signIn.status}`);
const done = { applied: APPLY, created: [], moved: [], withdrawn: [], skipped: [] };
try {
  let { cats, count } = await readAll();
  const byCode = (code) => cats.find((c) => c.code === code);
  const top = { FOOD: byCode('FOOD'), DRINKS: byCode('DRINKS'), SPECIAL: byCode('SPECIAL') };
  for (const k of ['FOOD', 'DRINKS']) {
    if (!top[k] || top[k].parentId) throw new Error(`the top-level ${k} category is not there as expected`);
  }
  if (!top.SPECIAL) {
    say('create  Special (a top-level tab after Drinks; tax area fnb, prints at the kitchen)');
    if (APPLY) {
      const r = await call('POST', '/menu/categories', { code: 'SPECIAL', name: 'Special', taxableCategory: 'fnb', defaultPrepStation: 'kitchen', sortOrder: 2 });
      if (r.status !== 200) throw new Error(`create Special refused: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
      ({ cats, count } = await readAll());
      top.SPECIAL = cats.find((c) => c.code === 'SPECIAL');
      done.created.push({ id: top.SPECIAL.id, name: 'Special' });
    }
  }
  const movedNames = { FOOD: new Set(), DRINKS: new Set(), SPECIAL: new Set() };
  for (const [group, codes] of Object.entries(GROUPS)) {
    const tabName = group === 'SPECIAL' ? 'Special' : top[group].name;
    for (const code of codes) {
      const c = byCode(code);
      if (!c) { say(`skip    ${code}: no such category`); done.skipped.push({ code, why: 'not found' }); continue; }
      movedNames[group].add(c.name.toLowerCase());
      if (top[group] && c.parentId === top[group].id) { say(`already ${c.name} is under ${tabName}`); continue; }
      if (c.parentId) { say(`skip    ${c.name}: it already sits under another tab`); done.skipped.push({ code, why: 'has another parent' }); continue; }
      if (cats.some((x) => x.parentId === c.id)) { say(`skip    ${c.name}: it has sub-categories of its own`); done.skipped.push({ code, why: 'has sub-categories' }); continue; }
      say(`move    ${c.name.padEnd(18)} -> ${tabName}   (${count[c.id] ?? 0} items stay in it; tax ${c.taxableCategory}, prints at ${c.defaultPrepStation}, order ${c.sortOrder}: unchanged)`);
      if (APPLY) {
        const r = await call('PATCH', `/menu/categories/${c.id}`, { parentId: top[group].id, sortOrder: c.sortOrder });
        if (r.status !== 200) throw new Error(`move ${c.name} refused: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
        done.moved.push({ id: c.id, name: c.name, to: tabName });
      }
    }
  }
  // An EMPTY sub-category with no code and the name of one just moved (made
  // by hand in the Console for the same purpose) would show twice there.
  for (const group of ['FOOD', 'DRINKS', 'SPECIAL']) {
    if (!top[group]) continue;
    for (const c of cats.filter((x) => x.parentId === top[group].id && !x.code && movedNames[group].has(x.name.toLowerCase()))) {
      if ((count[c.id] ?? 0) > 0) { say(`leave   "${c.name}" made by hand under ${top[group].name}: it holds ${count[c.id]} items`); done.skipped.push({ id: c.id, name: c.name, why: 'hand-made, holds items' }); continue; }
      say(`withdraw the empty duplicate "${c.name}" made by hand under ${top[group].name} (0 items)`);
      if (APPLY) {
        const r = await call('DELETE', `/menu/categories/${c.id}`);
        if (r.status !== 200 && r.status !== 204) { say(`  not withdrawn: ${r.status}`); done.skipped.push({ id: c.id, name: c.name, why: `withdraw refused ${r.status}` }); }
        else done.withdrawn.push({ id: c.id, name: c.name, under: top[group].name });
      }
    }
  }
  if (!APPLY) {
    say('\n(nothing was changed: run with --apply)');
  } else {
    ({ cats, count } = await readAll());
    say('\nAFTER, as the platform now reads it:');
    for (const t of cats.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder)) {
      const subs = cats.filter((c) => c.parentId === t.id).sort((a, b) => a.sortOrder - b.sortOrder);
      const total = (count[t.id] ?? 0) + subs.reduce((n, s) => n + (count[s.id] ?? 0), 0);
      say(`${t.name}  (${total} items)`);
      for (const s of subs) say(`   ${s.name.padEnd(20)} ${String(count[s.id] ?? 0).padStart(3)} items`);
    }
    say('\nThe way back: set the parent of each moved category to none (PATCH /menu/categories/:id with parentId null).');
    say(JSON.stringify(done));
  }
} finally {
  await call('POST', '/auth/sign-out');
}
