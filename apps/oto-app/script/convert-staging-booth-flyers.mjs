// Run after the new HR and API builds reach staging, using a signed-in payroll manager's session.
const origin = 'https://oto-app-staging.onrender.com';
const cookie = process.env.OTO_STAGING_PAYROLL_COOKIE;
if (!cookie) throw new Error('Set OTO_STAGING_PAYROLL_COOKIE for the staging payroll manager.');
const reason =
  'Owner decision, 28 November 2026: each person printed on a redeemed booth voucher receives the full issue-day rate from the booth and till records.';
const apply = process.argv.includes('--apply');
const prefix = '/api/payroll/setup/rewards/';
const call = async (path, body) => {
  const response = await fetch(origin + prefix + path, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(
      'Staging payroll refused the operation with HTTP ' +
        response.status +
        '. No response containing staff data was logged.',
    );
  return response.json();
};
const isFlyer = (p) =>
  p?.type === 'bonus' &&
  p.bonus?.basis === 'baht-per-unit' &&
  /\b(flyers?|leaflets?)\b/i.test(p.quote) &&
  /return|redeem/i.test(p.quote);
const eligible = (person) => {
  const row = person.decided;
  if (row?.status !== 'approved' || row.clauseHash !== person.clauseHash) return false;
  return row.rules.some((ref) => isFlyer(row.reading.parts[ref.part]));
};
const list = await call('clauses');
if (!list.canManage) throw new Error('A staging payroll manager session is required.');
const candidates = list.people.filter(eligible);
let converted = 0,
  held = 0;
for (const person of candidates) {
  if (!apply) continue;
  // Reread before each correction. A worker may have an unfinished correction unrelated to this conversion.
  const live = (await call('clauses')).people.find((p) => p.employeeId === person.employeeId);
  if (!live || !eligible(live) || live.decided.id !== person.decided.id) {
    held++;
    continue;
  }
  let waiting = live.current?.status === 'pending' ? live.current : null;
  if (waiting && (waiting.reason !== reason || waiting.clauseHash !== live.clauseHash)) {
    held++;
    continue;
  }
  if (!waiting)
    waiting = await call('clauses/' + encodeURIComponent(live.employeeId) + '/correct', {
      reading: live.decided.reading,
      reason,
    });
  await call('clause-readings/' + encodeURIComponent(waiting.id) + '/approve', {
    from: live.decided.effectiveFrom.slice(0, 7),
    until: live.decided.effectiveTo,
    reason,
  });
  const updated = (await call('clauses')).people.find((p) => p.employeeId === live.employeeId);
  if (!updated || updated.decided?.id !== waiting.id || eligible(updated))
    throw new Error('The converted reading did not pass readback.');
  converted++;
}
console.log(
  JSON.stringify({
    mode: apply ? 'apply' : 'preview',
    eligible: candidates.length,
    converted,
    held,
  }),
);
