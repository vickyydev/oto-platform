import type { InboxMe } from '@/api/inbox';

/** The selected test inbox can be empty; a test chat can also be opened under All. */
export function fastInboxRefresh(
  me: Pick<InboxMe, 'simulator' | 'testLines'>,
  simulatorPane: boolean,
  sourceId: string,
  selectedChannelId: string | null | undefined,
): boolean {
  return Boolean((me.simulator && simulatorPane) || me.testLines?.some((line) => line.id === sourceId || line.id === selectedChannelId));
}

/** One fast timer shared by the simulator and live sandbox, stopped when its view changes. */
export function startFastInboxRefresh(enabled: boolean, visible: () => boolean, refresh: () => void): (() => void) | undefined {
  if (!enabled) return;
  const timer = setInterval(() => {
    if (visible()) refresh();
  }, 3000);
  return () => clearInterval(timer);
}
