S.phase = '6: the Activity Logbook line pictured with only the staff name blacked out (word mask), the account avatar masked';
const page = S.app.page;
/** Black out each staff name as a word inside its text, leaving the rest of the line readable. */
S.wordMask = (p) => p.evaluate((list) => {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = list.length ? new RegExp(list.map(s => `(?<![\\p{L}\\p{N}])${esc(s)}(?![\\p{L}\\p{N}])`).join('|'), 'giu') : null;
  if (!re) return 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const hits = [];
  while (w.nextNode()) { re.lastIndex = 0; if (re.test(w.currentNode.nodeValue || '')) hits.push(w.currentNode); }
  for (const t of hits) {
    const span = document.createElement('span');
    span.innerHTML = (t.nodeValue || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(re, m => `<span style="background:#18181b;color:#18181b;border-radius:2px">${'█'.repeat(m.length)}</span>`);
    t.parentNode.replaceChild(span, t);
  }
  return hits.length;
}, S.needles());
await page.goto(S.APP + '/activity-logbook', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByTestId('text-activity-logbook-title').waitFor({ timeout: 60000 });
await page.getByTestId('input-search-activity').fill('ZZ TEST 907');
await page.waitForTimeout(3500);
const rows = await page.locator('[data-testid^="activity-log-"]').count();
const masked = await S.wordMask(page);
const saved = S.shot;
S.inPlace = p => [p.locator('[data-testid^="activity-log-"]').filter({ hasNotText: 'ZZ TEST' })];
const avatar = page.locator('header button, header [class*="avatar"], header span').filter({ hasText: /^[A-Z]{1,3}$/ });
await S.shot(page, '06e-oto-app-activity-logbook.png', [avatar]);
S.inPlace = p => [];
return { rows, masked };
