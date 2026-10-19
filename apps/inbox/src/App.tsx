import { SessionProvider, useSession } from '@/auth/SessionContext';
import { BlockedPanel, LockedPanel, SignInPanel, Splash } from '@/components/SignOnPanels';
import { Workspace } from '@/components/Workspace';

function Shell() {
  const { state, me } = useSession();
  if (state === 'loading') return <Splash />;
  if (state === 'signed-out') return <SignInPanel />;
  if (state === 'locked') return <LockedPanel />;
  if (state === 'must-change-password' || state === 'no-access') return <BlockedPanel reason={state} />;
  if (!me) return <Splash />;
  // Keyed on the account: a different person signing in on this tab starts
  // from a clean workspace, never from the last one's open conversation.
  return <Workspace key={me.accountId} me={me} />;
}

export default function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
