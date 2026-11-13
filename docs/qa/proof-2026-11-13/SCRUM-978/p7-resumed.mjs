// Point 7 (and point 4's review dialog): a ZZ TEST thread booked and filled. S.arg1 =
//   "book|<K>"         Book Date opened on the thread and booked (the dialog's own read and "Book date")
//   "prepC"            thread C's event made "Different for adults" ON with an adults' own dish, through the app's
//                      routes, before its fill (the park's package and set menu; adults: ZZ TEST Caesar salad x2 at 150)
//   "create|<K>|<pic>" Create BEO pressed ONCE (its AI Fill reads the chat: counted), the review read, the Kitchen Plan
//                      section pictured; the console's dialog warnings counted while the review opened
//   "approve|<K>|<toastPic>"  Approve and create pressed once; the BEO read back (the editor's Adults tab pictured)
const [mode, key, pic] = String(S.arg1).split('|');
const imp = async (f) => (await import('file:///' + S.HERE + 'steps/' + f + '?r=' + Date.now())).default;
const out = { at: new Date().toISOString(), mode, key };
if (mode === 'book') {
  out.open = await (await imp('bd-open.mjs'))(S, `${key}|-`);
  out.book = await (await imp('bd-book.mjs'))(S, `${key}|-`);
  out.open = { fields: out.open.dialog?.fields, readWaitedMs: out.open.readWaitedMs };
  out.book = { save: out.book.save, note: out.book.note, chip: out.book.chip, buttons: out.book.buttons };
} else if (mode === 'prepD') {
  const id = S.st.events.D.id;
  const snap = await S.appCall('POST', `/beo/events/${id}/package-snapshot`, { templateId: '391b269d-159a-4039-89a2-51ac132da747' });
  out.package = { status: snap.status, name: snap.body?.packageName ?? null };
  const kp0 = await S.kpRead(id);
  const salad = { id: 'zz978-adults-own', itemName: 'ZZ TEST Caesar salad', quantity: 2, notes: '', included: false, price: 150 };
  const r = await S.appCall('PUT', `/events/${id}/beo/kitchen-plan`, { setMenuEnabled: kp0.setMenuEnabled ?? true, setMenuTemplateId: kp0.setMenuTemplateId, menus: { ...(kp0.menus ?? {}), kids: kp0.menus?.kids ?? [], adults: [salad], adultsDiffer: true } });
  out.prep = { route: 'PUT /api/events/:id/beo/kitchen-plan', status: r.status, error: r.body?.error ?? null };
  const kp = await S.kpRead(id);
  out.before = { setMenuEnabled: kp.setMenuEnabled, adultsDiffer: kp.menus?.adultsDiffer, kids: (kp.menus?.kids ?? []).map((l) => `${l.source ?? 'extra'} ${l.itemName} x${l.quantity}`), adults: (kp.menus?.adults ?? []).map((l) => `${l.source ?? 'extra'} ${l.itemName} x${l.quantity} @${l.price}`) };
  // The prepared BEO as the editor shows it (the app session; closed after).
  const page = await S.ed.open('Dprep', id);
  out.picture = await S.ed.pic(page, 'Adults Menu', '07c2-resumed-before-fill-adults-own-menu-switch-on.png', 'Thread C\'s BEO before Create BEO: "Different for adults" already ON with an adults\' own dish (ZZ TEST Caesar salad 2 at 150), the park\'s package and set menu, no kids\' choice yet');
  await page.close(); delete S.ctxs.beoPages.Dprep;
} else if (mode === 'create') {
  const used = (S.st.fillPresses ?? []).length;
  if (used >= 3) throw new Error('three Create BEO already pressed: not pressing a fourth');
  const m0 = S.consoleMark();
  const rec = await (await imp('beo-open.mjs'))(S, `${key}|-`);
  out.fill = { status: rec.aiFill?.status, seconds: rec.aiFill?.seconds, error: rec.aiFill?.error ?? null, menuLines: rec.aiFill?.rawProposal?.menuLines ?? null, adultsFolded: rec.aiFill?.rawProposal?.adultsFolded ?? null, setMenu: rec.aiFill?.proposal?.setMenu ?? null, package: rec.aiFill?.proposal?.package ?? null };
  out.reviewOpen = !!rec.review;
  const popup = S.ctxs.beoPages[key].page;
  await popup.waitForTimeout(2000);
  const { dialogOf } = await import('file:///' + S.HERE + 'steps/reviewlib.mjs?r=' + Date.now());
  const dlg = dialogOf(popup);
  out.dialog = await dlg.evaluate((d) => {
    const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const lab = d.getAttribute('aria-labelledby'), des = d.getAttribute('aria-describedby');
    return { title: lab ? one(document.getElementById(lab)?.textContent) : null, ariaDescribedby: !!des, description: des ? one(document.getElementById(des)?.textContent) : null };
  }).catch((e) => ({ error: String(e.message).slice(0, 200) }));
  out.dialogWarningsSinceCreate = S.consoleTest(m0, (t) => /Missing .?Description.? or .?aria-describedby/i.test(t));
  out.consoleSinceCreate = S.consoleSummaryOf(m0);
  const kpr = await (await imp('kp-review.mjs'))(S, `${key}|${pic}|first-read`);
  out.kitchenPlan = kpr.kp;
  out.reviewText = { writes: rec.review?.writes ?? null, replaces: rec.review?.replaces ?? null, undecided: rec.review?.undecided ?? null, chatSays: (rec.review?.chatSays ?? []).map((c) => c.text) };
} else if (mode === 'approve') {
  out.approval = await (await imp('approve.mjs'))(S, `${key}|${pic}`);
  const id = S.st.events[key].id;
  const kp = await S.kpRead(id);
  out.after = { setMenuEnabled: kp.setMenuEnabled, adultsDiffer: kp.menus?.adultsDiffer, kids: (kp.menus?.kids ?? []).map((l) => `${l.source ?? 'extra'} ${l.itemName} x${l.quantity}${l.price ? ' @' + l.price : ''}${l.productCode ? ' [' + l.productCode + ']' : ''}`), adults: (kp.menus?.adults ?? []).map((l) => `${l.source ?? 'extra'} ${l.itemName} x${l.quantity}${l.price ? ' @' + l.price : ''}${l.productCode ? ' [' + l.productCode + ']' : ''}`) };
}
((S.st.p7 ??= []).push(S.scrubDeep(out))); S.save();
return S.scrubDeep(out);
