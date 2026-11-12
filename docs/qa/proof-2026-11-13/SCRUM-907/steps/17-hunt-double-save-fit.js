S.phase = '(hunt) a double press of Save adding a typed line on party 2; what is cut in the Edit form at 1440 x 900';
const pg = S.pages.mgr.page;
await S.unlock('mgr');
await S.openParty(pg, S.p2, S.P2);
const r = {};
await pg.getByRole('button', { name: 'Edit party', exact: true }).first().click();
await pg.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
const kc = S.cardOf(pg, 'Kitchen plan');
await kc.getByRole('button', { name: /Add item/ }).first().waitFor({ timeout: 30000 });
await kc.getByRole('button', { name: /Add item/ }).first().click();
const nf = kc.getByRole('textbox', { name: 'New food item', exact: true }).last();
await nf.fill('ZZ TEST double press dish');
await nf.press('Tab');
await S.unlock('mgr');
const puts = [];
const onResp = x => { if (/\/api\/parties\/[^/]+\/kitchen-plan$/.test(new URL(x.url()).pathname) && x.request().method() === 'PUT') puts.push(x.status()); };
pg.on('response', onResp);
await pg.getByRole('button', { name: 'Save changes', exact: true }).dblclick();
await pg.waitForTimeout(8000);
pg.off('response', onResp);
r.putsAnswered = puts;
const back = (await S.appCall('GET', `/events/${S.p2}/beo`)).body;
r.beoKids = (back?.kitchenPlan?.menus?.kids ?? []).map(l => `${l.itemName} x${l.quantity}`);
r.doublePressLines = r.beoKids.filter(x => /double press/.test(x)).length;
r.auditRowsParty2 = (await S.auditOf('party.kitchen_update', S.p2.toLowerCase())).length;
// the fit at 1440 x 900: party 1's Edit form as the manager sees it
await S.openParty(pg, S.p1, S.P1);
await pg.getByRole('button', { name: 'Edit party', exact: true }).first().click();
await pg.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
await S.cardOf(pg, 'Kitchen plan').getByRole('button', { name: /Add item/ }).first().waitFor({ timeout: 30000 });
await pg.waitForTimeout(1500);
r.fit = await pg.evaluate(() => {
  const out = { viewport: [innerWidth, innerHeight], pageSideways: document.documentElement.scrollWidth > innerWidth + 1, cutInputs: [], cutText: [] };
  for (const el of document.querySelectorAll('input')) { const rc = el.getBoundingClientRect(); if (!rc.width) continue; if (el.scrollWidth > el.clientWidth + 1) out.cutInputs.push({ value: el.value, shownPx: Math.round(el.clientWidth), needsPx: el.scrollWidth }); }
  for (const el of document.querySelectorAll('*')) { const cs = getComputedStyle(el); if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.innerText.trim()) out.cutText.push(el.innerText.trim().slice(0, 80)); }
  return out;
});
await pg.getByRole('button', { name: 'Cancel', exact: true }).first().click();
await pg.waitForTimeout(1000);
S.receipt.reads.hunt = r;
return r;
