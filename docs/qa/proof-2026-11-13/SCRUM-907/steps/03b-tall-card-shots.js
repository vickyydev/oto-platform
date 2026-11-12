S.phase = '2: the kitchen card pictured whole (a taller window for card pictures only; the width stays 1440)';
S.tallShot = async (page, name, element) => {
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: 2400 });
  await page.waitForTimeout(800);
  try { await element.scrollIntoViewIfNeeded().catch(() => {}); return await S.shot(page, name, [], { element }); }
  finally { await page.setViewportSize(vp); await page.waitForTimeout(400); }
};
const till = S.pages.rec.page;
await S.unlock('rec');
await S.openParty(till, S.p1, S.P1);
await S.tallShot(till, '02b-till-kitchen-plan-card.png', S.cardOf(till, 'Kitchen plan'));
return 'ok';
