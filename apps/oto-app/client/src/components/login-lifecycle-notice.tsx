/**
 * SCRUM-852 — the one line an administrator sees in an employee's Access &
 * Login panel when the platform refused that login's switch-off (or a
 * leaver's move to pay only), with "Send again".
 *
 * The app shows the login off, or in pay only, the moment it is; the platform
 * is told through a queue. An outage never ends that: the queue keeps trying.
 * Only a refusal from the platform itself parks an event, and until someone
 * sends it again the person keeps their roles there. The words are
 * `shared/loginLifecycle.ts`; the read and the button are the two
 * `/api/admin/login-lifecycle` routes, both for administrators only, so only
 * an administrator ever sees this.
 */
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { parkedLifecycleNotices, type LoginLifecycleEventRead, type ParkedLifecycleNotice } from "@shared/loginLifecycle";

/** The read's cache key (the default fetcher joins a key into its address). */
export const loginLifecycleKey = (userId: string) => [`/api/admin/login-lifecycle?userId=${encodeURIComponent(userId)}`];

/** The parked events of this login, read afresh each time the panel's owner opens. Empty for anyone but an administrator. */
export function useParkedLoginLifecycle(userId: string | null | undefined, isAdmin: boolean): ParkedLifecycleNotice[] {
  const { data } = useQuery<{ events: LoginLifecycleEventRead[] }>({
    queryKey: loginLifecycleKey(userId ?? ""),
    enabled: isAdmin && !!userId,
    staleTime: 0,
  });
  return useMemo(() => parkedLifecycleNotices(data?.events ?? []), [data]);
}

/** The lines and their buttons, in the panel's own notice style. Nothing when nothing is parked. */
export function LoginLifecycleNoticeLines({ notices, sendingEventId, onSendAgain }: {
  notices: readonly ParkedLifecycleNotice[];
  sendingEventId: string | null;
  onSendAgain: (eventId: string) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((notice) => (
        <div key={notice.eventId} className="space-y-2 rounded-lg border p-3" data-testid={`login-lifecycle-parked-${notice.kind}`}>
          <p className="text-sm">{notice.line}</p>
          <Button
            variant="outline"
            onClick={() => onSendAgain(notice.eventId)}
            disabled={sendingEventId !== null}
            data-testid={`button-login-lifecycle-send-again-${notice.kind}`}
          >
            Send again
          </Button>
        </div>
      ))}
    </>
  );
}

/** The notice as the panel mounts it: the lines above, wired to the route. */
export function LoginLifecycleNotice({ userId, notices }: { userId: string; notices: readonly ParkedLifecycleNotice[] }) {
  const { toast } = useToast();
  const sendAgain = useMutation({
    mutationFn: async (eventId: string) => {
      const res = await apiRequest("POST", "/api/admin/login-lifecycle/send-again", { eventId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Sent again", description: "The platform is being told now. If it refuses again, this notice comes back." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not send again", description: error.message, variant: "destructive" });
    },
    // Either way the panel reads the queue again: a refusal means it moved on.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: loginLifecycleKey(userId) }); },
  });
  return (
    <LoginLifecycleNoticeLines
      notices={notices}
      sendingEventId={sendAgain.isPending ? sendAgain.variables ?? "" : null}
      onSendAgain={(eventId) => sendAgain.mutate(eventId)}
    />
  );
}
