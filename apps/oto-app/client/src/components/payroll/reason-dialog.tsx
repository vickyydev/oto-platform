import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorList, errorText } from "@/lib/payroll/api";

/**
 * Every payroll save asks why (the prototype's rule: each change lands on the
 * timeline with its reason). The dialog keeps our DialogBody recipe: only the
 * body scrolls, inside the capped card.
 */
export function ReasonDialog({ open, onOpenChange, title, description, confirmLabel = "Save", onConfirm, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: (reason: string) => Promise<unknown>;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (open) { setReason(""); setError(null); } }, [open]);

  async function confirm() {
    if (!reason.trim()) { setError(new Error("A reason is required.")); return; }
    setBusy(true); setError(null);
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <DialogBody className="space-y-4">
        {children}
        <div className="space-y-1.5">
          <Label htmlFor="payroll-reason">Reason for this change <span className="text-destructive">*</span></Label>
          <Input id="payroll-reason" value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }} placeholder="Why is this changing?" data-testid="input-payroll-reason" />
        </div>
        {error != null && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{errorText(error)}</p>
          {errorList(error).length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-6 text-xs">{errorList(error).map((item) => <li key={item}>{item}</li>)}</ul>}
        </div>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={() => void confirm()} data-testid="button-payroll-confirm">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
