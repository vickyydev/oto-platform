import { KeyRound, Phone as PhoneIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/shared/PhoneInput';

/**
 * SCRUM-482 — "NEEDS A MANAGER": a credit voucher chosen at a till whose
 * person may not issue one alone. The manager types their own phone number
 * and password here and presses "Approve and print"; the till sends them with
 * the issue and the platform checks them. Nobody is signed out.
 *
 * Built like the till's other confirms (`CancelBookingDialog`): the dialog's
 * header, labelled fields, the footer's Back and its one action. The state —
 * and the rule that the password is forgotten once the platform answers —
 * lives in `useManagerApproval` (`lib/managerApproval.ts`).
 */

export const MANAGER_APPROVAL_TITLE = 'Needs a manager';
export const MANAGER_APPROVAL_ACTION = 'Approve and print';

/** What the dialog says it is for. */
export function managerApprovalLine(voucherName: string): string {
  return `${voucherName} is a credit voucher. A manager types their own phone number and password to approve it — nobody is signed out.`;
}

interface ManagerApprovalFieldsProps {
  phone: string;
  password: string;
  busy: boolean;
  error: string | null;
  onPhone: (phone: string) => void;
  onPassword: (password: string) => void;
  onApprove: () => void;
  onBack: () => void;
}

/** The fields, the refusal and the two buttons — its own component so they can be checked without a browser. */
export function ManagerApprovalFields({
  phone,
  password,
  busy,
  error,
  onPhone,
  onPassword,
  onApprove,
  onBack,
}: ManagerApprovalFieldsProps) {
  const ready = Boolean(phone.trim()) && Boolean(password) && !busy;
  return (
    <form
      className="space-y-3"
      data-testid="manager-approval"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onApprove();
      }}
    >
      <div className="space-y-1.5">
        <Label className="flex items-center gap-2">
          <PhoneIcon className="w-4 h-4" /> Manager’s phone number
        </Label>
        <PhoneInput value={phone} onChange={onPhone} label="" disabled={busy} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="manager-approval-password" className="flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> Manager’s password
        </Label>
        <Input
          id="manager-approval-password"
          type="password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          placeholder="••••••••"
          // A countersign, not this till's sign-in: nothing offers to save it or fill it in.
          autoComplete="off"
          disabled={busy}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="manager-approval-error">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={!ready}>
          {busy ? 'Approving…' : MANAGER_APPROVAL_ACTION}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ManagerApprovalDialog({
  open,
  voucherName,
  ...fields
}: ManagerApprovalFieldsProps & { open: boolean; voucherName: string }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !fields.busy) fields.onBack();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{MANAGER_APPROVAL_TITLE}</DialogTitle>
          <DialogDescription>{managerApprovalLine(voucherName)}</DialogDescription>
        </DialogHeader>
        <ManagerApprovalFields {...fields} />
      </DialogContent>
    </Dialog>
  );
}
