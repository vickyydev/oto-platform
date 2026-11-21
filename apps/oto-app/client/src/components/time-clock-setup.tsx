import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { readTimeClockBranch, registerTimeClockTablet } from "@/lib/time-clock-tablet";

export function TimeClockSetup({ branch, onClose }: { branch: { id: string; name: string }; onClose: () => void }) {
  const { logoutMutation } = useAuth();
  const [registered, setRegistered] = useState(false);
  const [name, setName] = useState(`${branch.name} time clock`);
  const status = useQuery({
    queryKey: ["/api/public/branches", branch.id, "setup"],
    queryFn: () => readTimeClockBranch(branch.id),
    staleTime: 0,
  });
  const registration = useMutation({
    mutationFn: () => registerTimeClockTablet(branch.id, name.trim()),
    onSuccess: () => setRegistered(true),
  });
  const ready = registered || status.data?.tabletRegistered === true;
  return (
    <Dialog open onOpenChange={open => { if (!open && !registration.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ready ? "Time clock registered" : "Register this tablet"}</DialogTitle>
          <DialogDescription>{ready
            ? `Staff can use this browser to clock in and out at ${branch.name}.`
            : `Allow this browser to record staff attendance at ${branch.name}?`}</DialogDescription>
        </DialogHeader>
        {ready ? (
          <>
            <p>Open the time clock in a new tab and bookmark it. Return here to sign out of HR, then choose Sign out on the launcher before handing the tablet to staff.</p>
            <DialogFooter>
              <Button asChild variant="outline"><a href={`/kiosk/${branch.id}`} target="_blank" rel="noopener noreferrer">Open time clock</a></Button>
              <Button onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}>Sign out of HR</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <p>Use the park tablet that staff will share. Approval applies to this browser on this tablet.</p>
            <div className="space-y-2">
              <Label htmlFor="time-clock-name">Tablet name</Label>
              <Input id="time-clock-name" value={name} onChange={event => setName(event.target.value)} disabled={registration.isPending} />
            </div>
            {(registration.error || status.error) && <p role="alert">{(registration.error || status.error)?.message}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={registration.isPending}>Cancel</Button>
              <Button onClick={() => registration.mutate()} disabled={!name.trim() || status.isLoading || registration.isPending}>
                {registration.isPending ? "Registering…" : "Register this tablet"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
