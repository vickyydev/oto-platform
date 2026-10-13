import { LogOut } from "lucide-react";

/** Ends Radar's own cookie; the launcher's session stays for the other apps. */
export function SignOutButton() {
  const signOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" }).catch(() => undefined);
    window.location.assign("/");
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
