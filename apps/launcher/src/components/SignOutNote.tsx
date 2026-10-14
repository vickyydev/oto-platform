import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { hasSignOutMarker, withoutSignOutMarker } from '@/lib/signout-note';

/**
 * One orientation line for a person who left a single app: the suite
 * sign-in is still on. Shown only when the marker is present; the marker is
 * stripped from the address bar so a refresh does not repeat the note.
 */
export function SignOutNote() {
  const [shown, setShown] = useState(() => hasSignOutMarker(window.location.search));

  useEffect(() => {
    if (!hasSignOutMarker(window.location.search)) return;
    window.history.replaceState(window.history.state, '', withoutSignOutMarker(window.location.href));
  }, []);

  if (!shown) return null;
  return (
    <div
      role="status"
      data-testid="signout-note"
      className="mb-6 flex items-start gap-3 rounded-xl border bg-card px-4 py-3 text-sm text-foreground/70"
    >
      <p className="flex-1">
        You signed out of that app. You're still signed in to the suite - use Sign out (top right)
        to switch accounts.
      </p>
      <button
        type="button"
        onClick={() => setShown(false)}
        aria-label="Dismiss"
        className="shrink-0 text-foreground/40 hover:text-foreground"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
