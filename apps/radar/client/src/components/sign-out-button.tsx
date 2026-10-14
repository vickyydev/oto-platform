import { LogOut } from "lucide-react";
import { launcherUrlFrom } from "@/lib/launcher";

/**
 * Ends Radar's own cookie; the launcher's session stays for the other apps.
 * Then back to the launcher when the server names it (SCRUM-529), or to
 * Radar's own signed-out page when it does not (a laptop without one).
 */
export function SignOutButton() {
  const signOut = async () => {
    const body = await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" })
      .then((res) => res.json())
      .catch(() => null);
    window.location.assign(launcherUrlFrom(body) ?? "/");
  };
  return (
    <button
      onClick={() => void signOut()}
      className="relative flex items-center justify-center w-9 h-9 sm:w-8 sm:h-8 rounded-full transition-all duration-200 select-none shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/60"
      data-testid="button-sign-out"
      title="Sign out of Radar"
      aria-label="Sign out of Radar"
    >
      <LogOut className="h-4 w-4" />
    </button>
  );
}
