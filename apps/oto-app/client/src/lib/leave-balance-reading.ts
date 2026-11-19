// SCRUM-1037 — leave already taken reads as it did. Training and Other were
// switched off by the owner's answer (migration 0053); a switched-off type
// used to drop out of the employee editor's "days left" total and show "Not
// active" and "—" on the timekeeping card, so a person's Training days taken
// this year vanished from both. A type that is off but has days used in the
// year now reads exactly as it did while it was on; one with none still
// reads as off.

type Reading = { isActive: boolean; used: number };

/** Whether a type's figures read as an active type's: on, or switched off with days used in the year. */
export function readsAsActive(balance: Reading): boolean {
  return balance.isActive || balance.used !== 0;
}

/** The "N days left" total: the balance of every type that reads as active. */
export function daysLeftTotal(balances: Array<Reading & { balance: number }>): number {
  return balances.reduce((sum, item) => sum + (readsAsActive(item) ? item.balance : 0), 0);
}
