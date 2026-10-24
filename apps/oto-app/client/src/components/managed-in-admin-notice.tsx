import { CONSOLE_URL } from "@/lib/other-apps";
import { Button } from "@/components/ui/button";

const DESTINATIONS = {
  accounts: "/people/accounts",
  roles: "/people/roles",
  operators: "/organisation/operators",
} as const;

export function ManagedInAdminNotice({ section, managed, checking, unavailable, onRetry }: {
  section: keyof typeof DESTINATIONS;
  managed: boolean;
  checking: boolean;
  unavailable: boolean;
  onRetry: () => void;
}) {
  if (!managed && !checking && !unavailable) return null;
  return (
    <div className="rounded-md border bg-muted/30 p-4 text-sm" role="status" data-testid="managed-in-admin-notice">
      {managed && <p><strong>Managed in Admin</strong>. <a className="underline" href={`${CONSOLE_URL.replace(/\/$/, "")}${DESTINATIONS[section]}`}>Open Admin</a> to manage these settings.</p>}
      {(checking || unavailable) && (
        <div className="flex items-center justify-between gap-3">
          <p>{checking ? "Checking management status…" : "Management status is unavailable. Write controls are hidden."}</p>
          <Button variant="outline" size="sm" disabled={checking} onClick={onRetry}>Retry</Button>
        </div>
      )}
    </div>
  );
}
