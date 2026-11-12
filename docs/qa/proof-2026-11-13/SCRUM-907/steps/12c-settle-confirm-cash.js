S.phase = "12: Settle party (continued from the open form): read the rows, Confirm, cash";
const till = S.pages.rec.page;
await S.unlock('rec');
const r = {};
const dialog = till.getByRole('dialog').last();
r.formText = S.flat(await dialog.innerText().catch(() => '')).slice(0, 1500);
const previews = [];
// Confirm
const settled = till.waitForResponse(rr => /\/api\/parties\/[^/]+\/settle$/.test(new URL(rr.url()).pathname) && rr.request().method() === 'POST', { timeout: 60000 });
await till.getByRole('button', { name: /^Confirm/ }).click();
const sr = await settled;
const sb = await sr.json().catch(() => null);
S.settleSale = sb?.sale?.id ?? null;
if (S.settleSale) { S.receipt.created.push({ kind: 'party-settlement-sale', id: S.settleSale }); S.save(); }
r.settle = { status: sr.status(), code: sb?.error?.code ?? null, message: sb?.error?.message ?? null, state: sb?.settlement?.state ?? null, gross: (sb?.sale?.grossSatang ?? 0) / 100 };
if (sr.status() >= 400) { await S.shot(till, '12x-settle-refused.png'); S.receipt.reads.p12settle = r; return r; }
await till.getByTestId('payment-step').waitFor({ timeout: 30000 }); await till.waitForTimeout(2500);
r.amountDue = await till.evaluate(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === 'Amount Due'); return h ? (h.nextElementSibling?.textContent ?? '').trim() : null; });
S.seenReceipt = (await S.printouts('receipt')).map(S.keyOf);
await till.getByRole('heading', { name: 'Cash', exact: true }).first().click();
const confirm = till.getByRole('button', { name: 'Confirm Payment Received', exact: true });
await S.expect(confirm).toBeEnabled({ timeout: 20000 });
await confirm.scrollIntoViewIfNeeded();
await S.shot(till, '12c-settle-cash-chosen.png');
await confirm.click();
await till.getByText(/Settled|Payment Successful/).first().waitFor({ timeout: 60000 });
await till.waitForTimeout(3000);
r.done = S.flat(await till.getByRole('dialog').last().innerText().catch(() => '')).slice(0, 400);
await S.shot(till, '12d-settled-cash.png');
const sale = await S.sale(S.settleSale);
r.sale = { status: sale?.sale?.status ?? null, receipt: sale?.sale?.receiptNumber ?? null, gross: (sale?.sale?.totals?.grossSatang ?? sale?.sale?.grossSatang ?? 0) / 100,
  lines: (sale?.lines ?? sale?.sale?.lines ?? []).map(l => `${l.label ?? l.name} | ${l.quantity} x ${(l.unitSatang ?? 0) / 100} = ${(l.grossSatang ?? l.totalSatang ?? 0) / 100}`),
  payments: (sale?.payments ?? sale?.tenders ?? []).map(p => `${p.method} ${(p.amountSatang ?? 0) / 100} ${p.status ?? ''}`) };
// the receipt as the ZZ TEST receipt printer drew it
let rp = [];
const deadline = Date.now() + 60000;
while (Date.now() < deadline) { rp = (await S.printouts('receipt')).filter(p => !S.seenReceipt.includes(S.keyOf(p))); if (rp.length) break; await S.sleep(3000); }
r.receiptPrintouts = rp.map(p => ({ seq: p.seq, at: S.bkk(p.at), heightDots: p.heightDots }));
for (const [i, p] of [...rp].sort((a, b) => a.seq - b.seq).entries()) await S.keepPreview('receipt', p, `12e-receipt-printout-${i + 1}.png`);
r.party = (await S.party(S.p1)).body?.event?.party?.settlement ?? null;
S.receipt.reads.p12settle = r;
return r;
