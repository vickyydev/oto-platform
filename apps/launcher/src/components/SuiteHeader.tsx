import { Link } from 'wouter';
import { LogOut, Moon, Sun, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/BrandMark';
import { useSession, displayName } from '@/auth/SessionContext';
import { useTheme } from '@/lib/theme';
import { clearOpened } from '@/suite/handoff';

/**
 * The bar across every signed-in page. Same height, border and card wash as
 * the till's station header (apps/pos/src/components/shared/StationHeader.tsx)
 * so the two read as one product.
 */
export function SuiteHeader() {
  const { me, signOut } = useSession();
  const [theme, setTheme] = useTheme();
  const name = displayName(me);

  return (
    <header className="shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 h-16 border-b bg-card/30">
      <Link href="/" aria-label="OTO Suite home" className="flex items-center gap-3 min-w-0">
        <BrandMark />
        <span className="hidden sm:block text-sm font-semibold text-muted-foreground border-l pl-3">
          Suite
        </span>
      </Link>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>

        <Link
          href="/account"
          className="flex items-center gap-2 rounded-full border bg-card/60 pl-2 pr-3 h-9 hover-elevate active-elevate-2"
        >
          <span className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <UserRound className="w-3.5 h-3.5" />
          </span>
          <span className="text-sm font-bold leading-tight max-w-[8rem] truncate">{name}</span>
        </Link>

        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2"
          onClick={() => {
            clearOpened();
            void signOut();
          }}
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">Sign out</span>
        </Button>
      </div>
    </header>
  );
}
