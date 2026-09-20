import { useEffect, type ReactElement } from 'react';
import { Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { Landing } from '@/pages/Landing';
import { Account } from '@/pages/Account';
import { ComingSoon } from '@/pages/ComingSoon';
import { Backdrop } from '@/components/Backdrop';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/BrandMark';
import { SessionProvider, useSession } from '@/auth/SessionContext';
import { useTheme } from '@/lib/theme';

function NotFound() {
  const [, navigate] = useLocation();
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4 px-6 text-center">
      <Backdrop />
      <BrandMark className="h-10" />
      <h1 className="text-2xl font-black tracking-tight">This page is not part of the suite</h1>
      <Button variant="outline" onClick={() => navigate('/')}>
        Back to the suite
      </Button>
    </div>
  );
}

/**
 * Everything but the landing page needs a session: these are pages you reach
 * from a tile, so arriving at one signed out means a link was opened cold.
 */
function RequireSession({ children }: { children: ReactElement }) {
  const { state } = useSession();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (state === 'signed-out') navigate('/', { replace: true });
  }, [state, navigate]);

  if (state !== 'signed-in') return null;
  return children;
}

function Routes() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/account">
        <RequireSession>
          <Account />
        </RequireSession>
      </Route>
      <Route path="/soon/:app">
        {(params) => (
          <RequireSession>
            <ComingSoon appKey={params.app ?? ''} />
          </RequireSession>
        )}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  // The theme drives the document root, so anything portaled to <body> follows
  // it — the same arrangement the POS uses.
  const [theme] = useTheme();
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('dark', theme === 'dark');
    el.classList.toggle('light', theme === 'light');
  }, [theme]);

  return (
    <SessionProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Routes />
      </WouterRouter>
    </SessionProvider>
  );
}
