// Cross-route handoff for the drop-off "Check in" action. The Drop-Off board
// stashes a registrationId here and navigates to the till (/), which consumes it
// once on mount to preload that registration's children as drop-off lines.
// Module-memory only — no storage, cleared after one read (mirrors correctedOrder).

let pending: string | null = null;

export const setDropOffHandoff = (registrationId: string): void => {
  pending = registrationId;
};

// Returns the pending registrationId (if any) and clears it so it's consumed once.
export const takeDropOffHandoff = (): string | null => {
  const current = pending;
  pending = null;
  return current;
};
