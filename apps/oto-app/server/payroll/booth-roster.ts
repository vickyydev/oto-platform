import type { BoothRecord } from '@shared/booth-bonus';
export type RosterPerson = {
  id: string;
  name: string;
  nickname: string;
  accountId: string | null;
  start: Date | null;
  end: Date | null;
};
const iso = (date: Date) => date.toISOString().slice(0, 10);

export function namesOnSlip(fact: BoothRecord, people: RosterPerson[]) {
  const printed = (fact.staffLabel || '').split(/, | and /).filter(Boolean);
  const normalize = (s: string) => s.trim().normalize('NFC').toLowerCase();
  const known = new Set(people.map((p) => p.id));
  if (fact.employeeIds !== null) {
    const ids = [...new Set(fact.employeeIds)].filter((id) => known.has(id));
    return {
      ids,
      unmatched: Math.max(0, printed.length - ids.length, fact.accountIds.length - ids.length),
    };
  }
  const ids = new Set<string>();
  let unmatched = 0;
  const active = people.filter(
    (p) => (!p.start || iso(p.start) <= fact.issuedDay) && (!p.end || iso(p.end) >= fact.issuedDay),
  );
  for (const account of fact.accountIds) {
    const candidates = active.filter((p) => p.accountId === account);
    if (candidates.length === 1) ids.add(candidates[0].id);
    else unmatched++;
  }
  // Historical name-only rosters must have an unambiguous interpretation of each printed name.
  const allNames = new Set(
    active.flatMap((p) => [normalize(p.name), normalize(p.nickname)]).filter(Boolean),
  );
  const ambiguousLabel =
    printed.length > 1 &&
    [...allNames].some(
      (n) =>
        (n.includes(' and ') || n.includes(', ')) && normalize(fact.staffLabel || '').includes(n),
    );
  if (!ambiguousLabel)
    for (const value of printed) {
      const candidates = active.filter((p) =>
        [normalize(p.name), normalize(p.nickname)].includes(normalize(value)),
      );
      if (candidates.length === 1) ids.add(candidates[0].id);
      else unmatched++;
    }
  return {
    ids: [...ids],
    unmatched: ambiguousLabel ? Math.max(unmatched, printed.length) : unmatched,
  };
}
