import { useState } from 'react';
import { VOUCHER_CREDIT_MESSAGES } from '@oto/shared';
import type { CreditApproval } from '@/api/vouchers';

/**
 * SCRUM-482 — A MANAGER APPROVING A CREDIT VOUCHER ON THIS TILL, ON THE SPOT.
 *
 * The receptionist stays signed in; the manager types their own phone number
 * and password into "Needs a manager", and the till sends them with the issue
 * (`vouchersApi.issue`). Nobody is signed in or out. The platform checks them
 * as a sign-in is (`apps/api/src/services/voucher-credit-approval.ts`).
 *
 * THE PASSWORD IS HELD ONLY WHILE IT IS TYPED. It goes into that one request
 * and its field is emptied as soon as the platform answers, whatever it said:
 * a refused approval keeps the dialog open with the phone, for the manager to
 * type the password again; anything else closes it and forgets both. Nothing
 * here writes to storage, and nothing else in the till ever reads it.
 */

/** The platform's refusals of the approval itself: the dialog stays open on these. */
export const APPROVAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'VOUCHER_APPROVAL_INCORRECT',
  'VOUCHER_APPROVER_IS_ASKER',
  'VOUCHER_APPROVER_NOT_MANAGER',
  'VOUCHER_APPROVER_MUST_CHANGE_PASSWORD',
  'TOO_MANY_REQUESTS',
  // A phone too short for the platform's form: said as a wrong phone, plainly.
  'VALIDATION',
]);

export type ApprovalOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; approvalRefused: boolean };

export interface ManagerApproval {
  phone: string;
  password: string;
  busy: boolean;
  /** The platform's refusal of the approval, in its words; null otherwise. */
  error: string | null;
  setPhone: (phone: string) => void;
  setPassword: (password: string) => void;
  /** Send the approval with `send`; the password is cleared once it answers. */
  submit: <T>(send: (approval: CreditApproval) => Promise<T>) => Promise<ApprovalOutcome<T> | null>;
  /** Forget everything typed: Back, closing the dialog, or after an answer. */
  reset: () => void;
}

export function useManagerApproval(): ManagerApproval {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setPhone('');
    setPassword('');
    setError(null);
    setBusy(false);
  };

  const submit = async <T,>(send: (approval: CreditApproval) => Promise<T>): Promise<ApprovalOutcome<T> | null> => {
    if (busy || !phone.trim() || !password) return null;
    setBusy(true);
    setError(null);
    try {
      const value = await send({ phone, password });
      reset();
      return { ok: true, value };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const approvalRefused = typeof code === 'string' && APPROVAL_REFUSAL_CODES.has(code);
      if (approvalRefused) {
        setPassword('');
        setBusy(false);
        setError(
          code === 'VALIDATION'
            ? VOUCHER_CREDIT_MESSAGES.approvalIncorrect
            : err instanceof Error
              ? err.message
              : VOUCHER_CREDIT_MESSAGES.approvalIncorrect,
        );
      } else {
        reset();
      }
      return { ok: false, error: err, approvalRefused };
    }
  };

  return { phone, password, busy, error, setPhone, setPassword, submit, reset };
}
