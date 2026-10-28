import type { ConfigurationEntry } from '@/api/consoleConfiguration';
import type { MoneyCashDay, MoneySettlement } from '@/api/moneyOversight';

const ownerNames: Record<string, string> = { platform: 'Platform', pos: 'POS', oto_app: 'OTO App', radar: 'Radar', inbox: 'Inbox', booth: 'Booth' };
export const configurationOwnerName = (owner: string) => ownerNames[owner] ?? owner;

/** Refine the already-authorized reading; never manufacture another entry or destination. */
export function configurationGroups(entries: readonly ConfigurationEntry[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  const groups = new Map<string, ConfigurationEntry[]>();
  for (const entry of entries) {
    if (query && ![entry.label, entry.key, configurationOwnerName(entry.appOwner)].join(' ').toLocaleLowerCase().includes(query)) continue;
    const group = groups.get(entry.appOwner) ?? [];
    group.push(entry); groups.set(entry.appOwner, group);
  }
  return [...groups].map(([owner, rows]) => ({ owner, entries: rows }));
}

export function cashDaysForView<T extends MoneyCashDay>(days: readonly T[], attentionOnly: boolean): T[] {
  return days.filter(day => !attentionOnly || !day.available || day.verdict !== 'ok');
}

type SettlementDay = MoneySettlement['branches'][number]['days'][number];
export function settlementDaysForView<T extends SettlementDay>(days: readonly T[], attentionOnly: boolean): T[] {
  return days.filter(day => !attentionOnly || day.unmatchedLines.length > 0 || day.unmatchedAttempts.length > 0
    || day.gateway.state !== 'matched' || day.terminals.some(terminal => terminal.state !== 'matched'));
}
