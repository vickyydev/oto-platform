import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * SCRUM-539 — "Provision suite sign-in", shared by Setup > Users and an
 * advisor's Core Account tab. One press: the platform makes the person a
 * phone account and this dialog shows the temporary password ONCE (the
 * booth-PIN pattern). Nothing keeps it — not this page, not the app's server —
 * so it is written down now or reset at the launcher later.
 *
 * The action id is minted when the dialog opens and reused if the press is
 * retried, so a lost answer can never make a second account.
 */

interface ProvisionAnswer {
  phone: string;
  temporaryPassword: string | null;
  replayed: boolean;
}

function newActionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function SuiteSignInDialog({
  open,
  onOpenChange,
  personName,
  initialPhone,
  endpoint,
  onProvisioned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personName: string;
  initialPhone: string | null;
  /** `/api/users/:id/suite-sign-in` or `/api/people/:id/suite-sign-in`. */
  endpoint: string;
  onProvisioned: () => void;
}) {
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [actionId, setActionId] = useState(newActionId);
  const [answer, setAnswer] = useState<ProvisionAnswer | null>(null);

  useEffect(() => {
    if (open) {
      setPhone(initialPhone ?? "");
      setActionId(newActionId());
      setAnswer(null);
    }
  }, [open, initialPhone]);

  const provision = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", endpoint, { actionId, ...(phone.trim() ? { phone: phone.trim() } : {}) });
      return (await res.json()) as ProvisionAnswer;
    },
    onSuccess: (data) => {
      setAnswer(data);
      onProvisioned();
    },
  });

  const close = (next: boolean) => {
    if (!next) {
      // The password is gone with the dialog: nothing else holds it.
      setAnswer(null);
      provision.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Provision suite sign-in</DialogTitle>
          <DialogDescription>
            {personName} will sign in at the OTO launcher with their phone number, then open the OTO App from there.
          </DialogDescription>
        </DialogHeader>

        {answer ? (
          <div className="space-y-4 py-2" data-testid="suite-signin-result">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Phone (their sign-in)</p>
              <p className="font-mono font-medium" data-testid="text-suite-signin-phone">{answer.phone}</p>
            </div>
            {answer.temporaryPassword ? (
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Temporary password — shown once</p>
                <p className="font-mono text-2xl tracking-widest" data-testid="text-suite-signin-password">
                  {answer.temporaryPassword}
                </p>
                <p className="text-sm">
                  Write it down and give it to them now; it is not shown again. They change it at their first sign-in.
                </p>
              </div>
            ) : (
              <p className="text-sm" data-testid="text-suite-signin-replayed">
                This sign-in was already made by this same press, and its temporary password was shown then. If it was
                not written down, they can use "Forgot password" on the launcher.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="suite-signin-phone">Phone number *</Label>
              <Input
                id="suite-signin-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="081 234 5678"
                data-testid="input-suite-signin-phone"
              />
              <p className="text-xs text-muted-foreground">Thai numbers can be typed as 08x xxx xxxx.</p>
            </div>
            {provision.error && (
              <p className="text-sm text-destructive" data-testid="text-suite-signin-error">
                {(provision.error as Error).message}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {answer ? (
            <Button onClick={() => close(false)} data-testid="button-suite-signin-done">Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button
                onClick={() => provision.mutate()}
                disabled={provision.isPending || !phone.trim()}
                data-testid="button-suite-signin-provision"
              >
                {provision.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />}
                Provision
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where a password is changed or recovered when this app's own sign-in is
 * closed: the launcher, which owns it. Replaces every in-app password control.
 */
export function LauncherPasswordNote({ launcherUrl, className }: { launcherUrl: string | null; className?: string }) {
  return (
    <p className={className ?? "text-sm text-muted-foreground"} data-testid="text-launcher-password-note">
      Passwords are managed at the OTO launcher: change yours there, and anyone who forgot theirs uses "Forgot
      password" on the launcher's sign-in.
      {launcherUrl && (
        <>
          {" "}
          <a href={launcherUrl} className="underline" target="_blank" rel="noreferrer">
            Open the launcher
          </a>
        </>
      )}
    </p>
  );
}
