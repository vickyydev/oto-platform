S.phase = 'the kitchen slips of points 10 and 12 (the BEO removal of Calamari, the 1,300 extra), read after the clean-up if still held';
const r = {};
try {
  const n = await S.newPrintouts();
  r.kitchen = n.kitchen.map(p => ({ seq: p.seq, at: S.bkk(p.at), heightDots: p.heightDots }));
  for (const [i, p] of [...n.kitchen].sort((a, b) => a.seq - b.seq).entries()) await S.keepPreview('kitchen', p, `10c-kitchen-slip-after-beo-changes-${i + 1}.png`);
  S.markSeen(n.kitchen, n.bar);
} catch (e) { r.error = String(e?.message ?? e).slice(0, 200); }
return r;
