S.phase = "2: the till's party page (reception, 1440 x 900) shows the plan made in the BEO";
if (!S.pages.rec) await S.signIn('rec', 'STAGING_RECEPTION_PHONE', 'STAGING_RECEPTION_PASSWORD', { width: 1440, height: 900 });
const till = S.pages.rec.page;
await S.unlock('rec');
S.cardOf = (page, title) => page.locator('div.font-bold', { hasText: new RegExp(`^${title}$`) }).first().locator('xpath=ancestor::div[contains(@class,"bg-card")][1]');
S.cardText = async (page, title) => S.flat(await S.cardOf(page, title).innerText().catch(() => ''));
S.openParty = async (page, id, title) => {
  await page.goto(`/parties?party=${id}`); await page.waitForTimeout(3500);
  if (!(await page.getByText(title).first().isVisible().catch(() => false))) { await page.goto('/parties'); await page.waitForTimeout(3000); await page.getByText(title).first().click(); await page.waitForTimeout(3000); }
  await page.locator('div.font-bold', { hasText: /^Kitchen plan$/ }).first().waitFor({ timeout: 30000 });
};
await S.openParty(till, S.p1, S.P1);
const r = { url: new URL(till.url()).pathname + new URL(till.url()).search };
r.kitchen = await S.cardText(till, 'Kitchen plan');
r.bar = await S.cardText(till, 'Bar plan');
r.buttons = [];
for (const b of await till.getByRole('button').all()) { const t = S.flat(await b.innerText().catch(() => '')); if (/Settle party|Edit party|Print party slips now|Take balance|Fully paid|Add F&B|Add tickets/.test(t) && await b.isVisible()) r.buttons.push(t); }
await till.mouse.wheel(0, -3000); await till.waitForTimeout(400);
await S.shot(till, '02a-till-party-page-reception.png');
await S.cardOf(till, 'Kitchen plan').scrollIntoViewIfNeeded();
await S.shot(till, '02b-till-kitchen-plan-card.png', [], { element: S.cardOf(till, 'Kitchen plan') });
await S.shot(till, '02c-till-bar-plan-card.png', [], { element: S.cardOf(till, 'Bar plan') });
S.receipt.reads.p2Till = r;
return r;
