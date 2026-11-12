S.phase = "12: the receipt printout's staff name and band codes blacked out (boxes drawn over the printer's own preview)";
// S.maskPng(file, boxes): draws solid boxes [x, y, w, h] over a PNG in the proof folder, in place.
S.maskPng = async (name, boxes) => {
  const file = S.resolve(S.out, name);
  const b64 = S.readFileSync(file).toString('base64');
  const ctx = await S.browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  await page.setContent(`<html><body style="margin:0"><div id="w" style="position:relative;display:inline-block"><img id="i" src="data:image/png;base64,${b64}" style="display:block">${boxes.map(([x, y, w, h]) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:#18181b"></div>`).join('')}</div></body></html>`);
  await page.waitForFunction(() => document.getElementById('i').complete);
  const size = await page.evaluate(() => { const i = document.getElementById('i'); return { w: i.naturalWidth, h: i.naturalHeight }; });
  await page.setViewportSize({ width: Math.max(size.w, 100), height: Math.max(size.h, 100) });
  await page.locator('#w').screenshot({ path: file });
  await ctx.close();
  return size;
};
const size = await S.maskPng('12e-receipt-printout-1.png', [[90, 250, 300, 32], [0, 1424, 330, 96]]);
// the second "printout" is an empty one (height 0): not kept
try { (await import('node:fs')).unlinkSync(S.resolve(S.out, '12e-receipt-printout-2.png')); } catch { /* ignore */ }
return size;
